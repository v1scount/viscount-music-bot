import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlayerPanel,
  updatePlayerPanel,
} from "../src/utils/playerPanel.js";
import { buildQueueView } from "../src/utils/queueView.js";

function createTrack(index = 1) {
  return {
    info: {
      title: `Track ${index}`,
      author: "Artist",
      length: 180_000,
      uri: "https://example.com/track",
      requester: { id: "123" },
      isStream: false,
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

  assert.equal(payload.embeds.length, 1);
  assert.equal(json.length, 1);
  assert.equal(json[0].components.length, 5);
  assert.equal(json[0].components[0].label, "Pause");
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

test("stop button switches to an enabled play button", () => {
  const payload = buildPlayerPanel(createPlayer(), {
    autoplay: true,
    lastTrack: null,
    stopped: true,
  });
  const buttons = payload.components[0].toJSON().components;

  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[2].label, "Play");
  assert.equal(buttons[2].disabled, false);
});

test("queue view paginates upcoming tracks", () => {
  const payload = buildQueueView(createPlayer(12), 1);
  const embed = payload.embeds[0].toJSON();
  const controls = payload.components[0].toJSON().components;

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
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { fetch: async () => null },
    async send() {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
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
