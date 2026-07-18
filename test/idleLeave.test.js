import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  isBotAlone,
  clearIdleTimer,
  refreshIdleTimer,
  clearAllIdleTimers,
} from "../src/services/idleLeave.js";

function voiceChannel(members) {
  return {
    isVoiceBased: () => true,
    members: {
      filter(predicate) {
        const kept = members.filter(predicate);
        return { size: kept.length };
      },
    },
  };
}

test("isBotAlone is true when only bots remain", () => {
  const channel = voiceChannel([
    { user: { bot: true } },
    { user: { bot: true } },
  ]);
  assert.equal(isBotAlone(channel), true);
});

test("isBotAlone is false when a human is present", () => {
  const channel = voiceChannel([
    { user: { bot: true } },
    { user: { bot: false } },
  ]);
  assert.equal(isBotAlone(channel), false);
});

test("refreshIdleTimer starts once and clearIdleTimer cancels it", () => {
  const player = { guildId: "g1", voiceChannel: "vc1" };
  const channel = voiceChannel([{ user: { bot: true } }]);
  const client = {
    guilds: {
      cache: new Map([
        [
          "g1",
          {
            channels: {
              cache: new Map([["vc1", channel]]),
            },
          },
        ],
      ]),
    },
    poru: { players: new Map([["g1", player]]) },
  };

  clearAllIdleTimers();
  refreshIdleTimer(client, player);
  refreshIdleTimer(client, player);
  clearIdleTimer("g1");
  clearAllIdleTimers();
  assert.ok(true);
});
