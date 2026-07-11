import { debug, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

export function buildYoutubeMixUrl(identifier) {
  return `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`;
}

async function resolveYoutubeSeed(client, seed) {
  const source = seed.info.sourceName?.toLowerCase();
  const uri = seed.info.uri ?? "";
  if (
    seed.info.identifier &&
    (source === "youtube" || /(?:youtube\.com|youtu\.be)/i.test(uri))
  ) {
    return seed;
  }

  const result = await client.poru.resolve({
    query: `${seed.info.author} - ${seed.info.title}`,
    source: "ytmsearch",
    requester: "Autoplay",
  });

  if (["error", "empty"].includes(result.loadType)) return null;
  return result.tracks?.[0] ?? null;
}

async function resolveMix(client, state, youtubeSeed, random = Math.random) {
  const result = await client.poru.resolve({
    query: buildYoutubeMixUrl(youtubeSeed.info.identifier),
    requester: "Autoplay",
  });

  if (["error", "empty"].includes(result.loadType)) return null;
  const candidates = (result.tracks ?? []).filter(
    (track) =>
      track.info.identifier !== youtubeSeed.info.identifier &&
      !isRecent(state, track),
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)];
}

async function resolveFallback(client, state, seed) {
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
    const youtubeSeed = await resolveYoutubeSeed(client, seed);
    if (youtubeSeed) {
      const track = await resolveMix(client, state, youtubeSeed, random);
      if (track) return track;
    }
  } catch (error) {
    logError("autoplay:youtube-mix", error, {
      title: seed.info.title,
      artist: seed.info.author,
    });
  }

  debug("autoplay", "Using YouTube Music search fallback");
  return resolveFallback(client, state, seed);
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
