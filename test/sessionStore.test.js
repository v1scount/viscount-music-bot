import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeTrack,
  deserializeTrack,
  collectSessions,
} from "../src/services/sessionStore.js";
import { getPlayerState } from "../src/utils/playerState.js";

function createTrack(title = "Song") {
  return {
    track: "encoded-track-data",
    info: {
      identifier: "abc123",
      isSeekable: true,
      author: "Artist",
      length: 120_000,
      isStream: false,
      position: 0,
      title,
      uri: "https://example.com/song",
      artworkUrl: "https://example.com/art.jpg",
      isrc: null,
      sourceName: "youtube",
      requester: { id: "user1" },
    },
    pluginInfo: {},
    userData: {},
  };
}

test("serializeTrack / deserializeTrack round-trip", () => {
  const original = createTrack("Round Trip");
  const serialized = serializeTrack(original);
  const restored = deserializeTrack(serialized);

  assert.ok(serialized);
  assert.equal(serialized.encoded, "encoded-track-data");
  assert.equal(restored.track, "encoded-track-data");
  assert.equal(restored.info.title, "Round Trip");
  assert.equal(restored.info.requester.id, "user1");
});

test("collectSessions captures active guild players", () => {
  const track = createTrack();
  const player = {
    voiceChannel: "voice",
    textChannel: "text",
    position: 12_000,
    currentTrack: track,
    queue: [createTrack("Next")],
  };
  const client = {
    poru: { players: new Map([["guild-1", player]]) },
  };
  const state = getPlayerState(client, "guild-1");
  state.autoplay = false;
  state.panelMessageId = "msg";
  state.panelChannelId = "text";
  state.recentTrackKeys = ["abc123"];

  const sessions = collectSessions(client);
  assert.ok(sessions["guild-1"]);
  assert.equal(sessions["guild-1"].autoplay, false);
  assert.equal(sessions["guild-1"].current.info.title, "Song");
  assert.equal(sessions["guild-1"].queue.length, 1);
  assert.equal(sessions["guild-1"].recentTrackKeys[0], "abc123");
});
