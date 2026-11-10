import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeTrack,
  deserializeTrack,
  collectSessions,
  restoreStationFields,
} from "../src/services/sessionStore.js";
import { getPlayerState } from "../src/utils/playerState.js";

function createTrack(title = "Song") {
  return {
    info: {
      identifier: "abc123",
      isSeekable: true,
      author: "Artist",
      artistId: "a".repeat(22),
      length: 120_000,
      isStream: false,
      position: 0,
      title,
      uri: "spotify:track:abc123",
      artworkUrl: "https://i.scdn.co/image/art",
      isrc: null,
      sourceName: "spotify",
      requester: { id: "user1" },
    },
  };
}

test("serializeTrack / deserializeTrack round-trip", () => {
  const original = createTrack("Round Trip");
  const serialized = serializeTrack(original);
  const restored = deserializeTrack(serialized);

  assert.ok(serialized);
  assert.equal(serialized.info.uri, "spotify:track:abc123");
  assert.equal(restored.info.title, "Round Trip");
  assert.equal(restored.info.artistId, "a".repeat(22));
  assert.equal(restored.info.requester.id, "user1");
  assert.equal(restored.info.sourceName, "spotify");
});

test("youtube encodings are ignored", () => {
  const youtube = {
    track: "encoded-track-data",
    info: {
      identifier: "abc",
      title: "Video",
      author: "Channel",
      uri: "https://youtu.be/abc",
      sourceName: "youtube",
    },
  };
  assert.equal(serializeTrack(youtube), null);
  assert.equal(
    deserializeTrack({
      encoded: "encoded-track-data",
      info: youtube.info,
    }),
    null,
  );
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
    players: new Map([["guild-1", player]]),
  };
  const state = getPlayerState(client, "guild-1");
  state.autoplay = false;
  state.recentTrackKeys = ["abc123"];
  state.recentTrackUris = ["spotify:track:abc123", "spotify:track:def456"];
  state.recentArtistIds = ["a".repeat(22), "b".repeat(22), "c".repeat(22), "d".repeat(22), "nope"];
  state.autoplaySeed = createTrack("Anchor");
  state.autoplayCount = 4;

  const sessions = collectSessions(client);
  assert.ok(sessions["guild-1"]);
  assert.equal(sessions["guild-1"].autoplay, false);
  assert.equal(sessions["guild-1"].current.info.title, "Song");
  assert.equal(sessions["guild-1"].queue.length, 1);
  assert.equal(sessions["guild-1"].recentTrackKeys[0], "abc123");
  assert.deepEqual(sessions["guild-1"].recentTrackUris, [
    "spotify:track:abc123",
    "spotify:track:def456",
  ]);
  assert.deepEqual(sessions["guild-1"].recentArtistIds, [
    "b".repeat(22),
    "c".repeat(22),
    "d".repeat(22),
  ]);
  assert.equal(sessions["guild-1"].autoplaySeed.info.title, "Anchor");
  assert.equal(sessions["guild-1"].autoplayCount, 4);
  assert.equal("panelMessageId" in sessions["guild-1"], false);
});

test("restoreStationFields keeps a saved anchor and ignores older files", () => {
  const state = getPlayerState({}, "restore-station");
  restoreStationFields(state, {
    autoplaySeed: serializeTrack(createTrack("Anchor")),
    recentTrackUris: ["spotify:track:abc123", "https://youtu.be/nope", "spotify:track:def456"],
    recentArtistIds: ["a".repeat(22), "nope", "b".repeat(22)],
    autoplayCount: 4,
  });
  assert.equal(state.autoplaySeed.info.uri, "spotify:track:abc123");
  assert.equal(state.autoplayCount, 4);
  assert.deepEqual(state.recentTrackUris, [
    "spotify:track:abc123",
    "spotify:track:def456",
  ]);
  assert.deepEqual(state.recentArtistIds, ["a".repeat(22), "b".repeat(22)]);

  const legacy = getPlayerState({}, "restore-legacy");
  restoreStationFields(legacy, { autoplay: true });
  assert.equal(legacy.autoplaySeed, null);
  assert.deepEqual(legacy.recentTrackUris, []);
  assert.deepEqual(legacy.recentArtistIds, []);
  assert.equal(legacy.autoplayCount, 0);
});
