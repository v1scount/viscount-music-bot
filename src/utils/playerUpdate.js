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
