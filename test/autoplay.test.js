import test from "node:test";
import assert from "node:assert/strict";
import { findAutoplayTrack } from "../src/services/autoplay.js";

function track(identifier, author, title) {
  return {
    info: {
      identifier,
      uri: `spotify:track:${identifier}`,
      sourceName: "spotify",
      author,
      title,
    },
  };
}

test("autoplay picks a radio track that was not played recently", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const recent = track("old", "Other", "Old");
  const next = track("next", "Other", "Next Song");
  const client = {
    spotify: {
      async radio(uri) {
        assert.equal(uri, "spotify:track:seed");
        return { tracks: [seed, recent, next] };
      },
    },
  };

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    { lastTrack: seed, recentTrackKeys: ["old", "other:old"] },
    () => 0,
  );

  assert.equal(result.info.uri, "spotify:track:next");
});

test("autoplay returns null when radio has nothing new", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const client = {
    spotify: {
      async radio() {
        return { tracks: [seed] };
      },
    },
  };

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    { lastTrack: seed, recentTrackKeys: [] },
    () => 0,
  );

  assert.equal(result, null);
});
