import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatDuration } from "./voice.js";

export const QUEUE_COMPONENT_PREFIX = "music_queue:";
const PAGE_SIZE = 10;

function requesterLabel(requester) {
  if (!requester) return "Unknown";
  if (typeof requester === "string") return requester;
  return requester.id ? `<@${requester.id}>` : requester.username ?? "Unknown";
}

export function buildQueueView(player, requestedPage = 0) {
  const pageCount = Math.max(1, Math.ceil(player.queue.length / PAGE_SIZE));
  const page = Math.min(pageCount - 1, Math.max(0, requestedPage));
  const start = page * PAGE_SIZE;
  const tracks = player.queue.slice(start, start + PAGE_SIZE);
  const totalDuration = player.queue.reduce(
    (sum, track) => sum + (Number.isFinite(track.info.length) ? track.info.length : 0),
    0,
  );

  const description = tracks.length
    ? tracks
        .map(
          (track, index) =>
            `\`${start + index + 1}.\` **${track.info.title}** — ${track.info.author}\n` +
            `\`${formatDuration(track.info.length)}\` · ${requesterLabel(track.info.requester)}`,
        )
        .join("\n\n")
    : "No upcoming tracks.";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Music Queue")
    .setDescription(description)
    .addFields({
      name: "Now playing",
      value: player.currentTrack
        ? `**${player.currentTrack.info.title}** — ${player.currentTrack.info.author}`
        : "Nothing",
    })
    .setFooter({
      text: `${player.queue.length} upcoming · ${formatDuration(totalDuration)} · Page ${page + 1}/${pageCount}`,
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_COMPONENT_PREFIX}prev:${page}`)
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${QUEUE_COMPONENT_PREFIX}next:${page}`)
      .setEmoji("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );

  return { embeds: [embed], components: [row] };
}
