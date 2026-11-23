import test from "node:test";
import assert from "node:assert/strict";
import { findAutoplayTrack, startAutoplay } from "../src/services/autoplay.js";
import { getPlayerState, noteStationTrack } from "../src/utils/playerState.js";

function track(identifier, author, title, requester = null) {
  return {
    info: {
      identifier,
      uri: `spotify:track:${identifier}`,
      sourceName: "spotify",
      author,
      title,
      requester,
    },
  };
}

function candidate(identifier, artist, title, popularity = 50) {
  return {
    id: `recco-${identifier}`,
    spotifyId: identifier,
    uri: `spotify:track:${identifier}`,
    artist,
    title,
    isrc: null,
    popularity,
  };
}

const SEED = "a".repeat(22);
const NEXT = "b".repeat(22);
const LATER = "c".repeat(22);
const RECENT = "d".repeat(22);

test("autoplay requests ReccoBeats with the fixed seed and reuses its buffer", async () => {
  const seed = track(SEED, "Seed Artist", "Seed Song");
  const recommendationCalls = [];
  const resolveCalls = [];
  const client = {
    reccobeats: {
      async recommendations(anchor, recentUris) {
        recommendationCalls.push({ anchor, recentUris });
        return {
          targetPopularity: 60,
          tracks: [
            candidate(NEXT, "Next Artist", "Next Song", 60),
            candidate(LATER, "Later Artist", "Later Song", 58),
          ],
        };
      },
    },
    spotify: {
      async resolve(uri) {
        resolveCalls.push(uri);
        const id = uri.slice("spotify:track:".length);
        return { tracks: [track(id, `${id} Artist`, `${id} Song`)] };
      },
    },
  };
  const state = {
    autoplaySeed: seed,
    autoplayBuffer: [],
    lastTrack: track(LATER, "Drift Artist", "Drift Song"),
    recentTrackKeys: [],
    recentTrackUris: [`spotify:track:${SEED}`],
  };

  const first = await findAutoplayTrack(client, { previousTrack: null }, state);
  const second = await findAutoplayTrack(client, { previousTrack: null }, state);

  assert.equal(first.info.uri, `spotify:track:${NEXT}`);
  assert.equal(first.autoplaySource.spotifyId, NEXT);
  assert.equal(second.info.uri, `spotify:track:${LATER}`);
  assert.equal(recommendationCalls.length, 1);
  assert.equal(recommendationCalls[0].anchor, seed);
  assert.deepEqual(recommendationCalls[0].recentUris, [`spotify:track:${SEED}`]);
  assert.deepEqual(resolveCalls, [
    `spotify:track:${NEXT}`,
    `spotify:track:${LATER}`,
  ]);
});

test("autoplay skips recent recommendations before resolving", async () => {
  const seed = track(SEED, "Seed Artist", "Seed Song");
  const resolveCalls = [];
  const client = {
    reccobeats: {
      async recommendations() {
        return {
          targetPopularity: 40,
          tracks: [
            candidate(RECENT, "Recent Artist", "Recent Song", 40),
            candidate(NEXT, "Next Artist", "Next Song", 42),
          ],
        };
      },
    },
    spotify: {
      async resolve(uri) {
        resolveCalls.push(uri);
        const id = uri.slice("spotify:track:".length);
        return { tracks: [track(id, "Artist", "Song")] };
      },
    },
  };

  const result = await findAutoplayTrack(client, { previousTrack: null }, {
    autoplaySeed: seed,
    autoplayBuffer: [],
    recentTrackKeys: [],
    recentTrackUris: [`spotify:track:${RECENT}`],
  });

  assert.equal(result.info.uri, `spotify:track:${NEXT}`);
  assert.deepEqual(resolveCalls, [`spotify:track:${NEXT}`]);
});

test("a requested track replaces the station anchor and recommendation buffer", () => {
  const state = getPlayerState({}, "station-anchor");
  noteStationTrack(state, track(SEED, "Seed Artist", "Seed Song", { id: "user" }));
  state.autoplayBuffer = [candidate(NEXT, "Other", "Other")];
  noteStationTrack(state, track(NEXT, "Next Artist", "Next Song", { id: "user" }));

  assert.equal(state.autoplaySeed.info.uri, `spotify:track:${NEXT}`);
  assert.deepEqual(state.recentTrackUris, [`spotify:track:${NEXT}`]);
  assert.deepEqual(state.autoplayBuffer, []);
  assert.equal(state.autoplayCount, 0);
});

test("autoplay tracks keep the requested anchor", () => {
  const state = getPlayerState({}, "station-recent");
  noteStationTrack(state, track(SEED, "Seed Artist", "Seed Song", { id: "user" }));
  noteStationTrack(state, track(NEXT, "Other", "Next", "Autoplay"));

  assert.equal(state.autoplaySeed.info.uri, `spotify:track:${SEED}`);
  assert.equal(state.autoplayCount, 1);
  assert.deepEqual(state.recentTrackUris, [
    `spotify:track:${SEED}`,
    `spotify:track:${NEXT}`,
  ]);
});

test("autoplay queues a batch and leaves the remaining recommendation buffered", async () => {
  const ids = Array.from({ length: 13 }, (_, index) =>
    String(index).padStart(22, "0"),
  );
  const queue = [];
  queue.add = (item) => queue.push(item);
  let playCalls = 0;
  const client = {
    reccobeats: {
      async recommendations() {
        return {
          targetPopularity: 50,
          tracks: ids.map((id, index) =>
            candidate(id, `Artist ${index}`, `Song ${index}`),
          ),
        };
      },
    },
    spotify: {
      async resolve(uri) {
        const id = uri.slice("spotify:track:".length);
        return { tracks: [track(id, "Artist", "Song")] };
      },
    },
  };
  const state = getPlayerState(client, "batch");
  state.autoplaySeed = track(SEED, "Seed Artist", "Seed Song");
  state.recentTrackUris = [`spotify:track:${SEED}`];
  const player = {
    guildId: "batch",
    currentTrack: null,
    isPlaying: false,
    previousTrack: null,
    queue,
    async play() {
      playCalls += 1;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.equal(queue.length, 12);
  assert.ok(queue.every((item) => item.info.requester === "Autoplay"));
  assert.equal(state.autoplayBuffer.length, 1);
  assert.equal(playCalls, 1);
  assert.equal(player.isAutoPlay, true);
});
