import { config } from "../config.js";
import { debug, log } from "../utils/logger.js";

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

/**
 * @param {string} guildId
 */
export function clearIdleTimer(guildId) {
  const existing = timers.get(guildId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(guildId);
  }
}

/**
 * @param {import("discord.js").VoiceChannel | import("discord.js").StageChannel | null | undefined} channel
 */
export function isBotAlone(channel) {
  if (!channel) return false;
  return channel.members.filter((member) => !member.user.bot).size === 0;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {import("poru").Player} player
 */
export function refreshIdleTimer(client, player) {
  const guildId = player.guildId;
  const channelId = player.voiceChannel;
  if (!channelId) {
    clearIdleTimer(guildId);
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) {
    clearIdleTimer(guildId);
    return;
  }

  if (!isBotAlone(channel)) {
    clearIdleTimer(guildId);
    return;
  }

  if (timers.has(guildId)) return;

  const delay = config.idleLeaveMs;
  debug("idleLeave", `Starting ${delay}ms timer for guild ${guildId}`);

  const timer = setTimeout(async () => {
    timers.delete(guildId);
    const current = client.poru.players.get(guildId);
    if (!current) return;

    const voiceChannel = client.guilds.cache
      .get(guildId)
      ?.channels.cache.get(current.voiceChannel);
    if (!voiceChannel?.isVoiceBased() || !isBotAlone(voiceChannel)) {
      return;
    }

    log("idleLeave", `Leaving empty voice channel in guild ${guildId}`);
    const { stopPlayback } = await import("../utils/playback.js");
    await stopPlayback(client, current);
  }, delay);

  timers.set(guildId, timer);
}

/**
 * Clear all idle timers (shutdown).
 */
export function clearAllIdleTimers() {
  for (const guildId of timers.keys()) {
    clearIdleTimer(guildId);
  }
}
