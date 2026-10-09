import { Events } from "discord.js";
import { refreshIdleTimer } from "../services/idleLeave.js";
import { getPlayer } from "../utils/voice.js";
import { getPlayerState } from "../utils/playerState.js";
import { clearSessionChannel, stopPlayback } from "../utils/playback.js";

export const name = Events.VoiceStateUpdate;

/**
 * @param {import("discord.js").VoiceState} oldState
 * @param {import("discord.js").VoiceState} newState
 * @param {import("../client.js").MusicBot} client
 */
export async function execute(oldState, newState, client) {
  const guildId = newState.guild.id;
  const botLeftVoice =
    newState.id === client.user?.id &&
    Boolean(oldState.channelId) &&
    newState.channelId !== oldState.channelId;

  if (botLeftVoice) {
    const state = getPlayerState(client, guildId);
    if (state.stopping) return;

    const player = getPlayer(client, guildId);
    const leftMusicChannel =
      !player ||
      !player.voiceChannel ||
      player.voiceChannel === oldState.channelId;

    if (!leftMusicChannel) return;

    if (player) {
      await stopPlayback(client, player);
    } else {
      await clearSessionChannel(client, guildId);
    }
    return;
  }

  const player = getPlayer(client, guildId);
  if (!player?.voiceChannel) return;

  const channelId = player.voiceChannel;
  const involved =
    oldState.channelId === channelId || newState.channelId === channelId;
  if (!involved) return;

  refreshIdleTimer(client, player);
}
