import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getPlayer, requireVoiceChannel } from "../utils/voice.js";
import { stopPlayback } from "../utils/playback.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop playback, clear the queue, and leave the voice channel");

export async function execute(interaction, client) {
  const voice = requireVoiceChannel(interaction);
  if (!voice) {
    return interaction.reply({
      content: "Join a voice channel first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const player = getPlayer(client, interaction.guildId);
  if (!player) {
    return interaction.reply({
      content: "I'm not connected in this server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await stopPlayback(client, player);

  return interaction.reply("Stopped playback and left the voice channel.");
}
