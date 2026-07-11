import { Events, MessageFlags } from "discord.js";
import { debug, formatUserError, log, logError } from "../utils/logger.js";

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction, client) {
  // Log every interaction type so we can see if Discord is delivering autocomplete.
  if (interaction.isAutocomplete() || interaction.isChatInputCommand()) {
    log(
      "interaction",
      `type=${interaction.type} command=${interaction.commandName} autocomplete=${interaction.isAutocomplete()}`,
    );
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) {
      logError(
        "autocomplete",
        new Error(`No autocomplete handler for ${interaction.commandName}`),
      );
      return interaction.respond([]);
    }

    try {
      await command.autocomplete(interaction, client);
    } catch (error) {
      logError(`autocomplete:${interaction.commandName}`, error, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      try {
        if (!interaction.responded) {
          await interaction.respond([]);
        }
      } catch (replyError) {
        logError("autocomplete:reply", replyError);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    return interaction.reply({
      content: "Unknown command.",
      flags: MessageFlags.Ephemeral,
    });
  }

  debug(
    "interaction",
    `${interaction.commandName} by ${interaction.user.tag} in guild=${interaction.guildId}`,
  );

  try {
    await command.execute(interaction, client);
  } catch (error) {
    logError(`command:${interaction.commandName}`, error, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      options: interaction.options.data,
    });

    const payload = {
      content: formatUserError(error),
      flags: MessageFlags.Ephemeral,
    };

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyError) {
      logError("interaction:reply", replyError);
    }
  }
}
