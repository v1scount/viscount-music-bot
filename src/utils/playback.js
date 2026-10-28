import { clearIdleTimer } from "../services/idleLeave.js";
import { scheduleSave } from "../services/sessionStore.js";
import { logError } from "./logger.js";
import { clearBotMessages } from "./playerMessage.js";
import { clearPanelRefs, getPlayerState } from "./playerState.js";

/**
 * Delete the bot's messages in the session text channel and drop panel refs.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {string} guildId
 * @param {string | null | undefined} [fallbackChannelId]
 * @param {{ skipMessageIds?: Array<string | null | undefined> }} [options]
 */
export async function clearSessionChannel(
  client,
  guildId,
  fallbackChannelId,
  options = {},
) {
  const state = getPlayerState(client, guildId);
  const channelId = state.panelChannelId ?? fallbackChannelId;
  if (!channelId) {
    clearPanelRefs(state);
    return;
  }

  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));

  if (channel?.isTextBased() && !channel.isDMBased()) {
    try {
      await clearBotMessages(channel, client.user?.id, {
        extraIds: [state.panelMessageId, state.panelMessage?.id],
        skipIds: options.skipMessageIds,
        applicationId: client.application?.id ?? client.user?.id,
      });
    } catch (error) {
      logError("playback:clear", error, { guildId, channelId });
    }
  }

  clearPanelRefs(state);
}

/**
 * Clear the queue, wipe the bot's channel messages, destroy the player, and leave voice.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {{ guildId: string, textChannel?: string | null, queue: { clear: () => unknown }, destroy: () => Promise<void> | void }} player
 * @param {{ save?: boolean, skipMessageIds?: Array<string | null | undefined> }} [options]
 */
export async function stopPlayback(client, player, options = {}) {
  const { save = true, skipMessageIds = [] } = options;
  const guildId = player.guildId;
  const state = getPlayerState(client, guildId);
  if (state.stopping) return;
  state.stopping = true;

  try {
    try {
      player.queue.clear();
    } catch {
      // ignore
    }

    clearIdleTimer(guildId);

    const textChannelId = player.textChannel;

    try {
      await player.destroy();
    } catch (error) {
      logError("playback:destroy", error, { guildId });
    }

    await clearSessionChannel(client, guildId, textChannelId, {
      skipMessageIds,
    });

    if (save) {
      scheduleSave(client);
    }
  } finally {
    state.stopping = false;
  }
}
