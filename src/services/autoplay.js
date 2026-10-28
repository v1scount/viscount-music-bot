import { debug, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ lastTrack?: object | null, recentTrackKeys?: string[] }} state
 * @param {() => number} [random]
 */
export async function findAutoplayTrack(client, player, state, random = Math.random) {
  const seed = state.lastTrack ?? player.previousTrack;
  const uri = seed?.info?.uri;
  if (!uri?.startsWith("spotify:track:")) return null;

  let result;
  try {
    result = await client.spotify.radio(uri);
  } catch (error) {
    logError("autoplay:radio", error, {
      title: seed.info?.title,
      artist: seed.info?.author,
    });
    return null;
  }

  const candidates = (result.tracks ?? []).filter((track) => {
    if (!track?.info?.uri || track.info.uri === uri) return false;
    if (track.info.identifier && track.info.identifier === seed.info?.identifier) {
      return false;
    }
    return !isRecent(state, track);
  });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)];
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
