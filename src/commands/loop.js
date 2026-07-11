import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayer } from "../utils/voice.js";

const LOOP_MODES = { off: "NONE", track: "TRACK", queue: "QUEUE" };

export const data = new SlashCommandBuilder()
  .setName("loop")
  .setDescription("Change the loop mode")
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("What should repeat")
      .setRequired(true)
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Current track", value: "track" },
        { name: "Entire queue", value: "queue" },
      ),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player) {
    return interaction.reply({
      content: "There is no active player.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const mode = interaction.options.getString("mode", true);
  player.setLoop(LOOP_MODES[mode]);
  await updatePlayerPanel(client, player);
  return interaction.reply(`Loop mode set to **${mode}**.`);
}
