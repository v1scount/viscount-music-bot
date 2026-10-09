import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearBotMessages,
  isOwnBotMessage,
} from "../src/utils/playerMessage.js";
import { getPlayerState } from "../src/utils/playerState.js";
import { stopPlayback } from "../src/utils/playback.js";
import { execute as onVoiceStateUpdate } from "../src/events/voiceStateUpdate.js";

test("isOwnBotMessage matches bot author and application webhook replies", () => {
  const botId = "bot";
  assert.equal(isOwnBotMessage({ author: { id: botId } }, botId), true);
  assert.equal(isOwnBotMessage({ author: { id: "user" } }, botId), false);
  assert.equal(
    isOwnBotMessage(
      { author: { id: "webhook" }, applicationId: botId },
      botId,
    ),
    true,
  );
});

test("clearBotMessages wipes cache when history permission is missing", async () => {
  const botId = "bot";
  const deleted = [];
  const makeMessage = (id, authorId, extra = {}) => ({
    id,
    author: { id: authorId },
    createdTimestamp: Date.now(),
    async delete() {
      deleted.push(id);
    },
    ...extra,
  });
  const queued = makeMessage("queued", "webhook", { applicationId: botId });
  const panel = makeMessage("panel", botId);
  const user = makeMessage("user", "user");
  const channel = {
    id: "channel",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: null } },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([
        [queued.id, queued],
        [panel.id, panel],
        [user.id, user],
      ]),
      async fetch() {
        throw new Error("should not fetch without view/history");
      },
    },
  };

  await clearBotMessages(channel, botId, {
    extraIds: [panel.id],
    applicationId: botId,
  });

  assert.deepEqual(deleted.sort(), ["panel", "queued"]);
});

test("clearBotMessages skips the interaction message so stop can finish", async () => {
  const botId = "bot";
  const deleted = [];
  const makeMessage = (id) => ({
    id,
    author: { id: botId },
    createdTimestamp: Date.now(),
    async delete() {
      deleted.push(id);
    },
  });
  const channel = {
    id: "channel",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: null } },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([
        ["panel", makeMessage("panel")],
        ["queued", makeMessage("queued")],
      ]),
      async fetch() {
        throw new Error("should not fetch");
      },
    },
  };

  await clearBotMessages(channel, botId, {
    extraIds: ["panel"],
    skipIds: ["panel"],
    applicationId: botId,
  });

  assert.deepEqual(deleted, ["queued"]);
});

test("voice disconnect wipes messages even if player.voiceChannel is already cleared", async () => {
  const botId = "bot";
  const deleted = [];
  const guildId = "guild-voice";
  const makeMessage = (id) => ({
    id,
    author: { id: botId },
    createdTimestamp: Date.now(),
    async delete() {
      deleted.push(id);
    },
  });
  const channel = {
    id: "text",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: { id: botId } } },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([["panel", makeMessage("panel")]]),
      async fetch() {
        throw new Error("no history");
      },
    },
  };
  const player = {
    guildId,
    voiceChannel: null,
    textChannel: "text",
    queue: {
      clear() {},
      map() {
        return [];
      },
    },
    async destroy() {},
  };
  const client = {
    user: { id: botId },
    application: { id: botId },
    channels: {
      cache: new Map([["text", channel]]),
      fetch: async () => null,
    },
    poru: { players: new Map([[guildId, player]]) },
  };
  const state = getPlayerState(client, guildId);
  state.panelChannelId = "text";
  state.panelMessageId = "panel";

  await onVoiceStateUpdate(
    { channelId: "voice", guild: { id: guildId } },
    { channelId: null, id: botId, guild: { id: guildId } },
    client,
  );

  assert.deepEqual(deleted, ["panel"]);
  assert.equal(state.panelMessageId, null);
});

test("voice disconnect wipes even after the player is already gone", async () => {
  const botId = "bot";
  const deleted = [];
  const guildId = "guild-no-player";
  const channel = {
    id: "text",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: null } },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([
        [
          "old-panel",
          {
            id: "old-panel",
            author: { id: botId },
            async delete() {
              deleted.push("old-panel");
            },
          },
        ],
      ]),
      async fetch() {
        throw new Error("no history");
      },
    },
  };
  const client = {
    user: { id: botId },
    channels: {
      cache: new Map([["text", channel]]),
      fetch: async () => null,
    },
    poru: { players: new Map() },
  };
  const state = getPlayerState(client, guildId);
  state.panelChannelId = "text";
  state.panelMessageId = "old-panel";

  await onVoiceStateUpdate(
    { channelId: "voice", guild: { id: guildId } },
    { channelId: null, id: botId, guild: { id: guildId } },
    client,
  );

  assert.deepEqual(deleted, ["old-panel"]);
  assert.equal(state.panelChannelId, null);
});

test("stopPlayback still wipes when the player was already destroyed", async () => {
  const botId = "bot";
  const deleted = [];
  const guildId = "guild-gone";
  const channel = {
    id: "text",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: {} },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([
        [
          "notice",
          {
            id: "notice",
            author: { id: botId },
            async delete() {
              deleted.push("notice");
            },
          },
        ],
      ]),
      async fetch() {
        return new Map();
      },
    },
  };
  const client = {
    user: { id: botId },
    channels: {
      cache: new Map([["text", channel]]),
      fetch: async () => null,
    },
    poru: { players: new Map() },
  };
  const player = {
    guildId,
    textChannel: "text",
    queue: { clear() {} },
    async destroy() {},
  };
  const state = getPlayerState(client, guildId);
  state.panelChannelId = "text";

  await stopPlayback(client, player, { save: false });

  assert.deepEqual(deleted, ["notice"]);
});
