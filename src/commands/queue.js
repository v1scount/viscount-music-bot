import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildQueueView } from "../utils/queueView.js";
import { getPlayer } from "../utils/voice.js";

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

  return interaction.reply(buildQueueView(player));
}
