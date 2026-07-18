import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { logError } from "./logger.js";
import { getPlayerState } from "./playerState.js";
import { progressBar } from "./time.js";
import { formatDuration } from "./voice.js";
import { colors } from "./theme.js";

export const PLAYER_COMPONENT_PREFIX = "music:";

function isPlayerPanelMessage(message, botUserId) {
  if (message.author?.id !== botUserId) return false;
  return message.components?.some((row) =>
    row.components?.some((component) =>
      component.customId?.startsWith(PLAYER_COMPONENT_PREFIX),
    ),
  );
}

async function cleanupOldPanels(channel, client, keepMessageId) {
  const messages = await channel.messages
    .fetch({ limit: 50 })
    .catch(() => null);
  if (!messages) return;

  const duplicates = [...messages.values()].filter(
    (message) =>
      message.id !== keepMessageId &&
      isPlayerPanelMessage(message, client.user?.id),
  );
  await Promise.allSettled(duplicates.map((message) => message.delete()));
}

function requesterLabel(requester) {
  if (!requester) return "Unknown";
  if (typeof requester === "string") return requester;
  if (requester.id) return `<@${requester.id}>`;
  return requester.username ?? requester.tag ?? "Unknown";
}

function sourceLabel(track) {
  const raw = track?.info?.sourceName;
  if (!raw) return "Unknown";
  return String(raw).charAt(0).toUpperCase() + String(raw).slice(1);
}

export function buildPlayerPanel(player, state, { disabled = false } = {}) {
  const track = player?.currentTrack ?? state.lastTrack;
  const active = Boolean(player?.currentTrack) && !disabled;
  const position = active ? player.position ?? 0 : 0;
  const duration = track?.info?.length ?? 0;
  const showPlay = Boolean(player?.isPaused);
  const next = player?.queue?.[0];

  const descriptionParts = [];
  if (track) {
    descriptionParts.push(
      `**[${track.info.title}](${track.info.uri ?? "https://discord.com"})**`,
      track.info.author,
      `Source · ${sourceLabel(track)}`,
    );
  } else {
    descriptionParts.push("Nothing is playing.");
  }
  if (next) {
    descriptionParts.push("", `Up next · **${next.info.title}** — ${next.info.author}`);
  }

  const embed = new EmbedBuilder()
    .setColor(active ? colors.active : colors.ended)
    .setTitle(active ? "Now Playing" : "Playback Ended")
    .setDescription(descriptionParts.join("\n"))
    .addFields(
      {
        name: "Progress",
        value: track?.info?.isStream
          ? "Live stream"
          : `${progressBar(position, duration)}\n\`${formatDuration(position)} / ${formatDuration(duration)}\``,
        inline: false,
      },
      {
        name: "Autoplay",
        value: state.autoplay ? "ON" : "OFF",
        inline: true,
      },
      {
        name: "Requested by",
        value: requesterLabel(track?.info?.requester),
        inline: true,
      },
    )
    .setFooter({ text: "Controls update this message automatically" })
    .setTimestamp();

  if (track?.info?.artworkUrl) {
    embed.setImage(track.info.artworkUrl);
  }

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}pause`)
      .setEmoji(showPlay ? "▶️" : "⏸️")
      .setLabel(showPlay ? "Play" : "Pause")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}skip`)
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}stop`)
      .setEmoji("⏹️")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}autoplay`)
      .setEmoji("♾️")
      .setLabel(`Autoplay: ${state.autoplay ? "ON" : "OFF"}`)
      .setStyle(state.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled),
  );

  return { embeds: [embed], components: [controls] };
}

export async function updatePlayerPanel(client, player, options = {}) {
  const state = getPlayerState(client, player.guildId);
  const previousUpdate = state.panelUpdatePromise ?? Promise.resolve();
  const updatePromise = previousUpdate.catch(() => null).then(async () => {
    const channelId = state.panelChannelId ?? player.textChannel;
    if (!channelId) return null;

    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased() || channel.isDMBased()) return null;

    const payload = buildPlayerPanel(player, state, options);
    let message =
      state.panelMessage?.channelId === channelId ? state.panelMessage : null;

    if (!message && state.panelMessageId && state.panelChannelId === channelId) {
      message = await channel.messages
        .fetch(state.panelMessageId)
        .catch(() => null);
    }

    if (message) {
      await message.edit(payload);
    } else {
      message = await channel.send(payload);
      state.panelMessageId = message.id;
      state.panelChannelId = channelId;
      await cleanupOldPanels(channel, client, message.id);
    }
    state.panelMessage = message;
    state.lastPanelUpdateAt = Date.now();
    return message;
  });

  state.panelUpdatePromise = updatePromise;

  try {
    return await updatePromise;
  } catch (error) {
    logError("playerPanel", error, { guildId: player.guildId });
    return null;
  } finally {
    if (state.panelUpdatePromise === updatePromise) {
      state.panelUpdatePromise = null;
    }
    if (!options.disabled) {
      import("../services/sessionStore.js")
        .then(({ scheduleSave }) => scheduleSave(client))
        .catch(() => null);
    }
  }
}
