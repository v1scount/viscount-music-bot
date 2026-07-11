import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { applyFilter, FILTER_NAMES } from "../utils/filters.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayerState } from "../utils/playerState.js";
import { getPlayer } from "../utils/voice.js";

export const data = new SlashCommandBuilder()
  .setName("filter")
  .setDescription("Apply an audio filter")
  .addStringOption((option) =>
    option
      .setName("preset")
      .setDescription("Audio filter preset")
      .setRequired(true)
      .addChoices(
        ...Object.entries(FILTER_NAMES).map(([value, name]) => ({ name, value })),
      ),
  );

export async function execute(interaction, client) {
  const player = getPlayer(client, interaction.guildId);
  if (!player?.currentTrack) {
    return interaction.reply({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const preset = interaction.options.getString("preset", true);
  const state = getPlayerState(client, interaction.guildId);
  state.filter = await applyFilter(player, preset);
  await updatePlayerPanel(client, player);
  return interaction.reply(`Filter set to **${FILTER_NAMES[preset]}**.`);
}
