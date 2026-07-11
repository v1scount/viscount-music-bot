const API_URL = "https://ws.audioscrobbler.com/2.0/";

export function normalizeSimilarTracks(payload) {
  const rawTracks = payload?.similartracks?.track;
  if (!rawTracks) return [];

  const tracks = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
  return tracks
    .map((track) => ({
      title: String(track?.name ?? "").trim(),
      artist: String(track?.artist?.name ?? "").trim(),
      match: Number(track?.match ?? 0),
    }))
    .filter((track) => track.title && track.artist);
}

export async function getSimilarTracks({
  apiKey,
  artist,
  title,
  limit = 25,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new Error("LASTFM_API_KEY is not configured");
  }

  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    method: "track.getSimilar",
    api_key: apiKey,
    artist,
    track: title,
    autocorrect: "1",
    limit: String(limit),
    format: "json",
  }).toString();

  const response = await fetchImpl(url, {
    headers: { "user-agent": "viscount-music-bot/1.0" },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Last.fm returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`Last.fm error ${payload.error}: ${payload.message}`);
  }

  return normalizeSimilarTracks(payload);
}
