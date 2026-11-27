const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_CONCURRENCY = 8;

/** @type {Map<string, string | null>} */
const cache = new Map();

/**
 * Genres that belong in the same station. Hip-hop keeps R&B (SZA next to
 * Kendrick). Rock keeps alternative and metal. A label outside the seed's
 * group is not queued.
 */
const GENRE_GROUPS = [
  ["hip-hop", "r&b"],
  ["rock", "alternative", "metal"],
  ["country", "folk"],
  ["pop"],
  ["electronic"],
  ["indian"],
  ["latin-urban"],
  ["latin"],
  ["dancehall"],
  ["k-pop"],
  ["afrobeats"],
  ["soundtrack"],
];

/**
 * @param {unknown} value
 */
function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First billed artist. Keeps "Tyler, The Creator" intact and still splits
 * "Kanye West, Jay-Z".
 *
 * @param {unknown} value
 */
export function primaryArtistName(value) {
  const text = String(value ?? "")
    .split(/\s+(?:feat\.?|ft\.?)\s+/i)[0]
    .trim();
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && /^(the|los|las|el|la|le|les|da|de|dos|van|von)\b/i.test(parts[1])) {
    return `${parts[0]}, ${parts[1]}`;
  }
  return parts[0] ?? "";
}

/**
 * @param {unknown} label iTunes primaryGenreName
 * @returns {string | null}
 */
export function genreFamily(label) {
  const name = normalizeName(label);
  if (!name) return null;
  const rules = [
    [/hip hop|\brap\b/, "hip-hop"],
    [/r and b|\bsoul\b/, "r&b"],
    [/bollywood|tollywood|telugu|tamil|punjabi|regional indian|\bindian\b/, "indian"],
    [/dancehall|reggae/, "dancehall"],
    [/urbano|reggaeton/, "latin-urban"],
    [/mexicana|salsa|bachata|cumbia|tropical|\blatin\b/, "latin"],
    [/k pop/, "k-pop"],
    [/afro/, "afrobeats"],
    [/metal/, "metal"],
    [/alternative/, "alternative"],
    [/\brock\b/, "rock"],
    [/country/, "country"],
    [/folk|singer songwriter/, "folk"],
    [/electronic|\bdance\b|house|\bedm\b|techno/, "electronic"],
    [/soundtrack/, "soundtrack"],
    [/\bpop\b/, "pop"],
  ];
  for (const [pattern, family] of rules) {
    if (pattern.test(name)) return family;
  }
  return null;
}

/**
 * @param {string | null | undefined} seedFamily
 * @param {string | null | undefined} candidateFamily
 */
export function sameStationGenre(seedFamily, candidateFamily) {
  if (!seedFamily || !candidateFamily) return false;
  if (seedFamily === candidateFamily) return true;
  return GENRE_GROUPS.some(
    (group) => group.includes(seedFamily) && group.includes(candidateFamily),
  );
}

/**
 * @param {string} artist
 * @param {string} title
 */
function cacheKey(artist, title) {
  return `${normalizeName(artist)}|${normalizeName(title)}`;
}

/**
 * @param {string} wanted
 * @param {unknown} got
 */
function artistMatches(wanted, got) {
  const artist = normalizeName(wanted);
  const hit = normalizeName(got);
  if (artist.length < 2 || !hit) return false;
  return hit.includes(artist) || artist.includes(hit);
}

/**
 * @param {string} wanted
 * @param {unknown} got
 */
function titleMatches(wanted, got) {
  const title = normalizeName(wanted).replace(/\b(feat|ft|from)\b.*$/, "").trim();
  const hit = normalizeName(got).replace(/\b(feat|ft|from)\b.*$/, "").trim();
  if (title.length < 2 || !hit) return false;
  return hit === title || hit.startsWith(title) || title.startsWith(hit);
}

/**
 * @param {string} artist
 * @param {string} title
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string | null | undefined>} genre, null when nothing matched, undefined on failure
 */
async function lookupGenre(artist, title, fetchImpl) {
  const key = cacheKey(artist, title);
  if (cache.has(key)) return cache.get(key) ?? null;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", `${artist} ${title}`.slice(0, 180));
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "5");
  url.searchParams.set("country", "us");

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "viscount-music-bot" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let body;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  const hits = Array.isArray(body?.results) ? body.results : [];
  for (const hit of hits) {
    if (hit?.kind && hit.kind !== "song") continue;
    if (!artistMatches(artist, hit?.artistName) || !titleMatches(title, hit?.trackName)) {
      continue;
    }
    const genre = typeof hit.primaryGenreName === "string" ? hit.primaryGenreName.trim() : "";
    if (!genre) continue;
    cache.set(key, genre);
    return genre;
  }

  cache.set(key, null);
  return null;
}

/**
 * @param {Array<{ artist?: string, title?: string }>} items
 * @param {number} limit
 * @param {(item: { artist?: string, title?: string }) => Promise<string | null | undefined>} fn
 */
async function mapPool(items, limit, fn) {
  /** @type {Array<string | null | undefined>} */
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

/**
 * Keep the popularity order, but only tracks in the seed's genre group.
 * A failed lookup keeps that track. A confirmed different genre drops it.
 * When the seed itself cannot be classified, the list is unchanged.
 *
 * @param {Array<{ artist?: string, title?: string }>} candidates
 * @param {{ artist?: string, title?: string }} seed
 * @param {typeof fetch} [fetchImpl]
 */
export async function filterSameGenre(candidates, seed, fetchImpl = fetch) {
  const artist = primaryArtistName(seed?.artist);
  const title = typeof seed?.title === "string" ? seed.title.trim() : "";
  if (!artist || !title || candidates.length === 0) {
    return { tracks: candidates, genre: null };
  }

  const seedGenre = await lookupGenre(artist, title, fetchImpl);
  const seedFamily = genreFamily(seedGenre);
  if (!seedFamily) return { tracks: candidates, genre: null };

  const lookups = await mapPool(candidates, LOOKUP_CONCURRENCY, (candidate) =>
    lookupGenre(primaryArtistName(candidate.artist), String(candidate.title ?? "").trim(), fetchImpl),
  );

  const tracks = candidates.filter((candidate, index) => {
    const found = lookups[index];
    if (found === undefined) return true;
    return sameStationGenre(seedFamily, genreFamily(found));
  });
  return { tracks, genre: seedFamily };
}

export function clearGenreCache() {
  cache.clear();
}
