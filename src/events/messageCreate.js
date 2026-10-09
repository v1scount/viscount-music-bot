import { Events } from "discord.js";
import { getPlayer } from "../utils/voice.js";
import { getPlayerState } from "../utils/playerState.js";
import {
  isPlayerPanelMessage,
  schedulePanelRelocate,
} from "../utils/playerPanel.js";

export const name = Events.MessageCreate;

/**
 * @param {import("discord.js").Message} message
 * @param {import("../client.js").MusicBot} client
 */
export async function execute(message, client) {
  if (!message.guildId) return;

  const player = getPlayer(client, message.guildId);
  if (!player) return;

  const state = getPlayerState(client, message.guildId);
  if (state.stopping) return;

  const channelId = state.panelChannelId ?? player.textChannel;
  if (!channelId || message.channelId !== channelId) return;
  if (message.id === state.panelMessageId) return;
  if (isPlayerPanelMessage(message, client.user?.id)) return;

  schedulePanelRelocate(client, player);
}
