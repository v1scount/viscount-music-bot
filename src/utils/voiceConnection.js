import { PermissionFlagsBits } from "discord.js";
import { GuildPlayer, otherActiveGuild } from "../player/guildPlayer.js";
import { log } from "./logger.js";

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} voiceChannelId
 */
export function assertCanJoinVoice(guild, voiceChannelId) {
  const channel = guild.channels.cache.get(voiceChannelId);
  if (!channel || !channel.isVoiceBased()) {
    return "That voice channel is not available to me.";
  }

  const me = guild.members.me;
  if (!me) {
    return "I am not a member of this server yet.";
  }

  const permissions = channel.permissionsFor(me);
  if (!permissions) {
    return "I can't resolve permissions for that voice channel.";
  }

  if (!permissions.has(PermissionFlagsBits.ViewChannel)) {
    return `I need **View Channel** in ${channel}.`;
  }
  if (!permissions.has(PermissionFlagsBits.Connect)) {
    return `I need **Connect** in ${channel}.`;
  }
  if (!permissions.has(PermissionFlagsBits.Speak)) {
    return `I need **Speak** in ${channel}.`;
  }

  return null;
}

/**
 * @param {GuildPlayer} player
 */
export async function waitForVoiceConnection(player) {
  await player.connectVoice();
  log("voice", `Connected to voice for guild ${player.guildId}`);
}

/**
 * Create or refresh the guild player and join its voice channel.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {{ guildId: string, voiceChannelId: string, textChannelId: string }} options
 */
export function ensurePlayer(client, options) {
  let player = client.players.get(options.guildId) ?? null;
  if (!player || player.destroyed) {
    player = new GuildPlayer(client, options.guildId);
    client.players.set(options.guildId, player);
  }

  player.textChannel = options.textChannelId;
  player.voiceChannel = options.voiceChannelId;
  return player;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} guildId
 */
export function streamBusyMessage(client, guildId) {
  const other = otherActiveGuild(client, guildId);
  if (!other) return null;
  return "I'm already streaming in another server. One Spotify account can only play one thing at a time.";
}
