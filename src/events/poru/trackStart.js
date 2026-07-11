import { debug } from "../../utils/logger.js";
import { updatePlayerPanel } from "../../utils/playerPanel.js";
import { getPlayerState, rememberTrack } from "../../utils/playerState.js";

export const name = "trackStart";

export async function execute(player, track, client) {
  const state = getPlayerState(client, player.guildId);
  state.lastTrack = track;
  state.stopped = false;
  rememberTrack(state, track);

  debug("trackStart", {
    title: track?.info?.title ?? null,
    author: track?.info?.author ?? null,
    uri: track?.info?.uri ?? null,
    queueLength: player?.queue?.length ?? 0,
  });

  await updatePlayerPanel(client, player);
}
