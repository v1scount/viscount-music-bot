import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeLoadedSearches,
  rankSearchResults,
  settleWithin,
} from "../src/utils/searchRank.js";

function track(identifier, title, author = "Artist") {
  return { info: { identifier, title, author } };
}

test("an exact title match stays ahead of looser Spotify results", () => {
  const ranked = rankSearchResults("never gonna give you up", [
    track("remix", "Never Gonna Give You Up (Remix)", "Rick Astley"),
    track("other", "Together Forever", "Rick Astley"),
    track("exact", "Never Gonna Give You Up", "Rick Astley"),
  ]).map((entry) => entry.info.identifier);

  assert.equal(ranked[0], "exact");
  assert.deepEqual(ranked.slice(1), ["remix", "other"]);
});

test("spotify order is kept when scores match", () => {
  const ranked = rankSearchResults("song", [
    track("first", "Song", "Artist"),
    track("second", "Song", "Artist"),
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["first", "second"]);
});

test("duplicate identifiers are kept once", () => {
  const ranked = rankSearchResults("song", [
    track("same", "Song", "Artist"),
    track("same", "Song (Remaster)", "Artist"),
    track("other", "Other", "Artist"),
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["same", "other"]);
});

test("a failed source still leaves the other source's matches", () => {
  const merged = mergeLoadedSearches("song", [
    { loadType: "error", tracks: [] },
    {
      loadType: "search",
      tracks: [track("second", "Other"), track("first", "Song")],
    },
  ]);

  assert.equal(merged.loadType, "search");
  assert.equal(merged.tracks[0].info.identifier, "first");
});

test("an empty result stays empty", () => {
  const merged = mergeLoadedSearches("song", [{ loadType: "empty", tracks: [] }]);
  assert.equal(merged.loadType, "empty");
});

test("settleWithin returns results that finished before the timeout", async () => {
  const results = await settleWithin(
    [
      Promise.resolve("music"),
      new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
    ],
    50,
  );

  assert.equal(results[0], "music");
  assert.equal(results[1], undefined);
});
