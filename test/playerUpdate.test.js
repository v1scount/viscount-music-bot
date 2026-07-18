import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefreshPanel,
  PANEL_THROTTLE_MS,
} from "../src/events/poru/playerUpdate.js";

test("shouldRefreshPanel skips paused players", () => {
  assert.equal(
    shouldRefreshPanel({ isPaused: true }, { lastPanelUpdateAt: 0 }),
    false,
  );
});

test("shouldRefreshPanel respects throttle window", () => {
  const now = 100_000;
  assert.equal(
    shouldRefreshPanel(
      { isPaused: false },
      { lastPanelUpdateAt: now - PANEL_THROTTLE_MS + 1 },
      now,
    ),
    false,
  );
  assert.equal(
    shouldRefreshPanel(
      { isPaused: false },
      { lastPanelUpdateAt: now - PANEL_THROTTLE_MS },
      now,
    ),
    true,
  );
});
