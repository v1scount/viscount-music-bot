import { PermissionFlagsBits } from "discord.js";
import { debug, logError } from "./logger.js";

/**
 * @param {import("discord.js").Client} client
 * @param {string | null | undefined} channelId
 */
export async function sendPlayerMessage(client, channelId, content) {
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const me = channel.guild?.members.me;
  if (!me) return;

  const canSend = channel
    .permissionsFor(me)
    ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

  if (!canSend) {
    debug(
      "playerMessage",
      `Skipping message in ${channelId}: missing View Channel / Send Messages`,
    );
    return;
  }

  try {
    await channel.send(content);
  } catch (error) {
    logError("playerMessage", error, { channelId });
  }
}
