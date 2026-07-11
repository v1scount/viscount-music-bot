import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("remove")
  .setDescription("Remove a track from the upcoming queue")
  .addIntegerOption((option) =>
    option
      .setName("position")
      .setDescription("Queue position shown by /queue")
      .setMinValue(1)
      .setRequired(true),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  const position = interaction.options.getInteger("position", true);
  if (!player || position > player.queue.length) {
    return interaction.reply({
      content: "That queue position does not exist.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const removed = player.queue.remove(position - 1);
  await updatePlayerPanel(client, player);
  return interaction.reply(`Removed **${removed.info.title}** from the queue.`);
}
