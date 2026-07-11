import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Clear upcoming tracks without stopping playback");

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player || player.queue.length === 0) {
    return interaction.reply({
      content: "The upcoming queue is already empty.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const count = player.queue.clear().length;
  await updatePlayerPanel(client, player);
  return interaction.reply(`Cleared **${count}** upcoming track(s).`);
}
