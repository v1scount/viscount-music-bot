const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Cache and session marker for the tuned similar-track query.
 * Older harmonic `/radio` playlists do not match, so they are not replayed.
 */
/**
 * Disk cache of the tuned /similar results.
 * Bump when the request changes so an older, more obscure playlist is not reused.
 */
export const PLAYLIST_CACHE = "similar-charted-close";
/** Session marker. An older buffer from a different query is dropped on restore. */
export const AUTOPLAY_QUERY = "similar-charted-close";
/**
 * Keep neighbors close to the best match. The rest of a 50-track list is where
 * a mainstream song walks into unrelated chart hits that only barely sound alike.
 */
export const SCORE_WINDOW = 0.02;
/**
 * `chart_peak` runs from 1 to 100, and 100 is a number one.
 * 40 keeps records that reached a real chart position and drops a scrape.
 */
export const MIN_CHART_PEAK = 40;

/**
 * @param {unknown} value
 */
export function normalizeIsrc(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return ISRC.test(compact) ? compact : null;
}

/**
 * @param {unknown} value
 */
export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable cache key for a Spotify track or a FreqBlog candidate.
 * ISRC wins over the name so the same recording is not fetched twice.
 *
 * @param {{ info?: { isrc?: string | null, author?: string, title?: string }, isrc?: string | null, artist?: string, title?: string, artist_name?: string, track_name?: string } | null | undefined} track
 */
export function seedKey(track) {
  const isrc = normalizeIsrc(track?.info?.isrc ?? track?.isrc);
  if (isrc) return `isrc:${isrc}`;
  const artist = normalizeName(track?.info?.author ?? track?.artist ?? track?.artist_name);
  const title = normalizeName(track?.info?.title ?? track?.title ?? track?.track_name);
  if (!artist || !title) return null;
  return `name:${artist}|${title}`;
}

/**
 * @param {object | null | undefined} stub
 */
function toCandidate(stub) {
  const title = typeof stub?.track_name === "string" ? stub.track_name.trim() : "";
  const artist = typeof stub?.artist_name === "string" ? stub.artist_name.trim() : "";
  if (!title || !artist) return null;
  const rawId = stub?.itunes_track_id;
  const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).slice(0, 64) : "";
  return {
    id,
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    isrc: normalizeIsrc(stub?.isrc),
  };
}

/**
 * Cache key for one tuned playlist. Separate from `seedKey`, which identifies a recording.
 *
 * @param {object | null | undefined} track
 */
export function playlistCacheKey(track) {
  const key = seedKey(track);
  return key ? `${PLAYLIST_CACHE}:${key}` : null;
}

/**
 * Spotify joins every credited artist. FreqBlog matches one artist name.
 *
 * @param {unknown} value
 */
export function primaryArtistName(value) {
  const name = String(value ?? "").split(",")[0].trim();
  return name || String(value ?? "").trim();
}

/**
 * `GET /similar` rows in the seed's own genre.
 * `cross_genre=strict` only keeps a genre family, and FreqBlog puts hip-hop,
 * funk, and R&B in one family, so a hip-hop seed was still returning Brazilian funk.
 * The seed artist is kept in the list, but related artists lead.
 *
 * @param {unknown} body
 * @param {object | null | undefined} seed
 */
export function similarCandidates(body, seed) {
  const seedGenre = normalizeName(body?.seed?.genre);
  const rows = Array.isArray(body?.results) ? body.results : [];
  let bestScore = null;
  for (const row of rows) {
    if (typeof row?.score === "number" && (bestScore == null || row.score > bestScore)) {
      bestScore = row.score;
    }
  }
  const tracks = [];
  for (const row of rows) {
    const relation = row?.genre_relation;
    if (relation === "cross" || relation === "compatible") continue;
    const trackGenre = normalizeName(row?.track?.genre ?? row?.genre);
    if (seedGenre && trackGenre !== seedGenre) continue;
    const peak = row?.track?.chart_peak ?? row?.chart_peak;
    if (typeof peak === "number" && peak < MIN_CHART_PEAK) continue;
    if (
      bestScore != null &&
      typeof row?.score === "number" &&
      row.score < bestScore - SCORE_WINDOW
    ) {
      continue;
    }
    tracks.push(row?.track ?? row);
  }
  return arrangeStation(radioCandidates({ tracks }, seed), seed);
}

/**
 * Related artists in the genre come first. The artist who was playing can
 * still appear, about once for every three other artists, instead of filling the queue.
 *
 * @param {Array<{ artist?: string }>} candidates
 * @param {object | null | undefined} seed
 */
export function arrangeStation(candidates, seed) {
  const seedArtist = normalizeName(
    primaryArtistName(seed?.info?.author ?? seed?.artist ?? seed?.artist_name),
  );
  const seedTracks = [];
  const others = [];
  for (const candidate of candidates) {
    if (seedArtist && artistMatch(candidate.artist, seedArtist)) seedTracks.push(candidate);
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
 * @param {string} artist
 * @param {string} seedArtist normalized primary artist
 */
function artistMatch(artist, seedArtist) {
  const name = normalizeName(primaryArtistName(artist));
  if (!name || !seedArtist) return 0;
  if (name === seedArtist || name.startsWith(`${seedArtist} `) || seedArtist.startsWith(`${name} `)) {
    return 1;
  }
  return 0;
}

/**
 * Playlist rows, without the seed and without duplicate recordings.
 *
 * @param {unknown} body
 * @param {object | null | undefined} seed
 */
export function radioCandidates(body, seed) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  /** @type {Array<{ id: string, title: string, artist: string, isrc: string | null }>} */
  const candidates = [];
  const seen = new Set();
  for (const stub of tracks) {
    const candidate = toCandidate(stub);
    if (!candidate || sameRecording(candidate, seed)) continue;
    const key = seedKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * @param {object | null | undefined} left
 * @param {object | null | undefined} right
 */
export function sameRecording(left, right) {
  const isrcA = normalizeIsrc(left?.info?.isrc ?? left?.isrc);
  const isrcB = normalizeIsrc(right?.info?.isrc ?? right?.isrc);
  if (isrcA && isrcB) return isrcA === isrcB;
  const nameA = seedKey({ artist: left?.info?.author ?? left?.artist, title: left?.info?.title ?? left?.title });
  const nameB = seedKey({ artist: right?.info?.author ?? right?.artist, title: right?.info?.title ?? right?.title });
  return Boolean(nameA && nameA === nameB);
}

/**
 * @param {unknown} value
 */
export function sanitizeRadioBuffer(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Array<{ id: string, title: string, artist: string, isrc: string | null }>} */
  const buffer = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const artist = typeof item.artist === "string" ? item.artist.trim() : "";
    if (!title || !artist) continue;
    buffer.push({
      id: typeof item.id === "string" ? item.id.slice(0, 64) : "",
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      isrc: normalizeIsrc(item.isrc),
    });
    if (buffer.length >= 50) break;
  }
  return buffer;
}

/**
 * @param {unknown} value
 */
export function sanitizeFetchedKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((key) => typeof key === "string" && key.length > 0 && key.length < 300).slice(-40);
}

/**
 * Pick the Spotify track that is the FreqBlog candidate.
 * An ISRC match wins. Otherwise the title and artist have to agree.
 *
 * @param {{ title?: string, artist?: string, isrc?: string | null }} candidate
 * @param {Array<{ info?: { uri?: string, title?: string, author?: string, isrc?: string | null } }> | null | undefined} tracks
 */
export function matchSpotifyTrack(candidate, tracks) {
  const wantIsrc = normalizeIsrc(candidate?.isrc);
  const wantTitle = normalizeName(candidate?.title);
  const wantArtist = normalizeName(candidate?.artist);
  const artistTokens = wantArtist.split(" ").filter((token) => token.length > 1);
  let nameMatch = null;

  for (const track of tracks ?? []) {
    if (!track?.info?.uri?.startsWith("spotify:track:")) continue;
    const gotIsrc = normalizeIsrc(track.info.isrc);
    if (wantIsrc && gotIsrc === wantIsrc) return track;
    if (nameMatch || (wantIsrc && gotIsrc && gotIsrc !== wantIsrc)) continue;

    const title = normalizeName(track.info.title);
    const artist = normalizeName(track.info.author);
    const titleOk = title === wantTitle || (wantTitle.length > 0 && title.startsWith(`${wantTitle} `));
    if (!titleOk) continue;
    const artistWords = new Set(artist.split(" ").filter(Boolean));
    if (artistTokens.length > 0 && !artistTokens.every((token) => artistWords.has(token))) continue;
    nameMatch = track;
  }

  return nameMatch;
}
