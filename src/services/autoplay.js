import { config } from "../config.js";
import { debug, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";
import { getSimilarTracks } from "./lastFm.js";

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

function rotateCandidates(candidates, random = Math.random) {
  if (candidates.length < 2) return candidates;
  const topRange = Math.min(5, candidates.length);
  const offset = Math.floor(random() * topRange);
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}

async function resolveCandidate(client, player, state, candidate) {
  const result = await client.poru.resolve({
    query: `${candidate.artist} - ${candidate.title}`,
    source: "ytmsearch",
    requester: "Autoplay",
  });

  if (["error", "empty"].includes(result.loadType)) return null;
  return (result.tracks ?? []).find((track) => !isRecent(state, track)) ?? null;
}

async function resolveFallback(client, player, state, seed) {
  const result = await client.poru.resolve({
    query: `${seed.info.author} radio similar songs`,
    source: "ytmsearch",
    requester: "Autoplay",
  });

  if (["error", "empty"].includes(result.loadType)) return null;
  return (result.tracks ?? []).find((track) => !isRecent(state, track)) ?? null;
}

export async function findAutoplayTrack(client, player, state, random = Math.random) {
  const seed = state.lastTrack ?? player.previousTrack;
  if (!seed) return null;

  try {
    const candidates = await getSimilarTracks({
      apiKey: config.lastfm.apiKey,
      artist: seed.info.author,
      title: seed.info.title,
    });

    for (const candidate of rotateCandidates(candidates, random)) {
      const track = await resolveCandidate(client, player, state, candidate);
      if (track) return track;
    }
  } catch (error) {
    logError("autoplay:lastfm", error, {
      title: seed.info.title,
      artist: seed.info.author,
    });
  }

  debug("autoplay", "Using YouTube Music fallback");
  return resolveFallback(client, player, state, seed);
}

export async function startAutoplay(client, player) {
  const state = getPlayerState(client, player.guildId);
  if (!state.autoplay || state.autoplayPending) return false;

  state.autoplayPending = true;
  try {
    const track = await findAutoplayTrack(client, player, state);
    if (!track) return false;

    if (player.currentTrack || player.isPlaying || player.queue.length > 0) {
      debug("autoplay", "Manual playback took priority over recommendation");
      return true;
    }

    track.info.requester = "Autoplay";
    player.queue.add(track);
    await player.play();
    player.isAutoPlay = true;
    return true;
  } finally {
    state.autoplayPending = false;
  }
}
