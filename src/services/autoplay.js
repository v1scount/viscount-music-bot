import { debug, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

/**
 * The first station after requested tracks uses the last request. Once a
 * harvested list has played out, the next harvest continues from the track
 * that just finished.
 *
 * @param {{ previousTrack?: { info?: { uri?: string, requester?: unknown } } | null }} player
 * @param {{ autoplaySeed?: { info?: { uri?: string } } | null, lastTrack?: { info?: { uri?: string } } | null }} state
 */
export function harvestSeed(player, state) {
  const finished = player.previousTrack;
  if (finished?.info?.requester === "Autoplay" && finished.info.uri?.startsWith("spotify:track:")) {
    return finished;
  }
  return state.autoplaySeed ?? state.lastTrack ?? finished ?? null;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ autoplaySeed?: object | null, autoplayCount?: number, lastTrack?: object | null, recentArtistIds?: string[], recentTrackKeys?: string[], recentTrackUris?: string[] }} state
 */
export async function findAutoplayTracks(client, player, state) {
  const anchor = state.autoplaySeed ?? state.lastTrack ?? player.previousTrack;
  const anchorUri = anchor?.info?.uri;
  if (!anchorUri?.startsWith("spotify:track:")) return [];

  const previous = Array.isArray(state.recentTrackUris) ? state.recentTrackUris : [];
  const artists = Array.isArray(state.recentArtistIds) ? state.recentArtistIds : [];
  const step = state.autoplayCount ?? 0;

  let result;
  try {
    result = await client.spotify.radio(anchorUri, previous, step, artists);
  } catch (error) {
    logError("autoplay:radio", error, {
      title: anchor.info?.title,
      artist: anchor.info?.author,
    });
    return [];
  }

  return (result.tracks ?? []).filter((track) => accepts(state, track, anchor));
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ autoplaySeed?: object | null, autoplayCount?: number, lastTrack?: object | null, recentArtistIds?: string[], recentTrackKeys?: string[], recentTrackUris?: string[] }} state
 */
export async function findAutoplayTrack(client, player, state) {
  const tracks = await findAutoplayTracks(client, player, state);
  return tracks[0] ?? null;
}

/**
 * @param {{ recentTrackKeys?: string[] }} state
 * @param {{ info?: { uri?: string, identifier?: string } } | null | undefined} track
 * @param {{ info?: { uri?: string, identifier?: string } } | null | undefined} anchor
 */
function accepts(state, track, anchor) {
  if (!track?.info?.uri || track.info.uri === anchor?.info?.uri) return false;
  if (track.info.identifier && track.info.identifier === anchor?.info?.identifier) return false;
  return !isRecent(state, track);
}

/**
 * Drop recommendation rows so a new request is not followed by the old station.
 *
 * @param {{ splice: (start: number, deleteCount?: number) => unknown[], length: number, [index: number]: { info?: { requester?: unknown } } }} queue
 */
export function dropQueuedAutoplay(queue) {
  let removed = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.info?.requester === "Autoplay") {
      queue.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} seedUri
 * @param {string[]} recentUris
 * @param {{ recentTrackKeys?: string[] }} state
 */
async function harvestTracks(client, seed, recentUris, state) {
  const seedUri = seed?.info?.uri;
  let harvested;
  try {
    harvested = await client.soloist.harvest(seedUri, recentUris);
  } catch (error) {
    logError("autoplay:soloist", error, { uri: seedUri });
    return { tracks: [], recommendations: null };
  }

  const rows = Array.isArray(harvested) ? harvested : harvested?.tracks ?? [];
  const recommendations = Array.isArray(harvested) ? null : harvested?.recommendations ?? null;
  /** @type {object[]} */
  const tracks = [];
  for (const track of rows) {
    const ready = track?.info?.title ? track : await resolveHarvestTrack(client, track?.info?.uri);
    if (!ready || !accepts(state, ready, seed)) continue;
    ready.info.requester = "Autoplay";
    tracks.push(ready);
  }
  return { tracks, recommendations };
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string | undefined} uri
 */
async function resolveHarvestTrack(client, uri) {
  if (!uri?.startsWith("spotify:track:")) return null;
  try {
    const resolved = await client.spotify.resolve(uri);
    return resolved.tracks?.[0] ?? null;
  } catch (error) {
    logError("autoplay:resolve", error, { uri });
    return null;
  }
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
    if (playerBusy(player)) {
      debug("autoplay", "Manual playback took priority over recommendation");
      return true;
    }

    const seed = harvestSeed(player, state);
    const seedUri = seed?.info?.uri;
    /** @type {object[]} */
    let tracks = [];

    if (client.soloist?.enabled && state.soloistRecommendations !== false && seedUri?.startsWith("spotify:track:")) {
      try {
        await client.spotify.stop();
      } catch (error) {
        logError("autoplay:stop", error, { uri: seedUri });
      }
      if (playerBusy(player)) {
        debug("autoplay", "Manual playback took priority over recommendation");
        return true;
      }
      const recent = Array.isArray(state.recentTrackUris) ? state.recentTrackUris : [];
      const harvested = await harvestTracks(client, seed, recent, state);
      tracks = harvested.tracks;
      if (harvested.recommendations === false) state.soloistRecommendations = false;
      else if (tracks.length > 0) state.soloistRecommendations = true;
      debug("autoplay", `soloist harvest ${tracks.length} from ${seedUri}`);
    }

    if (tracks.length === 0 && !playerBusy(player)) {
      tracks = await findAutoplayTracks(client, player, state);
    }

    if (playerBusy(player)) {
      debug("autoplay", "Manual playback took priority over recommendation");
      return true;
    }
    if (tracks.length === 0) return false;

    for (const track of tracks) {
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

/**
 * @param {{ currentTrack?: unknown, isPlaying?: boolean, queue?: { length: number } }} player
 */
function playerBusy(player) {
  return Boolean(player.currentTrack || player.isPlaying || player.queue.length > 0);
}
