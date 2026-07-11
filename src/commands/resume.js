import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getPlayer, requireVoiceChannel } from "../utils/voice.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";

export const data = new SlashCommandBuilder()
  .setName("resume")
  .setDescription("Resume playback if it was paused");

export async function execute(interaction, client) {
  const voice = requireVoiceChannel(interaction);
  if (!voice) {
    return interaction.reply({
      content: "Join a voice channel first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const player = getPlayer(client, interaction.guildId);
  if (!player || !player.currentTrack) {
    return interaction.reply({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!player.isPaused) {
    return interaction.reply({
      content: "Playback is not paused.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await player.pause(false);
  await updatePlayerPanel(client, player);

  return interaction.reply(`Resumed **${player.currentTrack.info.title}**.`);
}
