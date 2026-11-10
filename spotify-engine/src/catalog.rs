use anyhow::{anyhow, Context as _, Result};
use futures_util::future::join_all;
use librespot::core::spotify_id::SpotifyId;
use librespot::core::spotify_uri::SpotifyUri;
use librespot::core::Session;
use librespot::metadata::{Artist, Metadata, Track};
use librespot::protocol::autoplay_context_request::AutoplayContextRequest;
use librespot::protocol::context::Context;
use serde::Serialize;
use serde_json::Value;

pub const PLAYLIST_LIMIT: usize = 100;
const SEARCH_LIMIT: usize = 10;
const RADIO_LIMIT: usize = 25;
const PREVIOUS_LIMIT: usize = 5;
const APOLLO_COUNT: usize = 10;
const ARTIST_COOLDOWN: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackJson {
    pub uri: String,
    pub identifier: String,
    pub title: String,
    pub author: String,
    pub artist_id: Option<String>,
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

pub async fn radio(
    session: &Session,
    input: &str,
    previous: &[String],
    recent_artists: &[String],
    step: usize,
) -> Result<ResolveJson> {
    let seed = normalize_input(input)?;
    let SpotifyUri::Track { .. } = &seed else {
        return Err(anyhow!("radio needs a track uri"));
    };
    let seed_uri = seed.to_uri()?;

    let picked = rotate_artist(session, &seed, &seed_uri, previous, recent_artists, step).await;
    let cooled = match &picked {
        Ok(found) => found.cooled.clone(),
        Err(_) => cooldown_window(recent_artists, ""),
    };
    let mut tracks = Vec::new();
    if let Ok(found) = picked {
        if !found.uris.is_empty() {
            tracks = hydrate_all(session, &found.uris, RADIO_LIMIT).await;
            tracks.retain(|track| !is_played_uri(&track.uri, &seed_uri, previous));
        }
    }
    if tracks.is_empty() {
        let previous_uris = previous_track_uris(previous, &seed_uri);
        let mut uris = station_uris(session, &seed, &seed_uri, &previous_uris).await;
        uris.dedup();
        tracks = hydrate_all(session, &uris, RADIO_LIMIT).await;
        tracks.retain(|track| !is_played_uri(&track.uri, &seed_uri, previous));
        tracks = drop_cooled_artists(tracks, &cooled);
    }
    if tracks.is_empty() {
        return Ok(empty("empty"));
    }
    Ok(ResolveJson {
        load_type: "search",
        playlist_name: None,
        tracks,
    })
}

struct RotationPick {
    uris: Vec<String>,
    cooled: Vec<String>,
}

struct PoolEntry {
    key: String,
    uri: SpotifyUri,
}

async fn rotate_artist(
    session: &Session,
    seed: &SpotifyUri,
    seed_uri: &str,
    previous: &[String],
    recent_artists: &[String],
    step: usize,
) -> Result<RotationPick> {
    let track = Track::get(session, seed).await.context("seed track")?;
    let anchor_uri = track
        .artists
        .first()
        .context("seed artist")?
        .id
        .clone();
    let anchor = Artist::get(session, &anchor_uri).await.context("artist")?;
    let anchor_id = artist_key(&anchor.id).unwrap_or_default();
    let cooled = cooldown_window(recent_artists, &anchor_id);

    let mut pool = Vec::new();
    push_artist(&mut pool, &anchor.id);
    for related in anchor.related.iter() {
        push_artist(&mut pool, &related.id);
    }

    let keys: Vec<String> = pool.iter().map(|entry| entry.key.clone()).collect();
    let uris = pick_fresh_uris(
        session,
        &anchor,
        &pool,
        &keys,
        &cooled,
        previous,
        seed_uri,
        step,
    )
    .await;
    Ok(RotationPick { uris, cooled })
}

fn push_artist(pool: &mut Vec<PoolEntry>, uri: &SpotifyUri) {
    let Some(key) = artist_key(uri) else {
        return;
    };
    if pool.iter().any(|entry| entry.key == key) {
        return;
    }
    pool.push(PoolEntry {
        key,
        uri: uri.clone(),
    });
}

async fn pick_fresh_uris(
    session: &Session,
    anchor: &Artist,
    pool: &[PoolEntry],
    keys: &[String],
    cooled: &[String],
    previous: &[String],
    seed_uri: &str,
    step: usize,
) -> Vec<String> {
    let order = strided_order(step, pool.len());
    if let Some(uris) = first_fresh_artist(
        session,
        anchor,
        pool,
        keys,
        &order,
        previous,
        seed_uri,
        |key| cooled_contains(cooled, key),
    )
    .await
    {
        return uris;
    }
    let last = cooled.last().map(String::as_str);
    first_fresh_artist(
        session,
        anchor,
        pool,
        keys,
        &order,
        previous,
        seed_uri,
        |key| last == Some(key),
    )
    .await
    .unwrap_or_default()
}

async fn first_fresh_artist(
    session: &Session,
    anchor: &Artist,
    pool: &[PoolEntry],
    keys: &[String],
    order: &[usize],
    previous: &[String],
    seed_uri: &str,
    skip: impl Fn(&str) -> bool,
) -> Option<Vec<String>> {
    for index in order {
        let Some(key) = keys.get(*index) else {
            continue;
        };
        if skip(key) {
            continue;
        }
        let uris = fresh_top_tracks(session, &pool[*index].uri, anchor, previous, seed_uri).await;
        if !uris.is_empty() {
            return Some(uris);
        }
    }
    None
}

async fn fresh_top_tracks(
    session: &Session,
    artist_uri: &SpotifyUri,
    anchor: &Artist,
    previous: &[String],
    seed_uri: &str,
) -> Vec<String> {
    let fetched = if artist_key(artist_uri) == artist_key(&anchor.id) {
        None
    } else {
        match Artist::get(session, artist_uri).await {
            Ok(artist) => Some(artist),
            Err(_) => return Vec::new(),
        }
    };
    let artist = fetched.as_ref().unwrap_or(anchor);
    let mut uris = artist_top_track_uris(artist);
    uris.retain(|uri| !is_played_uri(uri, seed_uri, previous));
    uris.dedup();
    uris
}

fn artist_key(uri: &SpotifyUri) -> Option<String> {
    let SpotifyUri::Artist { id } = uri else {
        return None;
    };
    id.to_base62().ok().filter(|key| is_base62_id(key))
}

fn is_played_uri(uri: &str, seed_uri: &str, previous: &[String]) -> bool {
    uri == seed_uri || previous.iter().any(|prev| prev.trim() == uri)
}

fn gcd(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        let next = a % b;
        a = b;
        b = next;
    }
    a
}

fn coprime_stride(len: usize) -> usize {
    if len <= 1 {
        return 1;
    }
    let mut stride = (len / 3).max(1);
    if stride >= len {
        stride = 1;
    }
    while gcd(stride, len) != 1 {
        stride += 1;
        if stride >= len {
            return 1;
        }
    }
    stride
}

fn rotation_index(step: usize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let stride = coprime_stride(len);
    let remainder = step % len;
    ((remainder + 1) * stride) % len
}

fn strided_order(step: usize, len: usize) -> Vec<usize> {
    if len == 0 {
        return Vec::new();
    }
    let stride = coprime_stride(len);
    let start = rotation_index(step, len);
    (0..len)
        .map(|offset| (start + offset * stride) % len)
        .collect()
}

fn cooled_contains(cooled: &[String], artist_id: &str) -> bool {
    !artist_id.is_empty() && cooled.iter().any(|id| id == artist_id)
}

#[cfg(test)]
fn select_artist_index(step: usize, pool: &[String], cooled: &[String]) -> Option<usize> {
    let order = strided_order(step, pool.len());
    if let Some(index) = order
        .iter()
        .copied()
        .find(|&index| !cooled_contains(cooled, &pool[index]))
    {
        return Some(index);
    }
    let last = cooled.last().map(String::as_str);
    order
        .into_iter()
        .find(|&index| last != Some(pool[index].as_str()))
}

fn cooldown_window(recent: &[String], anchor_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = recent
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| is_base62_id(id))
        .collect();
    if ids.is_empty() && is_base62_id(anchor_id) {
        ids.push(anchor_id.to_string());
    }
    if ids.len() > ARTIST_COOLDOWN {
        ids = ids.split_off(ids.len() - ARTIST_COOLDOWN);
    }
    ids
}

fn drop_cooled_artists(tracks: Vec<TrackJson>, cooled: &[String]) -> Vec<TrackJson> {
    if cooled.is_empty() {
        return tracks;
    }
    let mut fresh = Vec::new();
    let mut cooled_tracks = Vec::new();
    for track in tracks {
        if track_is_cooled(&track, cooled) {
            cooled_tracks.push(track);
        } else {
            fresh.push(track);
        }
    }
    if fresh.is_empty() {
        cooled_tracks
    } else {
        fresh
    }
}

fn track_is_cooled(track: &TrackJson, cooled: &[String]) -> bool {
    match track.artist_id.as_deref() {
        Some(id) if is_base62_id(id) => cooled.iter().any(|cooled_id| cooled_id == id),
        _ => false,
    }
}

fn artist_top_track_uris(artist: &Artist) -> Vec<String> {
    let global = artist.top_tracks.for_country("");
    let top = if !global.is_empty() {
        global
    } else {
        artist
            .top_tracks
            .first()
            .map(|country| country.tracks.clone())
            .unwrap_or_default()
    };
    top.iter()
        .filter_map(|uri| uri.to_uri().ok())
        .filter(|uri| uri.starts_with("spotify:track:"))
        .collect()
}

async fn station_uris(
    session: &Session,
    seed: &SpotifyUri,
    seed_uri: &str,
    previous_uris: &[String],
) -> Vec<String> {
    let mut uris = apollo_uris(session, seed_uri, previous_uris)
        .await
        .unwrap_or_default();
    uris.retain(|uri| uri != seed_uri);
    if uris.is_empty() {
        uris = radio_uris(session, seed).await.unwrap_or_default();
        uris.retain(|uri| uri != seed_uri);
    }
    if uris.is_empty() {
        let mut recent = previous_uris.to_vec();
        if !recent.iter().any(|uri| uri == seed_uri) {
            recent.push(seed_uri.to_string());
        }
        let request = AutoplayContextRequest {
            context_uri: Some(seed_uri.to_string()),
            recent_track_uri: recent,
            ..Default::default()
        };
        if let Ok(ctx) = session.spclient().get_autoplay_context(&request).await {
            uris = track_uris(&ctx);
            uris.retain(|uri| uri != seed_uri);
        }
    }
    uris
}

fn previous_track_uris(previous: &[String], seed_uri: &str) -> Vec<String> {
    let mut uris = Vec::new();
    for raw in previous {
        let trimmed = raw.trim();
        if !trimmed.starts_with("spotify:track:") || trimmed == seed_uri {
            continue;
        }
        if uris.iter().any(|uri| uri == trimmed) {
            continue;
        }
        uris.push(trimmed.to_string());
        if uris.len() == PREVIOUS_LIMIT {
            break;
        }
    }
    uris
}

fn previous_track_ids(uris: &[String]) -> Vec<SpotifyId> {
    uris.iter().filter_map(|uri| track_id(uri)).collect()
}

fn track_id(uri: &str) -> Option<SpotifyId> {
    match SpotifyUri::from_uri(uri).ok()? {
        SpotifyUri::Track { id } => Some(id),
        _ => None,
    }
}

async fn apollo_uris(session: &Session, seed_uri: &str, previous: &[String]) -> Result<Vec<String>> {
    let bytes = session
        .spclient()
        .get_apollo_station(
            "tracks",
            seed_uri,
            Some(APOLLO_COUNT),
            previous_track_ids(previous),
            true,
        )
        .await
        .context("apollo station")?;
    let value: Value = serde_json::from_slice(&bytes).context("apollo json")?;
    Ok(station_track_uris(&value))
}

fn station_track_uris(value: &Value) -> Vec<String> {
    let mut found = Vec::new();
    collect_uris(value, &mut found);
    let mut tracks: Vec<String> = found
        .into_iter()
        .filter(|uri| uri.starts_with("spotify:track:"))
        .collect();
    if tracks.is_empty() {
        collect_bare_track_ids(value, false, &mut tracks);
    }
    tracks
}

fn collect_bare_track_ids(value: &Value, in_tracks: bool, out: &mut Vec<String>) {
    match value {
        Value::String(text) if in_tracks && is_base62_id(text) => {
            out.push(format!("spotify:track:{text}"));
        }
        Value::Array(items) => {
            for item in items {
                collect_bare_track_ids(item, in_tracks, out);
            }
        }
        Value::Object(map) => {
            if in_tracks {
                let uri = map.get("uri").and_then(Value::as_str).unwrap_or("");
                if !uri.starts_with("spotify:track:") {
                    if let Some(id) = map.get("id").and_then(Value::as_str) {
                        if is_base62_id(id) {
                            out.push(format!("spotify:track:{id}"));
                        }
                    }
                }
            }
            for (key, item) in map {
                if matches!(key.as_str(), "artists" | "artist" | "album" | "images") {
                    continue;
                }
                let child_in_tracks = key == "tracks" || (in_tracks && key == "items");
                collect_bare_track_ids(item, child_in_tracks, out);
            }
        }
        _ => {}
    }
}

fn is_base62_id(value: &str) -> bool {
    value.len() == 22 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
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
    let artist_id = track.artists.first().and_then(|artist| artist_key(&artist.id));
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
        artist_id,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn station_json_keeps_track_uris() {
        let value = json!({
            "uri": "spotify:station:track:seed",
            "tracks": [
                { "uri": "spotify:track:aaaaaaaaaaaaaaaaaaaaaa" },
                { "uri": "spotify:playlist:bbbbbbbbbbbbbbbbbbbbbb" },
                { "uri": "spotify:track:cccccccccccccccccccccc" }
            ]
        });
        assert_eq!(
            station_track_uris(&value),
            vec![
                "spotify:track:aaaaaaaaaaaaaaaaaaaaaa".to_string(),
                "spotify:track:cccccccccccccccccccccc".to_string(),
            ]
        );
    }

    #[test]
    fn station_json_prefixes_bare_track_ids() {
        let value = json!({
            "tracks": [
                {
                    "id": "aaaaaaaaaaaaaaaaaaaaaa",
                    "name": "Song",
                    "artists": [{ "id": "bbbbbbbbbbbbbbbbbbbbbb" }]
                }
            ]
        });
        assert_eq!(
            station_track_uris(&value),
            vec!["spotify:track:aaaaaaaaaaaaaaaaaaaaaa".to_string()]
        );
    }

    #[test]
    fn previous_uris_skip_the_seed_and_cap() {
        let previous = [
            "spotify:track:seedseedseedseedseedse".to_string(),
            " not-a-track ".to_string(),
            "spotify:track:oneoneoneoneoneoneoneo".to_string(),
            "spotify:track:oneoneoneoneoneoneoneo".to_string(),
            "spotify:track:twotwotwotwotwotwotwotw".to_string(),
            "spotify:track:threethreethreethreeth".to_string(),
            "spotify:track:fourfourfourfourfourfo".to_string(),
            "spotify:track:fivefivefivefivefivefi".to_string(),
            "spotify:track:sixsixsixsixsixsixsixs".to_string(),
        ];
        assert_eq!(
            previous_track_uris(&previous, "spotify:track:seedseedseedseedseedse"),
            vec![
                "spotify:track:oneoneoneoneoneoneoneo".to_string(),
                "spotify:track:twotwotwotwotwotwotwotw".to_string(),
                "spotify:track:threethreethreethreeth".to_string(),
                "spotify:track:fourfourfourfourfourfo".to_string(),
                "spotify:track:fivefivefivefivefivefi".to_string(),
            ]
        );
    }

    fn aid(n: u8) -> String {
        let ch = char::from(b'a' + n);
        ch.to_string().repeat(22)
    }

    fn sample_track(artist_id: &str, uri: &str) -> TrackJson {
        TrackJson {
            uri: uri.to_string(),
            identifier: "track".into(),
            title: "Song".into(),
            author: "Artist".into(),
            artist_id: Some(artist_id.to_string()),
            length: 1,
            artwork_url: None,
            isrc: None,
            is_seekable: true,
            is_stream: false,
            source_name: "spotify",
        }
    }

    #[test]
    fn stride_visits_every_index_once_per_cycle() {
        for len in 1..48 {
            let mut seen = vec![0usize; len];
            for step in 0..len {
                seen[rotation_index(step, len)] += 1;
            }
            assert!(
                seen.iter().all(|count| *count == 1),
                "len {len} saw {seen:?}"
            );
        }
    }

    #[test]
    fn first_rotation_step_is_not_the_anchor() {
        for len in 2..48 {
            assert_ne!(rotation_index(0, len), 0, "len {len}");
        }
    }

    #[test]
    fn cooled_artist_is_skipped_and_returns_after_the_gap() {
        let pool: Vec<String> = (0..6).map(aid).collect();
        let blocked = rotation_index(0, pool.len());
        let cooled = vec![pool[blocked].clone(), aid(10), aid(11)];
        let picked = select_artist_index(0, &pool, &cooled).unwrap();
        assert_ne!(picked, blocked);

        let later = vec![aid(10), aid(11), aid(12)];
        assert_eq!(select_artist_index(0, &pool, &later).unwrap(), blocked);
    }

    #[test]
    fn full_window_still_skips_the_artist_just_played() {
        let pool: Vec<String> = (0..4).map(aid).collect();
        let cooled = pool.clone();
        let picked = select_artist_index(0, &pool, &cooled).unwrap();
        assert_ne!(pool[picked], *cooled.last().unwrap());
    }

    #[test]
    fn a_single_cooled_artist_is_not_repeated_immediately() {
        let pool = vec![aid(0)];
        assert_eq!(select_artist_index(0, &pool, &pool), None);
    }

    #[test]
    fn cooldown_window_keeps_the_last_three_and_defaults_to_the_anchor() {
        let recent = vec![aid(0), aid(1), aid(2), aid(3)];
        assert_eq!(
            cooldown_window(&recent, &aid(4)),
            vec![aid(1), aid(2), aid(3)]
        );
        assert_eq!(cooldown_window(&[], &aid(4)), vec![aid(4)]);
    }

    #[test]
    fn station_keeps_cooled_artists_only_when_nobody_else_is_left() {
        let cooled = vec![aid(0)];
        let mixed = vec![
            sample_track(&aid(0), "spotify:track:aaaaaaaaaaaaaaaaaaaaaa"),
            sample_track(&aid(1), "spotify:track:bbbbbbbbbbbbbbbbbbbbbb"),
        ];
        let kept = drop_cooled_artists(mixed, &cooled);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].artist_id.as_deref(), Some(aid(1).as_str()));

        let only = vec![sample_track(&aid(0), "spotify:track:aaaaaaaaaaaaaaaaaaaaaa")];
        let kept = drop_cooled_artists(only, &cooled);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].artist_id.as_deref(), Some(aid(0).as_str()));
    }
}
