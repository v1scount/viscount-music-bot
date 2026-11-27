const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;

/** Bump this whenever the buffered recommendation policy changes. */
export const AUTOPLAY_QUERY = "reccobeats-genre-mix-v1";
export const POPULARITY_WINDOW = 10;
export const RECOMMENDATION_SIZE = 50;
/** Other-artist tracks needed before the seed artist can stay in the buffer. */
export const MIN_OTHER_TRACKS = 8;

/**
 * @param {unknown} value
 */
/**
 * @param {unknown} value
 * @param {"track" | "artist"} resource
 */
function spotifyIdFromValue(value, resource) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (resource === "track" && SPOTIFY_TRACK_ID.test(trimmed)) return trimmed;

  const uri = new RegExp(`^spotify:${resource}:([0-9A-Za-z]{22})$`).exec(trimmed);
  if (uri) return uri[1];

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "open.spotify.com") return null;
    const match = new RegExp(`^/${resource}/([0-9A-Za-z]{22})/?$`).exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} value
 */
function primaryArtistName(value) {
  return String(value ?? "").split(",")[0].trim();
}

/**
 * @param {object | null | undefined} track
 */
export function spotifyTrackId(track) {
  return (
    spotifyIdFromValue(track?.info?.uri, "track") ??
    spotifyIdFromValue(track?.info?.identifier, "track") ??
    spotifyIdFromValue(track?.href, "track") ??
    spotifyIdFromValue(track?.uri, "track")
  );
}

/**
 * Spotify artist id, or the ReccoBeats artist id when Spotify does not publish one.
 *
 * @param {unknown} artist
 */
export function artistSeedId(artist) {
  return (
    spotifyIdFromValue(artist?.href, "artist") ??
    (typeof artist?.id === "string" && artist.id.trim() ? artist.id.trim() : null)
  );
}

/**
 * @param {unknown} track ReccoBeats track payload
 */
export function seedArtistFromTrack(track) {
  const artist = Array.isArray(track?.artists) ? track.artists[0] : null;
  if (!artist || typeof artist !== "object") return null;
  const name = typeof artist.name === "string" ? artist.name.trim() : "";
  const id = artistSeedId(artist);
  if (!id && !name) return null;
  return { id, name };
}

/**
 * @param {unknown} value
 */
export function normalizePopularity(value) {
  const popularity = Number(value);
  return Number.isInteger(popularity) && popularity >= 0 && popularity <= 100
    ? popularity
    : null;
}

/**
 * @param {unknown} value
 */
function normalizeIsrc(value) {
  if (typeof value !== "string") return null;
  const isrc = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null;
}

/**
 * @param {unknown} row
 */
function toCandidate(row) {
  const spotifyId = spotifyIdFromValue(row?.href, "track");
  const title = typeof row?.trackTitle === "string" ? row.trackTitle.trim() : "";
  const artists = Array.isArray(row?.artists) ? row.artists : [];
  const names = artists
    .map((artist) => (typeof artist?.name === "string" ? artist.name.trim() : ""))
    .filter(Boolean);
  if (!spotifyId || !title || names.length === 0) return null;
  const artistId = artistSeedId(artists[0]);

  return {
    id: typeof row?.id === "string" ? row.id.slice(0, 64) : "",
    spotifyId,
    uri: `spotify:track:${spotifyId}`,
    title: title.slice(0, 200),
    artist: names.join(", ").slice(0, 200),
    ...(artistId ? { artistId } : {}),
    isrc: normalizeIsrc(row?.isrc),
    popularity: normalizePopularity(row?.popularity),
  };
}

/**
 * @param {{ artist?: string, artistId?: string }} candidate
 * @param {{ id?: string | null, name?: string } | null | undefined} seedArtist
 */
function sameArtist(candidate, seedArtist) {
  if (!seedArtist) return false;
  if (candidate.artistId && seedArtist.id) return candidate.artistId === seedArtist.id;
  const candidateName = normalizeName(primaryArtistName(candidate.artist));
  const seedName = normalizeName(seedArtist.name);
  return Boolean(candidateName && seedName && candidateName === seedName);
}

/**
 * One song from each artist before anyone repeats, in the order they first appeared.
 *
 * @param {Array<{ artist?: string }>} candidates
 */
function roundRobinArtists(candidates) {
  /** @type {Array<typeof candidates>} */
  const buckets = [];
  const indexByArtist = new Map();
  for (const candidate of candidates) {
    const key = normalizeName(primaryArtistName(candidate.artist)) || candidate.artist || "";
    let index = indexByArtist.get(key);
    if (index === undefined) {
      index = buckets.length;
      indexByArtist.set(key, index);
      buckets.push([]);
    }
    buckets[index].push(candidate);
  }

  /** @type {typeof candidates} */
  const mixed = [];
  let pending = candidates.length;
  while (pending > 0) {
    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      mixed.push(bucket.shift());
      pending -= 1;
    }
  }
  return mixed;
}

/**
 * Related artists lead. The artist who was playing still appears, about once
 * every four songs, instead of filling the queue. Extra seed-artist tracks
 * beyond that budget are dropped.
 *
 * @param {Array<{ artist?: string, artistId?: string }>} candidates
 * @param {{ id?: string | null, name?: string } | null | undefined} seedArtist
 */
export function arrangeStation(candidates, seedArtist) {
  const seedTracks = [];
  const others = [];
  for (const candidate of candidates) {
    if (sameArtist(candidate, seedArtist)) seedTracks.push(candidate);
    else others.push(candidate);
  }
  const related = roundRobinArtists(others);
  if (related.length === 0) return seedTracks;

  const budget = Math.max(1, Math.floor(related.length / 3));
  const seeds = seedTracks.slice(0, budget);
  /** @type {typeof candidates} */
  const mixed = [];
  let relatedIndex = 0;
  let seedIndex = 0;
  while (relatedIndex < related.length || seedIndex < seeds.length) {
    if (mixed.length % 4 === 3 && seedIndex < seeds.length) {
      mixed.push(seeds[seedIndex]);
      seedIndex += 1;
      continue;
    }
    if (relatedIndex < related.length) {
      mixed.push(related[relatedIndex]);
      relatedIndex += 1;
      continue;
    }
    if (seedIndex < seeds.length) {
      mixed.push(seeds[seedIndex]);
      seedIndex += 1;
      continue;
    }
    break;
  }
  return mixed;
}

/**
 * True when rearranging still cannot build a station led by other artists.
 *
 * @param {Array<{ artist?: string, artistId?: string }>} candidates
 * @param {{ id?: string | null, name?: string } | null | undefined} seedArtist
 */
export function needsArtistExclusion(candidates, seedArtist) {
  if (!seedArtist?.id && !seedArtist?.name) return false;
  let seedCount = 0;
  let otherCount = 0;
  for (const candidate of candidates) {
    if (sameArtist(candidate, seedArtist)) seedCount += 1;
    else otherCount += 1;
  }
  if (otherCount === 0) return seedCount > 0;
  return otherCount < MIN_OTHER_TRACKS && seedCount > otherCount;
}

/**
 * Keep ReccoBeats' similarity order, but prioritize the closest popularity
 * inside a strict window around the seed. Popularity is Spotify's 0-100
 * audience/reproduction proxy exposed by ReccoBeats.
 *
 * @param {unknown} body
 * @param {object | null | undefined} seed
 * @param {number | null} targetPopularity
 */
export function recommendationCandidates(body, seed, targetPopularity) {
  const seedId = spotifyTrackId(seed);
  const rows = Array.isArray(body?.content) ? body.content : [];
  const candidates = [];
  const seen = new Set();

  for (const [index, row] of rows.entries()) {
    const candidate = toCandidate(row);
    if (!candidate || candidate.spotifyId === seedId || seen.has(candidate.spotifyId)) {
      continue;
    }
    if (
      targetPopularity !== null &&
      (candidate.popularity === null ||
        Math.abs(candidate.popularity - targetPopularity) > POPULARITY_WINDOW)
    ) {
      continue;
    }
    seen.add(candidate.spotifyId);
    candidates.push({ candidate, index });
  }

  if (targetPopularity !== null) {
    candidates.sort((left, right) => {
      const popularityDifference =
        Math.abs(left.candidate.popularity - targetPopularity) -
        Math.abs(right.candidate.popularity - targetPopularity);
      return popularityDifference || left.index - right.index;
    });
  }

  return candidates.map(({ candidate }) => candidate);
}

/**
 * @param {unknown} value
 */
export function sanitizeRecommendationBuffer(value) {
  if (!Array.isArray(value)) return [];
  const candidates = [];
  const seen = new Set();
  for (const row of value) {
    const spotifyId = spotifyIdFromValue(row?.spotifyId ?? row?.uri, "track");
    const title = typeof row?.title === "string" ? row.title.trim() : "";
    const artist = typeof row?.artist === "string" ? row.artist.trim() : "";
    if (!spotifyId || !title || !artist || seen.has(spotifyId)) continue;
    seen.add(spotifyId);
    const artistId =
      typeof row?.artistId === "string" && row.artistId.trim() ? row.artistId.trim() : null;
    candidates.push({
      id: typeof row?.id === "string" ? row.id.slice(0, 64) : "",
      spotifyId,
      uri: `spotify:track:${spotifyId}`,
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      ...(artistId ? { artistId: artistId.slice(0, 64) } : {}),
      isrc: normalizeIsrc(row?.isrc),
      popularity: normalizePopularity(row?.popularity),
    });
    if (candidates.length >= RECOMMENDATION_SIZE) break;
  }
  return candidates;
}
