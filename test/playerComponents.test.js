import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { handleMusicComponent } from "../src/utils/playerComponents.js";
import { getPlayerState } from "../src/utils/playerState.js";

function createTrack(index = 1) {
  return {
    info: {
      title: `Track ${index}`,
      author: "Artist",
      length: 180_000,
      requester: "Tester",
    },
  };
}

function createClient(player) {
  return {
    players: new Map([[player.guildId, player]]),
    channels: {
      cache: new Map(),
      async fetch() {
        return null;
      },
    },
  };
}

test("autoplay button toggles the guild setting", async () => {
  const player = {
    guildId: "guild",
    textChannel: "channel",
    queue: [],
    currentTrack: createTrack(),
    volume: 100,
    loop: "NONE",
  };
  const client = createClient(player);
  const interaction = {
    customId: "music:autoplay",
    guildId: "guild",
    deferred: false,
    replied: false,
    async deferUpdate() {
      this.deferred = true;
    },
  };

  assert.equal(getPlayerState(client, "guild").autoplay, true);
  assert.equal(await handleMusicComponent(interaction, client), true);
  assert.equal(getPlayerState(client, "guild").autoplay, false);
  assert.equal(interaction.deferred, true);
});

test("queue next button updates the requested page", async () => {
  const player = {
    guildId: "guild",
    queue: Array.from({ length: 12 }, (_, index) => createTrack(index + 1)),
    currentTrack: createTrack(),
  };
  const client = createClient(player);
  let payload;
  const interaction = {
    customId: "music_queue:next:0",
    guildId: "guild",
    async update(value) {
      payload = value;
    },
  };

  assert.equal(await handleMusicComponent(interaction, client), true);
  assert.match(payload.embeds[0].toJSON().footer.text, /Page 2\/2/);
});

test("stop button clears the queue and destroys the player", async () => {
  const calls = [];
  const player = {
    guildId: "guild",
    textChannel: "channel",
    queue: {
      length: 1,
      clear() {
        calls.push("clear");
        this.length = 0;
      },
      map() {
        return [];
      },
    },
    currentTrack: createTrack(),
    loop: "NONE",
    isPaused: false,
    async destroy() {
      calls.push("destroy");
    },
  };
  const client = createClient(player);
  const interaction = {
    customId: "music:stop",
    guildId: "guild",
    message: { id: "panel" },
    async deferUpdate() {},
    async deleteReply() {
      calls.push("deleteReply");
    },
  };

  await handleMusicComponent(interaction, client);

  assert.deepEqual(calls, ["clear", "destroy", "deleteReply"]);
});

test("stop button stops playback without waiting to delete the panel", async () => {
  const calls = [];
  const panel = {
    id: "panel",
    author: { id: "bot" },
    async delete() {
      await new Promise(() => {});
    },
  };
  const queued = {
    id: "queued",
    author: { id: "bot" },
    async delete() {
      calls.push("queued");
    },
  };
  const channel = {
    id: "channel",
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { me: { id: "bot" } } },
    permissionsFor() {
      return { has: () => false };
    },
    messages: {
      cache: new Map([
        ["panel", panel],
        ["queued", queued],
      ]),
      async fetch() {
        throw new Error("no history");
      },
    },
  };
  const player = {
    guildId: "guild-stop-hang",
    textChannel: "channel",
    queue: {
      clear() {
        calls.push("clear");
      },
      map() {
        return [];
      },
    },
    async destroy() {
      calls.push("destroy");
    },
  };
  const client = {
    user: { id: "bot" },
    players: new Map([[player.guildId, player]]),
    channels: {
      cache: new Map([["channel", channel]]),
      fetch: async () => null,
    },
  };
  const state = getPlayerState(client, player.guildId);
  state.panelChannelId = "channel";
  state.panelMessageId = "panel";

  const interaction = {
    customId: "music:stop",
    guildId: player.guildId,
    message: { id: "panel" },
    async deferUpdate() {},
    async deleteReply() {
      calls.push("deleteReply");
    },
  };

  await Promise.race([
    handleMusicComponent(interaction, client),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("stop button hung")), 200),
    ),
  ]);

  assert.ok(calls.includes("clear"));
  assert.ok(calls.includes("destroy"));
  assert.ok(calls.includes("queued"));
  assert.ok(calls.includes("deleteReply"));
});
