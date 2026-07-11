import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("volume")
  .setDescription("Change the playback volume")
  .addIntegerOption((option) =>
    option
      .setName("level")
      .setDescription("Volume from 0 to 100")
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player) {
    return interaction.reply({
      content: "There is no active player.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const level = interaction.options.getInteger("level", true);
  await player.setVolume(level);
  await updatePlayerPanel(client, player);
  return interaction.reply(`Volume set to **${level}%**.`);
}
