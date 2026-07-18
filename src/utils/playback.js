import { updatePlayerPanel } from "./playerPanel.js";
import { scheduleSave } from "../services/sessionStore.js";
import { clearIdleTimer } from "../services/idleLeave.js";
import { logError } from "./logger.js";

/**
 * Clear the queue, disable the panel, destroy the player, and leave voice.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {import("poru").Player} player
 * @param {{ save?: boolean }} [options]
 */
export async function stopPlayback(client, player, options = {}) {
  const { save = true } = options;
  const guildId = player.guildId;

  try {
    player.queue.clear();
  } catch {
    // ignore
  }

  clearIdleTimer(guildId);

  try {
    await updatePlayerPanel(client, player, { disabled: true });
  } catch (error) {
    logError("playback:panel", error, { guildId });
  }

  try {
    await player.destroy();
  } catch (error) {
    logError("playback:destroy", error, { guildId });
  }

  if (save) {
    scheduleSave(client);
  }
}
