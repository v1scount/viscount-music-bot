import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatDuration, getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Show the current track and upcoming queue");

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);

  if (!player || (!player.currentTrack && player.queue.length === 0)) {
    return interaction.reply({
      content: "The queue is empty.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = [];

  if (player.currentTrack) {
    const current = player.currentTrack;
    lines.push(
      `**Now playing:** ${current.info.title} \`${formatDuration(current.info.length)}\``,
    );
  }

  if (player.queue.length > 0) {
    const upcoming = player.queue
      .slice(0, 10)
      .map(
        (track, index) =>
          `\`${index + 1}.\` ${track.info.title} \`${formatDuration(track.info.length)}\``,
      )
      .join("\n");

    lines.push("", "**Up next:**", upcoming);

    if (player.queue.length > 10) {
      lines.push(`\n…and ${player.queue.length - 10} more`);
    }
  }

  return interaction.reply(lines.join("\n"));
}
