import test from "node:test";
import assert from "node:assert/strict";
import { findAutoplayTrack } from "../src/services/autoplay.js";
import { getPlayerState, noteStationTrack } from "../src/utils/playerState.js";

function track(identifier, author, title, requester = null, artistId = null) {
  return {
    info: {
      identifier,
      uri: `spotify:track:${identifier}`,
      sourceName: "spotify",
      author,
      title,
      artistId,
      requester,
    },
  };
}

const SEED_ARTIST = "a".repeat(22);
const NEXT_ARTIST = "b".repeat(22);

test("autoplay asks for radio with the seed, recent uris, and artist ids", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const recent = track("old", "Other", "Old");
  const first = track("next", "Other", "Next Song");
  const later = track("later", "Other", "Later Song");
  const calls = [];
  const client = {
    spotify: {
      async radio(uri, previous, step, artists) {
        calls.push({ uri, previous, step, artists });
        return { tracks: [seed, recent, first, later] };
      },
    },
  };

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    {
      autoplaySeed: seed,
      autoplayCount: 0,
      lastTrack: track("drift", "Other", "Drift"),
      recentArtistIds: [SEED_ARTIST],
      recentTrackKeys: ["old", "other:old"],
      recentTrackUris: ["spotify:track:seed", "spotify:track:old"],
    },
  );

  assert.equal(result.info.uri, "spotify:track:next");
  assert.deepEqual(calls, [
    {
      uri: "spotify:track:seed",
      previous: ["spotify:track:seed", "spotify:track:old"],
      step: 0,
      artists: [SEED_ARTIST],
    },
  ]);
});

test("later rotation steps stay on the anchor and send the recent artists", async () => {
  const anchor = track("seed", "Seed Artist", "Seed Song");
  const next = track("wider", "Further", "Further Song");
  const calls = [];
  const previous = ["spotify:track:seed", "spotify:track:a", "spotify:track:b"];
  const artists = [SEED_ARTIST, NEXT_ARTIST, "c".repeat(22)];
  const client = {
    spotify: {
      async radio(uri, recent, step, recentArtists) {
        calls.push({ uri, previous: recent, step, artists: recentArtists });
        return { tracks: [next] };
      },
    },
  };

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    {
      autoplaySeed: anchor,
      autoplayCount: 4,
      recentArtistIds: artists,
      recentTrackKeys: [],
      recentTrackUris: previous,
    },
  );

  assert.equal(result.info.uri, "spotify:track:wider");
  assert.deepEqual(calls, [
    {
      uri: "spotify:track:seed",
      previous,
      step: 4,
      artists,
    },
  ]);
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
    { lastTrack: seed, recentTrackKeys: [], recentTrackUris: [] },
  );

  assert.equal(result, null);
});

test("a requested track replaces the station anchor and artist list", () => {
  const state = getPlayerState({}, "station-anchor");
  noteStationTrack(state, track("seed", "Seed Artist", "Seed Song", { id: "user" }, SEED_ARTIST));
  noteStationTrack(state, track("auto", "Other", "Auto", "Autoplay", NEXT_ARTIST));
  noteStationTrack(state, track("next", "Other", "Next", { id: "user" }, "c".repeat(22)));

  assert.equal(state.autoplaySeed.info.uri, "spotify:track:next");
  assert.deepEqual(state.recentTrackUris, ["spotify:track:next"]);
  assert.deepEqual(state.recentArtistIds, ["c".repeat(22)]);
  assert.equal(state.autoplayCount, 0);
});

test("autoplay tracks extend the recent uri list, remember artists, and keep the anchor", () => {
  const state = getPlayerState({}, "station-recent");
  noteStationTrack(state, track("seed", "Seed Artist", "Seed Song", { id: "user" }, SEED_ARTIST));
  const played = ["a", "b", "c", "d", "e"];
  for (const id of played) {
    noteStationTrack(state, track(id, "Other", id, "Autoplay", id.repeat(22)));
  }

  assert.equal(state.autoplaySeed.info.uri, "spotify:track:seed");
  assert.equal(state.autoplayCount, 5);
  assert.deepEqual(state.recentTrackUris, [
    "spotify:track:seed",
    "spotify:track:a",
    "spotify:track:b",
    "spotify:track:c",
    "spotify:track:d",
    "spotify:track:e",
  ]);
  assert.deepEqual(state.recentArtistIds, ["c".repeat(22), "d".repeat(22), "e".repeat(22)]);
});
