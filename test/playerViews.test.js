import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlayerPanel,
  updatePlayerPanel,
} from "../src/utils/playerPanel.js";
import { buildQueueView } from "../src/utils/queueView.js";
import { colors } from "../src/utils/theme.js";
import { getPlayerState } from "../src/utils/playerState.js";
import { stopPlayback } from "../src/utils/playback.js";

function createTrack(index = 1) {
  return {
    info: {
      title: `Track ${index}`,
      author: "Artist",
      length: 180_000,
      uri: "https://example.com/track",
      requester: { id: "123" },
      isStream: false,
      sourceName: "youtube",
      artworkUrl: "https://example.com/art.jpg",
    },
  };
}

function createPlayer(queueLength = 0) {
  return {
    currentTrack: createTrack(),
    position: 30_000,
    volume: 80,
    loop: "NONE",
    isPaused: false,
    queue: Array.from({ length: queueLength }, (_, index) => createTrack(index + 2)),
  };
}

test("player panel exposes playback controls", () => {
  const payload = buildPlayerPanel(createPlayer(2), {
    autoplay: true,
    lastTrack: null,
  });
  const json = payload.components.map((row) => row.toJSON());
  const embed = payload.embeds[0].toJSON();

  assert.equal(payload.embeds.length, 1);
  assert.equal(embed.color, colors.active);
  assert.equal(embed.image?.url, "https://example.com/art.jpg");
  assert.match(embed.description, /Up next/);
  assert.match(embed.description, /Source · Youtube/);
  assert.equal(json.length, 1);
  assert.equal(json[0].components.length, 4);
  assert.equal(json[0].components[0].label, "Pause");
  assert.equal(json[0].components[2].label, "Stop");
  assert.equal(
    embed.fields.some((field) => field.name === "Queue"),
    false,
  );
});

test("player panel switches pause to play", () => {
  const player = createPlayer();
  player.isPaused = true;
  const payload = buildPlayerPanel(player, {
    autoplay: true,
    lastTrack: null,
  });
  const button = payload.components[0].toJSON().components[0];

  assert.equal(button.label, "Play");
  assert.equal(button.disabled, false);
});

test("queue view paginates upcoming tracks", () => {
  const payload = buildQueueView(createPlayer(12), 1);
  const embed = payload.embeds[0].toJSON();
  const controls = payload.components[0].toJSON().components;

  assert.equal(embed.color, colors.active);
  assert.match(embed.footer.text, /Page 2\/2/);
  assert.equal(controls[0].disabled, false);
  assert.equal(controls[1].disabled, true);
});

test("concurrent panel updates create only one message", async () => {
  let sends = 0;
  let edits = 0;
  const message = {
    id: "message",
    channelId: "channel",
    async edit() {
      edits += 1;
    },
  };
  const channel = {
    lastMessageId: "other",
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { fetch: async () => null },
    async send() {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      channel.lastMessageId = message.id;
      return message;
    },
  };
  const client = {
    channels: {
      cache: new Map([["channel", channel]]),
      fetch: async () => null,
    },
  };
  const player = {
    ...createPlayer(2),
    guildId: "guild",
    textChannel: "channel",
  };

  await Promise.all([
    updatePlayerPanel(client, player),
    updatePlayerPanel(client, player),
    updatePlayerPanel(client, player),
    updatePlayerPanel(client, player),
  ]);

  assert.equal(sends, 1);
  assert.equal(edits, 3);
});

test("panel relocates when it is no longer the last message", async () => {
  let sends = 0;
  let deletes = 0;
  let edits = 0;
  const existing = {
    id: "panel-1",
    channelId: "channel",
    async edit() {
      edits += 1;
    },
    async delete() {
      deletes += 1;
    },
  };
  const relocated = {
    id: "panel-2",
    channelId: "channel",
    async edit() {
      edits += 1;
    },
    async delete() {
      deletes += 1;
    },
  };
  const channel = {
    lastMessageId: "queued-notice",
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { fetch: async () => null },
    async send() {
      sends += 1;
      channel.lastMessageId = relocated.id;
      return relocated;
    },
  };
  const client = {
    channels: {
      cache: new Map([["channel", channel]]),
      fetch: async () => null,
    },
  };
  const player = {
    ...createPlayer(2),
    guildId: "guild-relocate",
    textChannel: "channel",
  };
  const state = getPlayerState(client, player.guildId);
  state.panelMessage = existing;
  state.panelMessageId = existing.id;
  state.panelChannelId = "channel";

  await updatePlayerPanel(client, player);

  assert.equal(sends, 1);
  assert.equal(deletes, 1);
  assert.equal(edits, 0);
  assert.equal(state.panelMessageId, relocated.id);
  assert.equal(state.panelMessage, relocated);
});

test("stopPlayback deletes the bot's channel messages and clears panel refs", async () => {
  const botId = "bot";
  const deleted = [];
  const makeMessage = (id, authorId) => ({
    id,
    author: { id: authorId },
    createdTimestamp: Date.now(),
    async delete() {
      deleted.push(id);
    },
  });
  const channel = {
    id: "channel",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: { id: botId } } },
    permissionsFor() {
      return { has: () => true };
    },
    messages: {
      cache: new Map(),
      async fetch() {
        return new Map([
          ["bot-1", makeMessage("bot-1", botId)],
          ["user-1", makeMessage("user-1", "user")],
          ["bot-2", makeMessage("bot-2", botId)],
        ]);
      },
      async delete(id) {
        deleted.push(id);
      },
    },
    async bulkDelete(chunk) {
      for (const message of chunk) deleted.push(message.id);
    },
  };
  const client = {
    user: { id: botId },
    channels: {
      cache: new Map([["channel", channel]]),
      fetch: async () => null,
    },
    poru: { players: new Map() },
  };
  const player = {
    guildId: "guild-stop",
    textChannel: "channel",
    queue: { clear() {} },
    async destroy() {},
  };
  const state = getPlayerState(client, player.guildId);
  state.panelMessageId = "bot-1";
  state.panelChannelId = "channel";
  state.lastTrack = createTrack();

  await stopPlayback(client, player, { save: false });

  assert.deepEqual(deleted.sort(), ["bot-1", "bot-2"]);
  assert.equal(state.panelMessageId, null);
  assert.equal(state.panelChannelId, null);
  assert.equal(state.lastTrack, null);
  assert.equal(state.stopping, false);
  assert.equal(state.autoplay, true);
});
