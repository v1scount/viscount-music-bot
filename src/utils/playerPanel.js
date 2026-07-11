import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { FILTER_NAMES } from "./filters.js";
import { logError } from "./logger.js";
import { getPlayerState } from "./playerState.js";
import { progressBar } from "./time.js";
import { formatDuration } from "./voice.js";

export const PLAYER_COMPONENT_PREFIX = "music:";

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
        name: "Filter",
        value: FILTER_NAMES[state.filter] ?? "Off",
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
      .setEmoji(player?.isPaused ? "▶️" : "⏸️")
      .setLabel(player?.isPaused ? "Resume" : "Pause")
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

  const filters = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PLAYER_COMPONENT_PREFIX}filter`)
      .setPlaceholder("Choose an audio filter")
      .setDisabled(!active)
      .addOptions(
        Object.entries(FILTER_NAMES).map(([value, label]) => ({
          label,
          value,
          default: state.filter === value,
        })),
      ),
  );

  return { embeds: [embed], components: [controls, filters] };
}

export async function updatePlayerPanel(client, player, options = {}) {
  const state = getPlayerState(client, player.guildId);
  const channelId = player.textChannel ?? state.panelChannelId;
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

  try {
    if (message) {
      await message.edit(payload);
    } else {
      message = await channel.send(payload);
      state.panelMessageId = message.id;
      state.panelChannelId = channelId;
    }
    state.panelMessage = message;
    state.lastPanelUpdateAt = Date.now();
    return message;
  } catch (error) {
    logError("playerPanel", error, { guildId: player.guildId, channelId });
    return null;
  }
}
