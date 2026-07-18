import { debug, logError } from "../../utils/logger.js";
import { sendPlayerMessage } from "../../utils/playerMessage.js";
import { updatePlayerPanel } from "../../utils/playerPanel.js";
import { scheduleSave } from "../../services/sessionStore.js";

export const name = "trackError";

/**
 * @param {import("poru").Player} player
 * @param {import("poru").Track} track
 * @param {unknown} data
 * @param {import("../../client.js").MusicBot} client
 */
export async function execute(player, track, data, client) {
  logError("trackError", data?.exception?.message ?? data?.message ?? data, {
    title: track?.info?.title ?? null,
    uri: track?.info?.uri ?? null,
    guildId: player?.guildId,
    queueLength: player?.queue?.length ?? 0,
    reason: data?.reason ?? data?.type ?? null,
  });

  debug("trackError", {
    nextTitle: player?.queue?.[0]?.info?.title ?? null,
  });

  const title = track?.info?.title ?? "Unknown track";
  await sendPlayerMessage(
    client,
    player?.textChannel,
    `Skipping **${title}** — it failed to play.`,
  );

  try {
    await player.skip();
  } catch (error) {
    logError("trackError:skip", error, { guildId: player?.guildId });
  }

  try {
    await updatePlayerPanel(client, player);
  } catch (error) {
    logError("trackError:panel", error, { guildId: player?.guildId });
  }

  scheduleSave(client);
}
