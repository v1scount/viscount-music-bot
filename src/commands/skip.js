import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { debug } from "../utils/logger.js";
import { getPlayer, requireVoiceChannel } from "../utils/voice.js";
export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip the currently playing track");

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

  const skipped = player.currentTrack.info.title;
  const next = player.queue[0] ?? null;

  debug("skip", {
    skipped,
    skippedUri: player.currentTrack.info.uri ?? null,
    queueLength: player.queue.length,
    nextTitle: next?.info?.title ?? null,
    nextAuthor: next?.info?.author ?? null,
    nextUri: next?.info?.uri ?? null,
  });

  // Stop the current track. Poru’s TrackEnd (reason=stopped) then calls
  // play(), which shifts the next queued item — not related/radio tracks.
  await player.skip();

  if (next) {
    return interaction.reply(
      `Skipped **${skipped}**. Next: **${next.info.title}** by ${next.info.author}.`,
    );
  }

  return interaction.reply(`Skipped **${skipped}**.`);
}
