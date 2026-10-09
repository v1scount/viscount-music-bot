import { PermissionFlagsBits } from "discord.js";
import { debug, logError } from "./logger.js";

const CLEAR_PAGE_SIZE = 100;
const CLEAR_MAX_PAGES = 10;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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

/**
 * True for messages this bot posted, including interaction webhook replies.
 *
 * @param {{ author?: { id?: string }, applicationId?: string | null } | null | undefined} message
 * @param {string} botUserId
 * @param {string | null | undefined} [applicationId]
 */
export function isOwnBotMessage(message, botUserId, applicationId) {
  if (!message || !botUserId) return false;
  if (message.author?.id === botUserId) return true;
  const appId = applicationId ?? botUserId;
  return Boolean(appId && message.applicationId === appId);
}

/**
 * Delete this bot's messages in a text channel so the next session starts clean.
 * Always wipes the local cache and known IDs; history fetch is best-effort.
 *
 * @param {import("discord.js").GuildTextBasedChannel} channel
 * @param {string | null | undefined} botUserId
 * @param {{ extraIds?: Array<string | null | undefined>, skipIds?: Array<string | null | undefined>, applicationId?: string | null }} [options]
 */
export async function clearBotMessages(channel, botUserId, options = {}) {
  if (!channel?.isTextBased() || channel.isDMBased() || !botUserId) return;

  const applicationId = options.applicationId ?? botUserId;
  const extraIds = [...new Set((options.extraIds ?? []).filter(Boolean))];
  const skipIds = new Set((options.skipIds ?? []).filter(Boolean));

  const me = channel.guild?.members?.me;
  const permissions =
    typeof channel.permissionsFor === "function"
      ? channel.permissionsFor(me ?? botUserId)
      : null;
  const canBulk = Boolean(permissions?.has(PermissionFlagsBits.ManageMessages));
  const canFetch =
    !permissions || permissions.has(PermissionFlagsBits.ViewChannel);
  const bulkCutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;

  /** @type {Map<string, object>} */
  const mine = new Map();

  /**
   * @param {object | null | undefined} message
   */
  const consider = (message) => {
    if (!message?.id || mine.has(message.id) || skipIds.has(message.id)) return;
    if (!isOwnBotMessage(message, botUserId, applicationId)) return;
    mine.set(message.id, message);
  };

  const cache = channel.messages?.cache;
  if (cache && typeof cache.values === "function") {
    for (const message of cache.values()) consider(message);
  }

  for (const id of extraIds) {
    consider(cache?.get?.(id));
  }

  if (canFetch && typeof channel.messages?.fetch === "function") {
    try {
      let before;
      for (let page = 0; page < CLEAR_MAX_PAGES; page += 1) {
        /** @type {{ limit: number, before?: string }} */
        const fetchOptions = { limit: CLEAR_PAGE_SIZE };
        if (before) fetchOptions.before = before;

        const batch = await channel.messages.fetch(fetchOptions);
        if (!batch) break;
        const messages = [...batch.values()];
        if (messages.length === 0) break;

        before = messages[messages.length - 1].id;
        for (const message of messages) consider(message);
        if (messages.length < CLEAR_PAGE_SIZE) break;
      }
    } catch (error) {
      debug(
        "playerMessage",
        `History fetch failed in ${channel.id}; deleting cached messages only`,
      );
      logError("playerMessage:clear", error, { channelId: channel.id });
    }
  }

  await deleteOwnMessages(channel, [...mine.values()], canBulk, bulkCutoff);

  if (typeof channel.messages?.delete === "function") {
    await Promise.allSettled(
      extraIds
        .filter((id) => !mine.has(id) && !skipIds.has(id))
        .map((id) => channel.messages.delete(id)),
    );
  }

  debug("playerMessage", `Cleared ${mine.size} bot message(s) in ${channel.id}`);
}

/**
 * @param {import("discord.js").GuildTextBasedChannel} channel
 * @param {object[]} messages
 * @param {boolean} canBulk
 * @param {number} bulkCutoff
 */
async function deleteOwnMessages(channel, messages, canBulk, bulkCutoff) {
  if (messages.length === 0) return;

  const deletable = messages.filter((message) => typeof message.delete === "function");
  const byId = messages.filter(
    (message) => typeof message.delete !== "function" && message.id,
  );

  if (!canBulk) {
    await Promise.allSettled(deletable.map((message) => message.delete()));
  } else {
    const bulkable = [];
    const individual = [];
    for (const message of deletable) {
      if ((message.createdTimestamp ?? Date.now()) > bulkCutoff) {
        bulkable.push(message);
      } else {
        individual.push(message);
      }
    }

    while (bulkable.length >= 2) {
      const chunk = bulkable.splice(0, 100);
      try {
        await channel.bulkDelete(chunk);
      } catch {
        await Promise.allSettled(chunk.map((message) => message.delete()));
      }
    }

    individual.push(...bulkable);
    await Promise.allSettled(individual.map((message) => message.delete()));
  }

  if (typeof channel.messages?.delete === "function") {
    await Promise.allSettled(byId.map((message) => channel.messages.delete(message.id)));
  }
}
