import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getPlayer, requireVoiceChannel } from "../utils/voice.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayerState } from "../utils/playerState.js";

export const data = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pause the current track without leaving the voice channel");

export async function execute(interaction, client) {
  const voice = requireVoiceChannel(interaction);
  if (!voice) {
    return interaction.reply({
      content: "Join a voice channel first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const player = getPlayer(client, interaction.guildId);
  if (!player || !player.currentTrack) {
    return interaction.reply({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (player.isPaused) {
    return interaction.reply({
      content: "Playback is already paused. Use `/resume` to continue.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await player.pause(true);
  getPlayerState(client, interaction.guildId).stopped = false;
  await updatePlayerPanel(client, player);

  return interaction.reply(
    `Paused **${player.currentTrack.info.title}**. Use \`/resume\` to continue.`,
  );
}
