import { debug, log } from "./logger.js";

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {{ member: import("discord.js").GuildMember | import("discord.js").APIInteractionGuildMember, voiceChannelId: string, guild: import("discord.js").Guild } | null}
 */
export function requireVoiceChannel(interaction) {
  if (!interaction.inGuild() || !interaction.member) {
    return null;
  }

  const guild =
    interaction.guild ??
    interaction.client.guilds.cache.get(interaction.guildId);

  if (!guild) {
    debug("voice", {
      reason: "guild-not-cached",
      guildId: interaction.guildId,
      cachedGuilds: interaction.client.guilds.cache.size,
      cachedGuildIds: [...interaction.client.guilds.cache.keys()],
    });
    log(
      "voice",
      `Guild ${interaction.guildId} is not in cache (${interaction.client.guilds.cache.size} guilds cached). Re-invite the bot with the bot scope + Connect/Speak.`,
    );
    return null;
  }

  const fromCache = guild.voiceStates.cache.get(interaction.user.id);
  const fromMember =
    "voice" in interaction.member ? interaction.member.voice : null;

  const voiceChannelId =
    fromCache?.channelId ?? fromMember?.channelId ?? null;

  debug("voice", {
    guildId: guild.id,
    userId: interaction.user.id,
    voiceChannelId,
    voiceStatesCached: guild.voiceStates.cache.size,
  });

  if (!voiceChannelId) {
    return null;
  }

  return { member: interaction.member, voiceChannelId, guild };
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} guildId
 */
export function getPlayer(client, guildId) {
  return client.poru.players.get(guildId) ?? null;
}

/**
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "Live";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
