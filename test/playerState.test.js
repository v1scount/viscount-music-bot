import test from "node:test";
import assert from "node:assert/strict";
import {
  getPlayerState,
  rememberTrack,
  trackKeys,
  clearPanelRefs,
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

test("clearPanelRefs drops message handles and keeps autoplay", () => {
  const state = getPlayerState({}, "guild-clear");
  state.panelMessageId = "msg";
  state.panelChannelId = "channel";
  state.panelMessage = { id: "msg" };
  state.lastTrack = track("id", "A", "T");
  state.autoplay = false;

  clearPanelRefs(state);

  assert.equal(state.panelMessageId, null);
  assert.equal(state.panelChannelId, null);
  assert.equal(state.panelMessage, null);
  assert.equal(state.lastTrack, null);
  assert.equal(state.autoplay, false);
});
