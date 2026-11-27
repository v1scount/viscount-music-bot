import { debug, log, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

const RESOLVE_ATTEMPTS = 50;
const STATION_LIMIT = 12;

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

function isBlocked(state, candidate, blockedUris = new Set()) {
  return (
    blockedUris.has(candidate.uri) ||
    state.recentTrackUris.includes(candidate.uri) ||
    state.recentTrackKeys.includes(candidate.spotifyId.toLowerCase())
  );
}

function cloneTrack(track) {
  return { info: { ...track.info } };
}

async function takeResolved(client, state, outcome, blockedUris) {
  let tried = 0;
  while (state.autoplayBuffer.length > 0 && tried < RESOLVE_ATTEMPTS) {
    const candidate = state.autoplayBuffer.shift();
    if (isBlocked(state, candidate, blockedUris)) continue;
    tried += 1;

    let result;
    try {
      result = await client.spotify.resolve(candidate.uri);
    } catch (error) {
      state.autoplayBuffer.unshift(candidate);
      outcome.failed = true;
      logError("autoplay:resolve", error, {
        title: candidate.title,
        artist: candidate.artist,
      });
      return null;
    }

    const match = (result?.tracks ?? []).find(
      (track) =>
        track?.info?.uri === candidate.uri ||
        track?.info?.identifier === candidate.spotifyId,
    );
    if (!match || isRecent(state, match)) continue;
    return Object.assign(cloneTrack(match), { autoplaySource: candidate });
  }
  return null;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ autoplaySeed?: object | null, autoplayBuffer?: object[], lastTrack?: object | null, recentTrackKeys?: string[], recentTrackUris?: string[] }} state
 * @param {Set<string>} [blockedUris]
 * @param {{ remaining: number }} [fetchBudget]
 */
export async function findAutoplayTrack(
  client,
  player,
  state,
  blockedUris = new Set(),
  fetchBudget = { remaining: Number.POSITIVE_INFINITY },
) {
  const anchor = state.autoplaySeed ?? state.lastTrack ?? player.previousTrack;
  if (!anchor?.info?.uri?.startsWith("spotify:track:") || !client.reccobeats) {
    return null;
  }
  if (!Array.isArray(state.autoplayBuffer)) state.autoplayBuffer = [];
  if (!Array.isArray(state.recentTrackKeys)) state.recentTrackKeys = [];
  if (!Array.isArray(state.recentTrackUris)) state.recentTrackUris = [];

  const outcome = { failed: false };
  const ready = await takeResolved(client, state, outcome, blockedUris);
  if (ready || outcome.failed || state.autoplayBuffer.length > 0) return ready;
  if (fetchBudget.remaining <= 0) return null;
  fetchBudget.remaining -= 1;

  let result;
  try {
    result = await client.reccobeats.recommendations(
      anchor,
      state.recentTrackUris,
    );
  } catch (error) {
    logError("autoplay:reccobeats", error, {
      title: anchor.info?.title,
      artist: anchor.info?.author,
    });
    return null;
  }

  state.autoplayBuffer = result.tracks.filter(
    (candidate) => !isBlocked(state, candidate, blockedUris),
  );
  log(
    "autoplay",
    `ReccoBeats returned ${state.autoplayBuffer.length} tracks for "${anchor.info?.title ?? anchor.info?.uri}"` +
      (result.targetPopularity === null
        ? ""
        : ` at popularity ${result.targetPopularity}±10`) +
      (result.genre ? `, genre ${result.genre}` : "") +
      (result.excludedArtist ? " after excluding the seed artist" : ""),
  );
  return takeResolved(client, state, outcome, blockedUris);
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
    const tracks = [];
    const blockedUris = new Set();
    const fetchBudget = { remaining: 1 };
    while (tracks.length < STATION_LIMIT) {
      const track = await findAutoplayTrack(
        client,
        player,
        state,
        blockedUris,
        fetchBudget,
      );
      if (!track) break;
      tracks.push(track);
      blockedUris.add(track.info.uri);
    }
    if (tracks.length === 0) return false;

    if (player.currentTrack || player.isPlaying || player.queue.length > 0) {
      for (const track of tracks.reverse()) {
        if (track.autoplaySource) {
          state.autoplayBuffer.unshift(track.autoplaySource);
        }
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
