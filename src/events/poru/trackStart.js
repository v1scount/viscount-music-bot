import { debug } from "../../utils/logger.js";
import { sendPlayerMessage } from "../../utils/playerMessage.js";

export const name = "trackStart";

export async function execute(player, track, client) {
  debug("trackStart", {
    title: track?.info?.title ?? null,
    author: track?.info?.author ?? null,
    uri: track?.info?.uri ?? null,
    queueLength: player?.queue?.length ?? 0,
  });

  await sendPlayerMessage(
    client,
    player.textChannel,
    `Now playing **${track.info.title}** by ${track.info.author}`,
  );
}
