import { debug, logError } from "../utils/logger.js";
import { getPlayerState, trackKeys } from "../utils/playerState.js";

function isRecent(state, track) {
  return trackKeys(track).some((key) => state.recentTrackKeys.includes(key));
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {{ previousTrack?: object | null }} player
 * @param {{ autoplaySeed?: object | null, autoplayCount?: number, lastTrack?: object | null, recentArtistIds?: string[], recentTrackKeys?: string[], recentTrackUris?: string[] }} state
 */
export async function findAutoplayTrack(client, player, state) {
  const anchor = state.autoplaySeed ?? state.lastTrack ?? player.previousTrack;
  const anchorUri = anchor?.info?.uri;
  if (!anchorUri?.startsWith("spotify:track:")) return null;

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
    return null;
  }

  const candidates = (result.tracks ?? []).filter((track) => {
    if (!track?.info?.uri || track.info.uri === anchorUri) return false;
    if (track.info.identifier && track.info.identifier === anchor.info?.identifier) {
      return false;
    }
    return !isRecent(state, track);
  });
  return candidates[0] ?? null;
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
