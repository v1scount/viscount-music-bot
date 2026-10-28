mod audio;
mod catalog;
mod pcm;

use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use librespot::core::authentication::Credentials;
use librespot::core::cache::Cache;
use librespot::core::config::SessionConfig;
use librespot::core::session::Session;
use librespot::core::spotify_uri::SpotifyUri;
use librespot::oauth::OAuthClientBuilder;
use librespot::playback::player::{Player, PlayerEvent};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tracing::{error, info};

use crate::audio::{event_json, EnginePlayer};
use crate::catalog::{radio, resolve, search, ResolveJson};
use crate::pcm::PcmHub;

struct App {
    session: RwLock<Session>,
    player: Arc<Player>,
    events: broadcast::Sender<String>,
    hub: PcmHub,
    config: SessionConfig,
    cache_dir: PathBuf,
    reconnecting: Mutex<()>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,librespot=info".into()),
        )
        .init();

    let cache_dir = PathBuf::from(
        std::env::var("SPOTIFY_CACHE").unwrap_or_else(|_| "/var/lib/spotify-cache".into()),
    );
    fs::create_dir_all(&cache_dir).context("create spotify cache")?;
    retire_legacy_audio_cache(&cache_dir);

    let mut session_config = SessionConfig::default();
    let device_path = cache_dir.join("device_id");
    if let Ok(saved) = fs::read_to_string(&device_path) {
        let saved = saved.trim();
        if !saved.is_empty() {
            session_config.device_id = saved.to_string();
        }
    } else {
        fs::write(&device_path, &session_config.device_id).context("write device id")?;
    }

    let session = login(session_config.clone(), &cache_dir).await?;
    info!("spotify session ready");

    let hub = PcmHub::new();
    let engine = EnginePlayer::new(session.clone(), hub.clone());
    let (events, _) = broadcast::channel(64);
    spawn_player_events(engine.player.clone(), events.clone(), hub.clone());

    let http_addr: SocketAddr = std::env::var("ENGINE_HTTP_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8090".into())
        .parse()
        .context("ENGINE_HTTP_ADDR")?;
    let pcm_addr: SocketAddr = std::env::var("ENGINE_PCM_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8091".into())
        .parse()
        .context("ENGINE_PCM_ADDR")?;

    let app = Arc::new(App {
        session: RwLock::new(session),
        player: engine.player,
        events,
        hub: hub.clone(),
        config: session_config,
        cache_dir,
        reconnecting: Mutex::new(()),
    });

    tokio::spawn(watch_session(app.clone()));
    tokio::spawn(serve_pcm(pcm_addr, hub));
    let router = Router::new()
        .route("/health", get(health))
        .route("/search", get(search_route))
        .route("/resolve", get(resolve_route))
        .route("/radio", get(radio_route))
        .route("/player/load", post(load_route))
        .route("/player/pause", post(pause_route))
        .route("/player/resume", post(resume_route))
        .route("/player/seek", post(seek_route))
        .route("/player/stop", post(stop_route))
        .route("/player/preload", post(preload_route))
        .route("/events", get(events_route))
        .with_state(app);

    let listener = TcpListener::bind(http_addr).await?;
    info!("spotify engine http {http_addr} pcm {pcm_addr}");
    axum::serve(listener, router).await?;
    Ok(())
}

const OAUTH_REDIRECT: &str = "http://127.0.0.1:8898/login";
const OAUTH_SCOPES: &[&str] = &[
    "app-remote-control",
    "playlist-read",
    "playlist-read-private",
    "playlist-read-collaborative",
    "streaming",
    "user-library-read",
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing",
    "user-read-private",
    "user-read-email",
    "user-read-recently-played",
    "user-top-read",
];

fn open_cache(cache_dir: &std::path::Path) -> Result<Cache> {
    let credentials = cache_dir.join("credentials");
    let volume = cache_dir.join("volume");
    let audio = cache_dir.join("audio");
    Ok(Cache::new(
        Some(credentials),
        Some(volume),
        Some(audio),
        Some(512 * 1024 * 1024),
    )?)
}

/// Older builds stored audio files next to credentials.json. The cache size
/// limit then deleted the login file, and a later play saved encrypted audio.
fn retire_legacy_audio_cache(cache_dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let legacy = name.len() == 2 && name.chars().all(|c| c.is_ascii_hexdigit());
        if legacy && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

async fn login(config: SessionConfig, cache_dir: &std::path::Path) -> Result<Session> {
    let saved = {
        let cache = open_cache(cache_dir)?;
        cache.credentials()
    };
    if let Some(saved) = saved {
        info!("trying saved Spotify session");
        match connect_session(config.clone(), cache_dir, saved).await {
            Ok(session) => return Ok(session),
            Err(error) if is_bad_credentials(&error) => {
                info!("saved Spotify session was rejected");
            }
            Err(error) => return Err(error),
        }
    }

    let username = std::env::var("SPOTIFY_USERNAME").unwrap_or_default();
    let password = std::env::var("SPOTIFY_PASSWORD").unwrap_or_default();
    if !username.is_empty() && !password.is_empty() {
        info!(
            "trying Spotify password login for username len={} email={}",
            username.len(),
            username.contains('@')
        );
        match connect_session(
            config.clone(),
            cache_dir,
            Credentials::with_password(username, password),
        )
        .await
        {
            Ok(session) => return Ok(session),
            Err(error) if is_bad_credentials(&error) => {
                info!("Spotify rejected the username and password");
            }
            Err(error) => return Err(error),
        }
    }

    let refresh_path = cache_dir.join("credentials").join("oauth-refresh");
    if let Ok(refresh) = fs::read_to_string(&refresh_path) {
        let refresh = refresh.trim();
        if !refresh.is_empty() {
            info!("refreshing Spotify OAuth token");
            match oauth_client()?.refresh_token_async(refresh).await {
                Ok(token) => {
                    save_refresh(&refresh_path, &token.refresh_token)?;
                    return connect_session(
                        config,
                        cache_dir,
                        Credentials::with_access_token(token.access_token),
                    )
                    .await;
                }
                Err(error) => info!("OAuth refresh failed: {error}"),
            }
        }
    }

    info!("waiting for Spotify browser login on http://127.0.0.1:8898/login");
    let proxy = tokio::spawn(proxy_oauth_callback());
    let client_id = config.client_id.clone();
    let token = tokio::task::spawn_blocking(move || interactive_oauth(&client_id))
        .await
        .context("oauth task")??;
    proxy.abort();
    save_refresh(&refresh_path, &token.refresh_token)?;
    connect_session(
        config,
        cache_dir,
        Credentials::with_access_token(token.access_token),
    )
    .await
}

async fn connect_session(
    config: SessionConfig,
    cache_dir: &std::path::Path,
    credentials: Credentials,
) -> Result<Session> {
    let cache = open_cache(cache_dir)?;
    let session = Session::new(config, Some(cache));
    session
        .connect(credentials, true)
        .await
        .context("spotify login")?;
    Ok(session)
}

fn oauth_client() -> Result<librespot::oauth::OAuthClient> {
    let client_id = SessionConfig::default().client_id;
    OAuthClientBuilder::new(&client_id, OAUTH_REDIRECT, OAUTH_SCOPES.to_vec())
        .with_custom_message("Spotify login complete. You can close this tab.")
        .build()
        .context("oauth client")
}

fn interactive_oauth(client_id: &str) -> Result<librespot::oauth::OAuthToken> {
    let client = OAuthClientBuilder::new(client_id, OAUTH_REDIRECT, OAUTH_SCOPES.to_vec())
        .with_custom_message("Spotify login complete. You can close this tab.")
        .build()
        .context("oauth client")?;
    info!("open the Spotify URL printed below in a browser on this machine");
    client.get_access_token().context("spotify oauth")
}

fn save_refresh(path: &std::path::Path, refresh: &str) -> Result<()> {
    if refresh.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, refresh).context("write oauth refresh")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn is_bad_credentials(error: &anyhow::Error) -> bool {
    format!("{error:#}").contains("Bad credentials")
}

/// Docker publishes this port onto the host. librespot's callback listens on
/// 127.0.0.1 inside the container, so proxy the published port to it.
async fn proxy_oauth_callback() {
    // 8898 inside the container is reserved for librespot's 127.0.0.1 callback.
    let listener = match TcpListener::bind("0.0.0.0:8899").await {
        Ok(listener) => listener,
        Err(error) => {
            error!("oauth proxy bind failed: {error}");
            return;
        }
    };
    loop {
        let Ok((mut inbound, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            let Ok(mut outbound) = tokio::net::TcpStream::connect("127.0.0.1:8898").await else {
                return;
            };
            let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
        });
    }
}

fn spawn_player_events(
    player: Arc<Player>,
    events: broadcast::Sender<String>,
    hub: PcmHub,
) {
    let mut channel = player.get_player_event_channel();
    tokio::spawn(async move {
        while let Some(event) = channel.recv().await {
            // The decoder is ahead of Discord by the lead buffer. Wait that
            // out before telling the bot the track ended, or the tail is cut.
            if matches!(event, PlayerEvent::EndOfTrack { .. }) {
                let hub = hub.clone();
                let _ = tokio::task::spawn_blocking(move || hub.finish_track()).await;
            }
            if let Some(json) = event_json(&event) {
                let _ = events.send(json);
            }
        }
    });
}

async fn serve_pcm(addr: SocketAddr, hub: PcmHub) {
    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            error!("pcm bind failed: {error}");
            return;
        }
    };
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            continue;
        };
        crate::pcm::spawn_subscriber(socket, hub.clone());
    }
}

async fn watch_session(app: Arc<App>) {
    loop {
        tokio::time::sleep(Duration::from_secs(20)).await;
        if app.session.read().await.is_invalid() {
            if let Err(error) = ensure_session(&app).await {
                error!("spotify reconnect failed: {error:#}");
            }
        }
    }
}

/// Spotify drops the access-point connection after a while. A dead session
/// still accepts play requests, then fails to fetch the audio key and the
/// encrypted file is decoded as junk.
async fn ensure_session(app: &App) -> Result<()> {
    if !app.session.read().await.is_invalid() {
        return Ok(());
    }

    let _guard = app.reconnecting.lock().await;
    if !app.session.read().await.is_invalid() {
        return Ok(());
    }

    info!("spotify session dropped, reconnecting");
    let session = connect_saved(app.config.clone(), &app.cache_dir).await?;
    app.player.set_session(session.clone());
    *app.session.write().await = session;
    info!("spotify session restored");
    Ok(())
}

async fn connect_saved(config: SessionConfig, cache_dir: &std::path::Path) -> Result<Session> {
    let saved = {
        let cache = open_cache(cache_dir)?;
        cache.credentials()
    };
    let Some(saved) = saved else {
        return Err(anyhow!("no saved spotify session to restore"));
    };
    connect_session(config, cache_dir, saved).await
}

async fn health(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let connected = !app.session.read().await.is_invalid();
    Json(serde_json::json!({ "ok": connected }))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search_route(
    State(app): State<Arc<App>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<ResolveJson>, ApiError> {
    ensure_session(&app).await?;
    let session = app.session.read().await.clone();
    Ok(Json(search(&session, &query.q).await?))
}

#[derive(Deserialize)]
struct UriQuery {
    uri: String,
}

async fn resolve_route(
    State(app): State<Arc<App>>,
    Query(query): Query<UriQuery>,
) -> Result<Json<ResolveJson>, ApiError> {
    ensure_session(&app).await?;
    let session = app.session.read().await.clone();
    Ok(Json(resolve(&session, &query.uri).await?))
}

async fn radio_route(
    State(app): State<Arc<App>>,
    Query(query): Query<UriQuery>,
) -> Result<Json<ResolveJson>, ApiError> {
    ensure_session(&app).await?;
    let session = app.session.read().await.clone();
    Ok(Json(radio(&session, &query.uri).await?))
}

#[derive(Deserialize)]
struct LoadBody {
    uri: String,
    #[serde(default, alias = "positionMs")]
    position_ms: u32,
}

async fn load_route(
    State(app): State<Arc<App>>,
    Json(body): Json<LoadBody>,
) -> Result<StatusCode, ApiError> {
    ensure_session(&app).await?;
    let uri = SpotifyUri::from_uri(&body.uri).map_err(|_| anyhow!("invalid track uri"))?;
    app.hub.begin_segment();
    app.player.load(uri, true, body.position_ms);
    Ok(StatusCode::NO_CONTENT)
}

async fn pause_route(State(app): State<Arc<App>>) -> StatusCode {
    app.player.pause();
    StatusCode::NO_CONTENT
}

async fn resume_route(State(app): State<Arc<App>>) -> StatusCode {
    app.player.play();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct SeekBody {
    #[serde(alias = "positionMs")]
    position_ms: u32,
}

async fn seek_route(State(app): State<Arc<App>>, Json(body): Json<SeekBody>) -> StatusCode {
    app.hub.begin_segment();
    app.player.seek(body.position_ms);
    StatusCode::NO_CONTENT
}

async fn stop_route(State(app): State<Arc<App>>) -> StatusCode {
    app.hub.begin_segment();
    app.player.stop();
    StatusCode::NO_CONTENT
}

async fn preload_route(
    State(app): State<Arc<App>>,
    Json(body): Json<UriQuery>,
) -> Result<StatusCode, ApiError> {
    ensure_session(&app).await?;
    let uri = SpotifyUri::from_uri(&body.uri).map_err(|_| anyhow!("invalid track uri"))?;
    app.player.preload(uri);
    Ok(StatusCode::NO_CONTENT)
}

async fn events_route(
    State(app): State<Arc<App>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = app.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| {
        item.ok()
            .map(|data| Ok(Event::default().event("message").data(data)))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

struct ApiError(anyhow::Error);

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let message = self.0.to_string();
        error!("api: {message}");
        (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response()
    }
}
