import test from "node:test";
import assert from "node:assert/strict";
import { buildPlayerPanel } from "../src/utils/playerPanel.js";
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

test("player panel exposes playback controls and filter selector", () => {
  const payload = buildPlayerPanel(createPlayer(2), {
    autoplay: true,
    filter: "off",
    lastTrack: null,
  });
  const json = payload.components.map((row) => row.toJSON());

  assert.equal(payload.embeds.length, 1);
  assert.equal(json[0].components.length, 5);
  assert.equal(json[1].components[0].custom_id, "music:filter");
});

test("queue view paginates upcoming tracks", () => {
  const payload = buildQueueView(createPlayer(12), 1);
  const embed = payload.embeds[0].toJSON();
  const controls = payload.components[0].toJSON().components;

  assert.match(embed.footer.text, /Page 2\/2/);
  assert.equal(controls[0].disabled, false);
  assert.equal(controls[1].disabled, true);
});
