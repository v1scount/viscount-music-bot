import { PermissionFlagsBits } from "discord.js";
import { debug, log } from "./logger.js";

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
 * Ensure Discord has accepted the bot into the voice channel and Lavalink has
 * the full voice payload (Poru can race STATE vs SERVER updates).
 *
 * @param {import("poru").Player} player
 * @param {number} [timeoutMs]
 */
export async function waitForVoiceConnection(player, timeoutMs = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const voice = player.connection?.voice;
    const ready =
      Boolean(voice?.sessionId) &&
      Boolean(voice?.token) &&
      Boolean(voice?.endpoint);

    debug("voiceWait", {
      sessionId: voice?.sessionId ?? null,
      hasToken: Boolean(voice?.token),
      endpoint: voice?.endpoint ?? null,
      elapsedMs: Date.now() - started,
    });

    if (ready) {
      // Re-send complete voice state in case SERVER arrived before STATE.
      await player.node.rest.updatePlayer({
        guildId: player.guildId,
        data: {
          voice: {
            token: voice.token,
            endpoint: voice.endpoint,
            sessionId: voice.sessionId,
          },
        },
      });
      log(
        "voice",
        `Connected to voice for guild ${player.guildId} (${voice.endpoint})`,
      );
      return voice;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const voice = player.connection?.voice;
  throw new Error(
    `Timed out joining voice channel (sessionId=${voice?.sessionId ?? "null"}, endpoint=${voice?.endpoint ?? "null"}). Check Connect/Speak permissions and that OP4 voice updates are reaching Discord.`,
  );
}

/**
 * Create or refresh a Poru player and request a Discord voice join.
 *
 * @param {import("../client.js").MusicBot} client
 * @param {{ guildId: string, voiceChannelId: string, textChannelId: string }} options
 */
export function ensurePlayer(client, options) {
  let player = client.poru.players.get(options.guildId) ?? null;

  if (!player) {
    player = client.poru.createConnection({
      guildId: options.guildId,
      voiceChannel: options.voiceChannelId,
      textChannel: options.textChannelId,
      deaf: true,
      mute: false,
    });
    return player;
  }

  player.textChannel = options.textChannelId;

  // Re-joining on every /play interrupts Lavalink and can clear currentTrack,
  // which then makes the next play() replace instead of queue.
  const needsReconnect =
    player.voiceChannel !== options.voiceChannelId || !player.isConnected;

  if (needsReconnect) {
    player.voiceChannel = options.voiceChannelId;
    player.connect({
      guildId: options.guildId,
      voiceChannel: options.voiceChannelId,
      deaf: true,
      mute: false,
    });
  }

  return player;
}
