import { updatePlayerPanel } from "../../utils/playerPanel.js";
import { getPlayerState } from "../../utils/playerState.js";

export const name = "playerUpdate";

export const PANEL_THROTTLE_MS = 5_000;

/**
 * @param {{ isPaused?: boolean }} player
 * @param {{ lastPanelUpdateAt?: number }} state
 * @param {number} [now]
 * @param {number} [throttleMs]
 */
export function shouldRefreshPanel(
  player,
  state,
  now = Date.now(),
  throttleMs = PANEL_THROTTLE_MS,
) {
  if (player?.isPaused) return false;
  return now - (state.lastPanelUpdateAt ?? 0) >= throttleMs;
}

/**
 * @param {import("poru").Player} player
 * @param {import("../../client.js").MusicBot} client
 */
export async function execute(player, client) {
  const state = getPlayerState(client, player.guildId);
  if (!shouldRefreshPanel(player, state)) return;
  await updatePlayerPanel(client, player);
}
