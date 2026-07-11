import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayerState } from "../utils/playerState.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("autoplay")
  .setDescription("Enable or disable similar-track autoplay")
  .addBooleanOption((option) =>
    option
      .setName("enabled")
      .setDescription("Whether recommendations should continue an empty queue")
      .setRequired(true),
  );

export async function execute(interaction, client) {
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const enabled = interaction.options.getBoolean("enabled", true);
  const state = getPlayerState(client, interaction.guildId);
  state.autoplay = enabled;

  const player = getPlayer(client, interaction.guildId);
  if (player) await updatePlayerPanel(client, player);

  return interaction.reply(`Autoplay is now **${enabled ? "ON" : "OFF"}**.`);
}
