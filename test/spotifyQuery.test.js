import test from "node:test";
import assert from "node:assert/strict";
import { classifyQuery } from "../src/utils/spotifyQuery.js";

test("spotify uris and links classify as playable", () => {
  assert.deepEqual(classifyQuery("spotify:track:abc"), {
    kind: "track",
    uri: "spotify:track:abc",
  });
  assert.deepEqual(
    classifyQuery("https://open.spotify.com/album/xyz?si=1"),
    { kind: "album", uri: "spotify:album:xyz" },
  );
  assert.deepEqual(
    classifyQuery("https://open.spotify.com/intl-pt/playlist/pl1"),
    { kind: "playlist", uri: "spotify:playlist:pl1" },
  );
});

test("text is a search and other links are rejected", () => {
  assert.deepEqual(classifyQuery("rick astley"), {
    kind: "search",
    query: "rick astley",
  });
  assert.deepEqual(classifyQuery("https://youtu.be/abc"), {
    kind: "unsupported",
  });
  assert.deepEqual(classifyQuery("ytsearch:song"), { kind: "unsupported" });
});
