import { startAutoplay } from "../../services/autoplay.js";
import { debug, logError } from "../../utils/logger.js";
import { updatePlayerPanel } from "../../utils/playerPanel.js";
import { getPlayerState } from "../../utils/playerState.js";
import { sendPlayerMessage } from "../../utils/playerMessage.js";

export const name = "queueEnd";

export async function execute(player, client) {
  // Poru emits queueEnd on TrackEnd reason "replaced" when the queue is empty
  // *after* shifting the replacement track — even though that track is already
  // playing. Destroying here would kill the song that just started.
  if (player.currentTrack || player.isPlaying) {
    debug("queueEnd", "Ignoring false queueEnd — a track is still active", {
      title: player.currentTrack?.info?.title ?? null,
      isPlaying: player.isPlaying,
      queueLength: player.queue.length,
    });
    return;
  }

  const state = getPlayerState(client, player.guildId);
  if (state.autoplay) {
    try {
      const started = await startAutoplay(client, player);
      if (started) return;
    } catch (error) {
      logError("queueEnd:autoplay", error, { guildId: player.guildId });
    }
  }

  await sendPlayerMessage(
    client,
    player.textChannel,
    "Queue ended — leaving the voice channel.",
  );

  await updatePlayerPanel(client, player, { disabled: true });

  try {
    await player.destroy();
  } catch (error) {
    logError("queueEnd:destroy", error);
  }
}
