import { MessageFlags } from "discord.js";
import { applyFilter } from "./filters.js";
import { logError } from "./logger.js";
import {
  PLAYER_COMPONENT_PREFIX,
  updatePlayerPanel,
} from "./playerPanel.js";
import { getPlayerState } from "./playerState.js";
import { buildQueueView, QUEUE_COMPONENT_PREFIX } from "./queueView.js";
import { getPlayer } from "./voice.js";

const LOOP_SEQUENCE = ["NONE", "TRACK", "QUEUE"];

async function handleQueueComponent(interaction, player) {
  const [, action, rawPage] = interaction.customId.split(":");
  const page = Number(rawPage) || 0;
  const nextPage = action === "next" ? page + 1 : page - 1;
  await interaction.update(buildQueueView(player, nextPage));
}

async function handlePlayerComponent(interaction, client, player) {
  const state = getPlayerState(client, interaction.guildId);
  const action = interaction.customId.slice(PLAYER_COMPONENT_PREFIX.length);
  await interaction.deferUpdate();

  if (interaction.isStringSelectMenu() && action === "filter") {
    state.filter = await applyFilter(player, interaction.values[0]);
  } else if (action === "pause") {
    await player.pause(!player.isPaused);
  } else if (action === "skip") {
    await player.skip();
  } else if (action === "stop") {
    player.queue.clear();
    await updatePlayerPanel(client, player, { disabled: true });
    await player.destroy();
    return;
  } else if (action === "loop") {
    const current = LOOP_SEQUENCE.indexOf(player.loop);
    player.setLoop(LOOP_SEQUENCE[(current + 1) % LOOP_SEQUENCE.length]);
  } else if (action === "autoplay") {
    state.autoplay = !state.autoplay;
  }

  await updatePlayerPanel(client, player);
}

export async function handleMusicComponent(interaction, client) {
  const isMusicComponent =
    interaction.customId?.startsWith(PLAYER_COMPONENT_PREFIX) ||
    interaction.customId?.startsWith(QUEUE_COMPONENT_PREFIX);
  if (!isMusicComponent) return false;

  const player = getPlayer(client, interaction.guildId);
  if (!player) {
    await interaction.reply({
      content: "The player is no longer active.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  try {
    if (interaction.customId.startsWith(QUEUE_COMPONENT_PREFIX)) {
      await handleQueueComponent(interaction, player);
    } else {
      await handlePlayerComponent(interaction, client, player);
    }
  } catch (error) {
    logError("playerComponent", error, {
      guildId: interaction.guildId,
      customId: interaction.customId,
    });
    const payload = {
      content: "That control could not be applied.",
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }

  return true;
}
