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

export function buildPlayerPanel(player, state, { disabled = false } = {}) {
  const track = player?.currentTrack ?? state.lastTrack;
  const active = Boolean(player?.currentTrack) && !disabled;
  const position = active ? player.position ?? 0 : 0;
  const duration = track?.info?.length ?? 0;
  const showPlay = disabled || (player?.isPaused && !state.stopped);

  const embed = new EmbedBuilder()
    .setColor(active ? 0x5865f2 : 0x747f8d)
    .setTitle(active ? "Now Playing" : "Playback Ended")
    .setDescription(
      track
        ? `**[${track.info.title}](${track.info.uri ?? "https://discord.com"})**\n${track.info.author}`
        : "Nothing is playing.",
    )
    .addFields(
      {
        name: "Progress",
        value: track?.info?.isStream
          ? "Live stream"
          : `${progressBar(position, duration)}\n\`${formatDuration(position)} / ${formatDuration(duration)}\``,
        inline: false,
      },
      {
        name: "Queue",
        value: `${player?.queue?.length ?? 0} track(s)`,
        inline: true,
      },
      {
        name: "Volume",
        value: `${player?.volume ?? 100}%`,
        inline: true,
      },
      {
        name: "Loop",
        value: player?.loop ?? "NONE",
        inline: true,
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
    embed.setThumbnail(track.info.artworkUrl);
  }

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}pause`)
      .setEmoji(showPlay ? "▶️" : "⏸️")
      .setLabel(showPlay ? "Play" : "Pause")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!active || Boolean(state.stopped)),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}skip`)
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}stop`)
      .setEmoji(state.stopped ? "▶️" : "⏹️")
      .setLabel(state.stopped ? "Play" : "Stop")
      .setStyle(state.stopped ? ButtonStyle.Success : ButtonStyle.Danger)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}loop`)
      .setEmoji("🔁")
      .setLabel(`Loop: ${player?.loop ?? "NONE"}`)
      .setStyle(ButtonStyle.Secondary)
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
  }
}
