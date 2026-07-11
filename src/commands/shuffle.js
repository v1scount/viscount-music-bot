import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("shuffle")
  .setDescription("Shuffle the upcoming queue");

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player || player.queue.length < 2) {
    return interaction.reply({
      content: "At least two upcoming tracks are required.",
      flags: MessageFlags.Ephemeral,
    });
  }

  player.queue.shuffle();
  await updatePlayerPanel(client, player);
  return interaction.reply(`Shuffled **${player.queue.length}** tracks.`);
}
