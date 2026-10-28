use anyhow::{anyhow, Context as _, Result};
use futures_util::future::join_all;
use librespot::core::Session;
use librespot::core::spotify_uri::SpotifyUri;
use librespot::metadata::{Metadata, Track};
use librespot::protocol::autoplay_context_request::AutoplayContextRequest;
use librespot::protocol::context::Context;
use serde::Serialize;
use serde_json::Value;

pub const PLAYLIST_LIMIT: usize = 100;
const SEARCH_LIMIT: usize = 10;
const RADIO_LIMIT: usize = 25;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackJson {
    pub uri: String,
    pub identifier: String,
    pub title: String,
    pub author: String,
    pub length: u32,
    pub artwork_url: Option<String>,
    pub isrc: Option<String>,
    pub is_seekable: bool,
    pub is_stream: bool,
    pub source_name: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveJson {
    pub load_type: &'static str,
    pub playlist_name: Option<String>,
    pub tracks: Vec<TrackJson>,
}

pub fn normalize_input(input: &str) -> Result<SpotifyUri> {
    let trimmed = input.trim();
    if let Ok(uri) = SpotifyUri::from_uri(trimmed) {
        return Ok(uri);
    }

    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| anyhow!("not a spotify uri"))?;
    let (host, path) = rest
        .split_once('/')
        .ok_or_else(|| anyhow!("not a spotify uri"))?;
    if host != "open.spotify.com" {
        return Err(anyhow!("not a spotify uri"));
    }
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let mut kind = parts.next().unwrap_or("");
    if kind.starts_with("intl-") {
        kind = parts.next().unwrap_or("");
    }
    let id = parts
        .next()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("");
    if !matches!(kind, "track" | "album" | "playlist") || id.is_empty() {
        return Err(anyhow!("unsupported spotify link"));
    }
    SpotifyUri::from_uri(&format!("spotify:{kind}:{id}")).context("invalid spotify id")
}

pub async fn search(session: &Session, query: &str) -> Result<ResolveJson> {
    let q = query.split_whitespace().collect::<Vec<_>>().join("+");
    if q.is_empty() {
        return Ok(empty("empty"));
    }
    let ctx = session
        .spclient()
        .get_context(&format!("spotify:search:{q}"))
        .await
        .context("search")?;
    let uris = track_uris(&ctx);
    let tracks = hydrate_all(session, &uris, SEARCH_LIMIT).await;
    if tracks.is_empty() {
        return Ok(empty("empty"));
    }
    Ok(ResolveJson {
        load_type: "search",
        playlist_name: None,
        tracks,
    })
}

pub async fn resolve(session: &Session, input: &str) -> Result<ResolveJson> {
    let uri = normalize_input(input)?;
    match &uri {
        SpotifyUri::Track { .. } => {
            let tracks = hydrate_all(session, &[uri.to_uri()?], 1).await;
            if tracks.is_empty() {
                return Ok(empty("empty"));
            }
            Ok(ResolveJson {
                load_type: "track",
                playlist_name: None,
                tracks,
            })
        }
        SpotifyUri::Album { .. } | SpotifyUri::Playlist { .. } => {
            let spotify_uri = uri.to_uri()?;
            let ctx = session
                .spclient()
                .get_context(&spotify_uri)
                .await
                .context("resolve context")?;
            let name = context_name(&ctx);
            let uris = track_uris(&ctx);
            let tracks = hydrate_all(session, &uris, PLAYLIST_LIMIT).await;
            if tracks.is_empty() {
                return Ok(empty("empty"));
            }
            Ok(ResolveJson {
                load_type: "playlist",
                playlist_name: name,
                tracks,
            })
        }
        _ => Err(anyhow!("only Spotify tracks, albums, and playlists can be played")),
    }
}

pub async fn radio(session: &Session, input: &str) -> Result<ResolveJson> {
    let seed = normalize_input(input)?;
    let SpotifyUri::Track { .. } = &seed else {
        return Err(anyhow!("radio needs a track uri"));
    };
    let seed_uri = seed.to_uri()?;
    let mut uris = radio_uris(session, &seed).await.unwrap_or_default();
    if uris.is_empty() {
        let request = AutoplayContextRequest {
            context_uri: Some(seed_uri.clone()),
            recent_track_uri: vec![seed_uri.clone()],
            ..Default::default()
        };
        if let Ok(ctx) = session.spclient().get_autoplay_context(&request).await {
            uris = track_uris(&ctx);
        }
    }
    uris.retain(|uri| uri != &seed_uri);
    uris.dedup();
    let tracks = hydrate_all(session, &uris, RADIO_LIMIT).await;
    if tracks.is_empty() {
        return Ok(empty("empty"));
    }
    Ok(ResolveJson {
        load_type: "search",
        playlist_name: None,
        tracks,
    })
}

async fn radio_uris(session: &Session, seed: &SpotifyUri) -> Result<Vec<String>> {
    let bytes = session
        .spclient()
        .get_radio_for_track(seed)
        .await
        .context("radio")?;
    let value: Value = serde_json::from_slice(&bytes).context("radio json")?;
    let mut found = Vec::new();
    collect_uris(&value, &mut found);
    let mut tracks = Vec::new();
    let mut containers = Vec::new();
    for uri in found {
        if uri.starts_with("spotify:track:") {
            tracks.push(uri);
        } else if uri.starts_with("spotify:playlist:") || uri.starts_with("spotify:album:") {
            containers.push(uri);
        }
    }
    if tracks.is_empty() {
        if let Some(container) = containers.first() {
            if let Ok(ctx) = session.spclient().get_context(container).await {
                tracks = track_uris(&ctx);
            }
        }
    }
    Ok(tracks)
}

fn collect_uris(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if text.starts_with("spotify:") => out.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                collect_uris(item, out);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_uris(item, out);
            }
        }
        _ => {}
    }
}

fn track_uris(ctx: &Context) -> Vec<String> {
    let mut uris = Vec::new();
    for page in &ctx.pages {
        for track in &page.tracks {
            let Some(uri) = track.uri.as_deref() else {
                continue;
            };
            if uri.starts_with("spotify:track:") {
                uris.push(uri.to_string());
            }
        }
    }
    uris
}

fn context_name(ctx: &Context) -> Option<String> {
    for key in ["context_description", "name", "title", "playlist_name"] {
        if let Some(value) = ctx.metadata.get(key) {
            if !value.is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}

async fn hydrate_all(session: &Session, uris: &[String], limit: usize) -> Vec<TrackJson> {
    let parsed: Vec<SpotifyUri> = uris
        .iter()
        .take(limit)
        .filter_map(|uri| SpotifyUri::from_uri(uri).ok())
        .collect();
    let hydrated = join_all(parsed.into_iter().map(|uri| {
        let session = session.clone();
        async move { hydrate(&session, &uri).await.ok() }
    }))
    .await;
    hydrated.into_iter().flatten().collect()
}

async fn hydrate(session: &Session, uri: &SpotifyUri) -> Result<TrackJson> {
    let track = Track::get(session, uri).await.context("track metadata")?;
    let identifier = match uri {
        SpotifyUri::Track { id } => id.to_base62().unwrap_or_default(),
        _ => String::new(),
    };
    let author = artist_line(&track);
    let artwork_url = artwork(&track);
    let isrc = track
        .external_ids
        .iter()
        .find(|id| id.external_type.eq_ignore_ascii_case("isrc"))
        .map(|id| id.id.clone());
    let length = u32::try_from(track.duration.max(0)).unwrap_or(0);
    Ok(TrackJson {
        uri: uri.to_uri()?,
        identifier,
        title: if track.name.is_empty() {
            "Unknown".into()
        } else {
            track.name
        },
        author,
        length,
        artwork_url,
        isrc,
        is_seekable: true,
        is_stream: false,
        source_name: "spotify",
    })
}

fn artist_line(track: &Track) -> String {
    let names: Vec<&str> = track
        .artists
        .iter()
        .map(|artist| artist.name.as_str())
        .filter(|name| !name.is_empty())
        .collect();
    if names.is_empty() {
        "Unknown".into()
    } else {
        names.join(", ")
    }
}

fn artwork(track: &Track) -> Option<String> {
    let images = if track.album.covers.is_empty() {
        &track.album.cover_group
    } else {
        &track.album.covers
    };
    let image = images
        .iter()
        .max_by_key(|image| image.width.max(image.height))?;
    let hex = image.id.to_base16().ok()?;
    Some(format!("https://i.scdn.co/image/{hex}"))
}

fn empty(load_type: &'static str) -> ResolveJson {
    ResolveJson {
        load_type,
        playlist_name: None,
        tracks: Vec::new(),
    }
}
