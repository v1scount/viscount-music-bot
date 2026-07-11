import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("move")
  .setDescription("Move a track to another queue position")
  .addIntegerOption((option) =>
    option.setName("from").setDescription("Current position").setMinValue(1).setRequired(true),
  )
  .addIntegerOption((option) =>
    option.setName("to").setDescription("New position").setMinValue(1).setRequired(true),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  const from = interaction.options.getInteger("from", true);
  const to = interaction.options.getInteger("to", true);
  if (!player || from > player.queue.length || to > player.queue.length) {
    return interaction.reply({
      content: "Both positions must exist in the upcoming queue.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const [track] = player.queue.splice(from - 1, 1);
  player.queue.splice(to - 1, 0, track);
  await updatePlayerPanel(client, player);
  return interaction.reply(`Moved **${track.info.title}** to position **${to}**.`);
}
