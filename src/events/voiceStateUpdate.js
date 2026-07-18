import { Events } from "discord.js";
import { refreshIdleTimer, clearIdleTimer } from "../services/idleLeave.js";
import { getPlayer } from "../utils/voice.js";

export const name = Events.VoiceStateUpdate;

/**
 * @param {import("discord.js").VoiceState} oldState
 * @param {import("discord.js").VoiceState} newState
 * @param {import("../client.js").MusicBot} client
 */
export async function execute(oldState, newState, client) {
  const guildId = newState.guild.id;
  const player = getPlayer(client, guildId);
  if (!player?.voiceChannel) return;

  const channelId = player.voiceChannel;
  const involved =
    oldState.channelId === channelId || newState.channelId === channelId;
  if (!involved) return;

  // Bot left voice somehow — drop the idle timer.
  if (
    newState.id === client.user?.id &&
    newState.channelId !== channelId &&
    oldState.channelId === channelId
  ) {
    clearIdleTimer(guildId);
    return;
  }

  refreshIdleTimer(client, player);
}
