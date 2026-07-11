import { updatePlayerPanel } from "../../utils/playerPanel.js";
import { getPlayerState } from "../../utils/playerState.js";

export const name = "playerUpdate";

export async function execute(player, client) {
  const state = getPlayerState(client, player.guildId);
  if (Date.now() - state.lastPanelUpdateAt < 15000) return;
  await updatePlayerPanel(client, player);
}
