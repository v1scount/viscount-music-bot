/**
 * @param {string} text
 */
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{ info?: { identifier?: string, uri?: string } }} track
 */
function trackKey(track) {
  const id = track.info?.identifier?.trim();
  if (id) return id;
  const uri = track.info?.uri?.trim();
  if (uri) return uri;
  return null;
}

/**
 * Exact title matches come first. Everything else keeps Spotify's order.
 *
 * @param {string} query
 * @param {{ info?: { title?: string, author?: string } }} track
 */
export function searchScore(query, track) {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;

  const title = normalize(track?.info?.title);
  const artist = normalize(track?.info?.author);
  const titleTokens = new Set(title.split(" ").filter(Boolean));
  const artistTokens = new Set(artist.split(" ").filter(Boolean));
  const queryText = tokens.join(" ");

  let score = 0;
  if (title === queryText) score += 100;
  if (tokens.every((token) => titleTokens.has(token))) score += 40;
  if (tokens.every((token) => titleTokens.has(token) || artistTokens.has(token))) {
    score += 20;
  }
  for (const token of tokens) {
    if (titleTokens.has(token)) score += 2;
    else if (artistTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * @param {string} query
 * @param {Array<{ info?: { identifier?: string, uri?: string, title?: string, author?: string } }>} tracks
 */
export function rankSearchResults(query, tracks) {
  const seen = new Set();
  /** @type {Array<{ track: (typeof tracks)[number], index: number, score: number }>} */
  const ranked = [];

  (tracks ?? []).forEach((track, index) => {
    const key = trackKey(track);
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    ranked.push({ track, index, score: searchScore(query, track) });
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((entry) => entry.track);
}

/**
 * @param {string} query
 * @param {Array<{ loadType?: string, tracks?: unknown[] } | null | undefined>} results
 */
export function mergeLoadedSearches(query, results) {
  /** @type {unknown[]} */
  const tracks = [];
  let sawEmpty = false;
  let sawError = false;

  for (const result of results) {
    if (!result || result.loadType === "error") {
      sawError = true;
      continue;
    }
    const list = result.tracks ?? [];
    if (list.length === 0) {
      sawEmpty = true;
      continue;
    }
    tracks.push(...list);
  }

  const ranked = rankSearchResults(query, tracks);
  if (ranked.length > 0) return { loadType: "search", tracks: ranked };
  if (sawEmpty) return { loadType: "empty", tracks: [] };
  if (sawError) return { loadType: "error", tracks: [] };
  return { loadType: "empty", tracks: [] };
}

/**
 * Resolve every promise, or return whatever has finished when `timeoutMs` elapses.
 * Missing entries stay `undefined`.
 *
 * @template T
 * @param {Array<Promise<T>>} promises
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<T | undefined>>}
 */
export function settleWithin(promises, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {Array<T | undefined>} */
    const results = new Array(promises.length);
    let pending = promises.length;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(results);
    };

    const timer = timeoutMs == null ? null : setTimeout(finish, timeoutMs);

    const completeOne = () => {
      pending -= 1;
      if (pending === 0) {
        if (timer) clearTimeout(timer);
        finish();
      }
    };

    promises.forEach((promise, index) => {
      Promise.resolve(promise).then(
        (value) => {
          results[index] = value;
          completeOne();
        },
        () => {
          completeOne();
        },
      );
    });

    if (pending === 0) {
      if (timer) clearTimeout(timer);
      finish();
    }
  });
}
