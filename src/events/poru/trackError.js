import { debug, logError } from "../../utils/logger.js";

export const name = "trackError";

export async function execute(player, track, data) {
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
}
