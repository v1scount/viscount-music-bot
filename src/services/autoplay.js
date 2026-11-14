import { debug, log, logError } from "../utils/logger.js";
import { matchSpotifyTrack, seedKey } from "./freqblog.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

const RESOLVE_ATTEMPTS = 50;
/** Safety cap. The score window usually leaves fewer songs than this. */
const STATION_LIMIT = 12;
const resolveCache = new WeakMap();
let missingKeyLogged = false;

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

/**
 * @param {ReturnType<typeof getPlayerState>} state
 * @param {{ artist?: string, title?: string, isrc?: string | null }} candidate
 */
function isBlocked(state, candidate) {
  const raw = `${candidate.artist ?? ""}:${candidate.title ?? ""}`.trim().toLowerCase();
  if (raw && state.recentTrackKeys?.includes(raw)) return true;
  const isrc = candidate.isrc?.toLowerCase();
  return Boolean(isrc && state.recentTrackKeys?.includes(isrc));
}

/**
 * @param {object} client
 */
function cacheFor(client) {
  let cache = resolveCache.get(client);
  if (!cache) {
    cache = new Map();
    resolveCache.set(client, cache);
  }
  return cache;
}

/**
 * @param {{ info?: object }} track
 */
function cloneTrack(track) {
  return { info: { ...track.info } };
}

/**
 * Stay on the song the listener asked for. A later seed is how the station
 * walks away from that song's popularity.
 *
 * @param {{ autoplayFetchedKeys?: string[] }} state
 * @param {object} anchor
 */
function nextSeed(state, anchor) {
  const key = seedKey(anchor);
  if (!key || state.autoplayFetchedKeys?.includes(key)) return null;
  return anchor;
}

/**
 * @param {{ autoplayFetchedKeys?: string[] }} state
 * @param {string | null} key
 */
function rememberFetched(state, key) {
  if (!key) return;
  state.autoplayFetchedKeys = [...(state.autoplayFetchedKeys ?? []).filter((item) => item !== key), key].slice(-40);
}

function logMissingKey() {
  if (missingKeyLogged) return;
  missingKeyLogged = true;
  log("autoplay", "Set FREQBLOG_API_KEY to enable autoplay");
}

/**
 * @param {{ info?: object }} track
 * @param {{ id?: string, title?: string, artist?: string, isrc?: string | null }} candidate
 */
function withSource(track, candidate) {
  return Object.assign(cloneTrack(track), { autoplaySource: candidate });
}

/**
 * Walk the cached playlist. A search error or a miss drops that one candidate
 * and keeps going. `failed` is set when Spotify itself rejected a lookup.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {{ autoplayBuffer?: object[], recentTrackKeys?: string[] }} state
 * @param {{ failed: boolean }} outcome
 */
async function takeResolved(client, state, outcome) {
  const cache = cacheFor(client);
  let tried = 0;

  while (state.autoplayBuffer.length > 0 && tried < RESOLVE_ATTEMPTS) {
    const candidate = state.autoplayBuffer.shift();
    if (isBlocked(state, candidate)) continue;
    tried += 1;

    const key = seedKey(candidate);
    if (key && cache.has(key)) {
      const cached = cache.get(key);
      if (cached && !isRecent(state, cached)) return withSource(cached, candidate);
      continue;
    }

    let result;
    try {
      result = await client.spotify.search(`${candidate.artist} ${candidate.title}`);
    } catch (error) {
      outcome.failed = true;
      logError("autoplay:resolve", error, {
        title: candidate.title,
        artist: candidate.artist,
      });
      continue;
    }

    const match = matchSpotifyTrack(candidate, result?.tracks);
    if (match && key) {
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      cache.set(key, cloneTrack(match));
    }
    if (!match || isRecent(state, match)) continue;
    return withSource(match, candidate);
  }

  return null;
}

/**
 * One FreqBlog /similar call fills up to 50 tracks in the seed's genre family.
 * Those tracks are played locally; another call happens only after that list is used up.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ autoplaySeed?: object | null, autoplayBuffer?: object[], autoplayFetchedKeys?: string[], lastTrack?: object | null, recentTrackKeys?: string[], recentTrackUris?: string[] }} state
 */
export async function findAutoplayTrack(client, player, state) {
  const anchor = state.autoplaySeed ?? state.lastTrack ?? player.previousTrack;
  if (!anchor?.info?.uri?.startsWith("spotify:track:")) return null;
  if (!client.freqblog) return null;

  if (!Array.isArray(state.autoplayBuffer)) state.autoplayBuffer = [];
  if (!Array.isArray(state.autoplayFetchedKeys)) state.autoplayFetchedKeys = [];
  if (!Array.isArray(state.recentTrackKeys)) state.recentTrackKeys = [];

  const outcome = { failed: false };
  const ready = await takeResolved(client, state, outcome);
  if (ready) return ready;
  // A rejected lookup is not an empty playlist. Keep the remaining tracks
  // instead of spending another FreqBlog call and dropping them.
  if (outcome.failed || state.autoplayBuffer.length > 0) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seed = nextSeed(state, anchor);
    if (!seed) return null;

    let result;
    try {
      result = await client.freqblog.similar(seed);
    } catch (error) {
      if (error?.code === "missing_key") logMissingKey();
      else {
        logError("autoplay:freqblog", error, {
          title: seed.info?.title,
          artist: seed.info?.author,
        });
      }
      return null;
    }

    rememberFetched(state, seedKey(seed));
    if (!result.fromCache) {
      log(
        "autoplay",
        `FreqBlog similar for "${seed.info?.title ?? seed.info?.uri}" returned ${result.tracks.length} tracks`,
      );
    } else {
      debug("autoplay", `Reused cached similar tracks for "${seed.info?.title ?? seed.info?.uri}"`);
    }

    state.autoplayBuffer = result.tracks.filter((candidate) => !isBlocked(state, candidate));
    const track = await takeResolved(client, state, outcome);
    if (track) return track;
    if (outcome.failed || state.autoplayBuffer.length > 0) return null;
  }

  return null;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {import("../player/guildPlayer.js").GuildPlayer} player
 */
export async function startAutoplay(client, player) {
  const state = getPlayerState(client, player.guildId);
  if (!state.autoplay || state.autoplayPending) return false;

  state.autoplayPending = true;
  try {
    /** @type {Array<{ info: object, autoplaySource?: object }>} */
    const tracks = [];
    while (tracks.length < STATION_LIMIT) {
      const next = await findAutoplayTrack(client, player, state);
      if (!next) break;
      tracks.push(next);
    }
    if (tracks.length === 0) return false;

    if (player.currentTrack || player.isPlaying || player.queue.length > 0) {
      for (const track of tracks.reverse()) {
        if (track.autoplaySource) state.autoplayBuffer.unshift(track.autoplaySource);
      }
      debug("autoplay", "Manual playback took priority over recommendation");
      return true;
    }

    for (const track of tracks) {
      delete track.autoplaySource;
      track.info.requester = "Autoplay";
      player.queue.add(track);
    }
    await player.play();
    player.isAutoPlay = true;
    return true;
  } finally {
    state.autoplayPending = false;
  }
}
