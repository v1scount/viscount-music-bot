/** Studio / album audio, including clean titles and YouTube Music hits. */
const TIER_STUDIO = 1;
/** Same recording published as a music video. */
const TIER_OFFICIAL_VIDEO = 2;
/** Live, remix, cover, and other alternate uploads. */
const TIER_VARIANT = 3;
/** The version the query itself asked for. */
const TIER_REQUESTED = 0;

const VARIANT_MARKERS = [
  { id: "live", pattern: /\b(?:live|concert)\b/i },
  { id: "remix", pattern: /\bremix(?:es|ed)?\b/i },
  { id: "cover", pattern: /\bcover\b/i },
  { id: "karaoke", pattern: /\bkaraoke\b/i },
  { id: "instrumental", pattern: /\binstrumental\b/i },
  { id: "acoustic", pattern: /\bacoustic\b/i },
  { id: "nightcore", pattern: /\bnightcore\b/i },
  { id: "sped", pattern: /\b(?:sped|speed)[\s-]*up\b/i },
  { id: "slowed", pattern: /\bslowed\b/i },
  { id: "8d", pattern: /\b8d\b/i },
  { id: "visualizer", pattern: /\bvisuali[sz]er\b/i },
  { id: "lyrics", pattern: /\blyrics?\b/i },
];

const OFFICIAL_VIDEO =
  /\b(?:official\s+(?:music\s+)?video|music\s+video|\bmv\b)\b/i;

/**
 * @param {string} text
 */
function variantIds(text) {
  return VARIANT_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.id,
  );
}

/**
 * @param {import("poru").Track | { info?: { identifier?: string, uri?: string } }} track
 */
function trackKey(track) {
  const id = track.info?.identifier?.trim();
  if (id) return id;
  const uri = track.info?.uri?.trim();
  if (uri) return uri;
  return null;
}

/**
 * @param {string} artist
 */
function normalizeArtist(artist) {
  return String(artist)
    .toLowerCase()
    .replace(/\s*-\s*topic\b.*/g, "")
    .replace(/\bvevo\b/g, "")
    .replace(/\bofficial\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} title
 */
function normalizeTitle(title) {
  let text = String(title).toLowerCase();
  let previous;
  do {
    previous = text;
    text = text.replace(/\s*\([^)]*\)/g, " ").replace(/\s*\[[^\]]*\]/g, " ");
  } while (text !== previous);

  return text
    .replace(
      /\b(?:official\s+(?:music\s+)?video|official\s+audio|music\s+video)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} left
 * @param {string} right
 */
function artistsMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;

  const compact = (value) => value.replace(/\s+/g, "");
  const a = compact(left);
  const b = compact(right);
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.startsWith(shorter);
}

/**
 * @param {{ info?: { title?: string, author?: string } }} track
 */
function songIdentity(track) {
  let title = track?.info?.title ?? "";
  let artist = track?.info?.author ?? "";
  const split = title.match(/^\s*(.+?)\s+-\s+(.+)$/);
  if (split) {
    const left = normalizeArtist(split[1]);
    const author = normalizeArtist(artist);
    if (left && split[2] && (!author || artistsMatch(left, author))) {
      title = split[2];
      if (!author) artist = split[1];
    }
  }

  return {
    title: normalizeTitle(title),
    artist: normalizeArtist(artist),
  };
}

/**
 * @param {{ title: string, artist: string }} left
 * @param {{ title: string, artist: string }} right
 */
function sameSong(left, right) {
  if (!left.title || left.title !== right.title) return false;
  if (!left.artist && !right.artist) return true;
  return artistsMatch(left.artist, right.artist);
}

/**
 * @param {string} query
 * @param {{ info?: { title?: string, author?: string } }} track
 */
export function searchTier(query, track) {
  const text = `${track?.info?.title ?? ""} ${track?.info?.author ?? ""}`;
  const queryText = query ?? "";
  const queryVariants = new Set(variantIds(queryText));
  const titleVariants = variantIds(text);
  const unrequested = titleVariants.filter((id) => !queryVariants.has(id));

  if (unrequested.length > 0) return TIER_VARIANT;

  const titleIsOfficialVideo = OFFICIAL_VIDEO.test(text);
  const queryWantsOfficialVideo = OFFICIAL_VIDEO.test(queryText);
  const requested = titleVariants.some((id) => queryVariants.has(id));

  if (queryWantsOfficialVideo && titleIsOfficialVideo && !requested) {
    return TIER_REQUESTED;
  }
  if (requested) return TIER_REQUESTED;
  if (titleIsOfficialVideo) return TIER_OFFICIAL_VIDEO;
  return TIER_STUDIO;
}

/**
 * The last list is the relevance order (YouTube). Earlier lists (YouTube
 * Music) only supply another version of a song already in that order.
 * Inside one song, studio audio stays ahead of the official video, which
 * stays ahead of live, remix, and other uploads.
 *
 * @param {string} query
 * @param {Array<Array<{ info?: { identifier?: string, uri?: string, title?: string, author?: string } }>>} trackLists
 */
export function rankSearchResults(query, trackLists) {
  const lists = (trackLists ?? []).map((list) => list ?? []);
  const relevance = lists.at(-1) ?? [];
  const extras = lists.slice(0, -1);
  /** @type {Array<{ identity: { title: string, artist: string }, songRank: number }>} */
  const groups = [];
  /** @type {Array<{ track: (typeof lists)[number][number], index: number, tier: number, songRank: number }>} */
  const ranked = [];
  const seen = new Set();
  let index = 0;

  /**
   * @param {{ title: string, artist: string }} identity
   */
  const findGroup = (identity) =>
    groups.find((group) => sameSong(group.identity, identity));

  /**
   * @param {(typeof lists)[number][number]} track
   * @param {number} songRank
   */
  const push = (track, songRank) => {
    const key = trackKey(track);
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    ranked.push({
      track,
      index,
      tier: searchTier(query, track),
      songRank,
    });
    index += 1;
  };

  relevance.forEach((track, position) => {
    const identity = songIdentity(track);
    let group = findGroup(identity);
    if (!group) {
      group = { identity, songRank: position };
      groups.push(group);
    }
    push(track, group.songRank);
  });

  let extraRank = relevance.length;
  for (const list of extras) {
    for (const track of list) {
      const identity = songIdentity(track);
      let group = findGroup(identity);
      if (!group) {
        group = { identity, songRank: extraRank };
        extraRank += 1;
        groups.push(group);
      }
      push(track, group.songRank);
    }
  }

  ranked.sort(
    (a, b) => a.songRank - b.songRank || a.tier - b.tier || a.index - b.index,
  );
  return ranked.map((entry) => entry.track);
}

/**
 * @param {string} query
 * @param {Array<{ loadType?: string, tracks?: unknown[] } | null | undefined>} results
 */
export function mergeLoadedSearches(query, results) {
  /** @type {unknown[][]} */
  const lists = [];
  let sawEmpty = false;
  let sawError = false;

  for (const result of results) {
    if (!result || result.loadType === "error") {
      sawError = true;
      continue;
    }
    const tracks = result.tracks ?? [];
    if (tracks.length === 0) {
      sawEmpty = true;
      continue;
    }
    lists.push(tracks);
  }

  const tracks = rankSearchResults(query, lists);
  if (tracks.length > 0) return { loadType: "search", tracks };
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

    const timer =
      timeoutMs == null ? null : setTimeout(finish, timeoutMs);

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
