import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { parseDuration } from "../utils/time.js";
import { formatDuration, getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("seek")
  .setDescription("Jump to a position in the current track")
  .addStringOption((option) =>
    option
      .setName("position")
      .setDescription("Seconds, mm:ss, or hh:mm:ss")
      .setRequired(true),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player?.currentTrack) {
    return interaction.reply({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (player.currentTrack.info.isStream) {
    return interaction.reply({
      content: "Live streams cannot be seeked.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const rawPosition = interaction.options.getString("position", true);
  const position = parseDuration(rawPosition);
  if (position === null || position >= player.currentTrack.info.length) {
    return interaction.reply({
      content: `Enter a valid position before ${formatDuration(player.currentTrack.info.length)}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await player.seekTo(position);
  player.position = position;
  await updatePlayerPanel(client, player);
  return interaction.reply(`Jumped to **${formatDuration(position)}**.`);
}
