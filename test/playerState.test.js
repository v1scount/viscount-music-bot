import test from "node:test";
import assert from "node:assert/strict";
import {
  getPlayerState,
  rememberTrack,
  trackKeys,
} from "../src/utils/playerState.js";

function track(identifier, author, title) {
  return { info: { identifier, author, title } };
}

test("player state defaults autoplay to enabled", () => {
  const client = {};
  assert.equal(getPlayerState(client, "guild").autoplay, true);
  assert.equal(getPlayerState(client, "guild"), getPlayerState(client, "guild"));
});

test("rememberTrack keeps identifier and metadata keys", () => {
  const state = getPlayerState({}, "guild");
  const value = track("ABC", "Artist", "Song");
  rememberTrack(state, value);
  assert.deepEqual(trackKeys(value), ["abc", "artist:song"]);
  assert.deepEqual(state.recentTrackKeys, ["abc", "artist:song"]);
});
