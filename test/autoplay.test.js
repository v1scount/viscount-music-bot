import test from "node:test";
import assert from "node:assert/strict";
import { findAutoplayTrack, startAutoplay } from "../src/services/autoplay.js";
import { seedKey } from "../src/services/freqblog.js";
import { getPlayerState, noteStationTrack } from "../src/utils/playerState.js";

function track(identifier, author, title, requester = null, artistId = null, isrc = null) {
  return {
    info: {
      identifier,
      uri: `spotify:track:${identifier}`,
      sourceName: "spotify",
      author,
      title,
      artistId,
      isrc,
      requester,
    },
  };
}

const SEED_ARTIST = "a".repeat(22);
const NEXT_ARTIST = "b".repeat(22);

function candidate(artist, title, isrc = null) {
  return { id: title, artist, title, isrc };
}

function clientFor(radioTracks, options = {}) {
  const calls = [];
  const searches = [];
  const client = {
    calls,
    searches,
    freqblog: {
      async similar(seedTrack) {
        calls.push(seedTrack);
        if (options.fail) {
          const error = new Error("Missing FREQBLOG_API_KEY");
          error.code = options.fail;
          throw error;
        }
        return { fromCache: false, tracks: radioTracks };
      },
    },
    spotify: {
      async search(query) {
        searches.push(query);
        const splitAt = query.indexOf(" ");
        const artist = splitAt === -1 ? query : query.slice(0, splitAt);
        const title = splitAt === -1 ? query : query.slice(splitAt + 1);
        return {
          tracks: [
            track("decoy", "Someone Else", "Different"),
            track(title.toLowerCase().replaceAll(" ", "-"), artist, title),
          ],
        };
      },
    },
  };
  return client;
}

test("one FreqBlog radio call is reused for the next autoplay tracks", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song", null, null, "USUM71500001");
  const playlist = [
    candidate("Other", "Old"),
    candidate("Other", "Next Song"),
    candidate("Further", "Later Song"),
  ];
  const client = clientFor(playlist);

  const state = {
    autoplaySeed: seed,
    autoplayCount: 0,
    lastTrack: track("drift", "Other", "Drift"),
    recentArtistIds: [SEED_ARTIST],
    recentTrackKeys: ["old", "other:old"],
    recentTrackUris: ["spotify:track:seed", "spotify:track:old"],
  };

  const first = await findAutoplayTrack(client, { previousTrack: null }, state);
  const second = await findAutoplayTrack(client, { previousTrack: null }, state);

  assert.equal(first.info.uri, "spotify:track:next-song");
  assert.equal(first.info.requester, null);
  assert.equal(second.info.uri, "spotify:track:later-song");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].info.isrc, "USUM71500001");
  assert.deepEqual(client.searches, ["Other Next Song", "Further Later Song"]);
  assert.equal(state.autoplayBuffer.length, 0);
});

test("a used-up playlist does not walk off the original song", async () => {
  const anchor = track("seed", "Seed Artist", "Seed Song");
  const last = track("wider", "Further", "Further Song");
  const client = clientFor([candidate("Next", "After That")]);

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    {
      autoplaySeed: anchor,
      autoplayFetchedKeys: [seedKey(anchor)],
      autoplayBuffer: [],
      lastTrack: last,
      recentTrackKeys: [],
      recentTrackUris: [],
    },
  );

  assert.equal(result, null);
  assert.equal(client.calls.length, 0);
});

test("autoplay returns null when radio has nothing new and does not ask again", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const client = clientFor([]);
  const state = { lastTrack: seed, recentTrackKeys: [], recentTrackUris: [] };

  assert.equal(await findAutoplayTrack(client, { previousTrack: null }, state), null);
  assert.equal(await findAutoplayTrack(client, { previousTrack: null }, state), null);
  assert.equal(client.calls.length, 1);
});

test("a failed Spotify search is skipped and the rest of the playlist stays", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const playlist = [
    candidate("Sweet", "Broken"),
    candidate("Other", "Next Song"),
    candidate("Further", "Later Song"),
  ];
  const client = clientFor(playlist);
  client.spotify.search = async (query) => {
    client.searches.push(query);
    if (query.startsWith("Sweet ")) {
      throw new Error('Spotify engine 502: {"error":"search"}');
    }
    const splitAt = query.indexOf(" ");
    const artist = query.slice(0, splitAt);
    const title = query.slice(splitAt + 1);
    return {
      tracks: [track(title.toLowerCase().replaceAll(" ", "-"), artist, title)],
    };
  };

  const state = {
    autoplaySeed: seed,
    lastTrack: seed,
    recentTrackKeys: [],
  };
  const result = await findAutoplayTrack(client, { previousTrack: null }, state);

  assert.equal(result.info.title, "Next Song");
  assert.equal(client.calls.length, 1);
  assert.equal(state.autoplayBuffer.length, 1);
  assert.equal(state.autoplayBuffer[0].title, "Later Song");
});

test("search errors do not spend another radio call", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const client = clientFor([candidate("A", "One"), candidate("B", "Two")]);
  client.spotify.search = async (query) => {
    client.searches.push(query);
    throw new Error('Spotify engine 502: {"error":"search"}');
  };
  const state = {
    autoplaySeed: seed,
    lastTrack: track("other", "Other Artist", "Other Song"),
    recentTrackKeys: [],
  };

  assert.equal(await findAutoplayTrack(client, { previousTrack: null }, state), null);
  assert.equal(client.calls.length, 1);
  assert.equal(client.searches.length, 2);
});

test("autoplay queues the station so the next songs stay visible", async () => {
  const playlist = [1, 2, 3, 4, 5, 6].map((number) => candidate("Band", `Song ${number}`));
  const client = clientFor(playlist);
  noteStationTrack(
    getPlayerState(client, "runway-guild"),
    track("seed", "Seed Artist", "Seed Song", { id: "user" }),
  );
  const added = [];
  const player = {
    guildId: "runway-guild",
    currentTrack: null,
    isPlaying: false,
    isAutoPlay: false,
    queue: {
      length: 0,
      add(track) {
        added.push(track);
        this.length += 1;
      },
    },
    async play() {
      this.isPlaying = true;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.deepEqual(
    added.map((item) => item.info.title),
    ["Song 1", "Song 2", "Song 3", "Song 4", "Song 5", "Song 6"],
  );
  assert.equal(added.every((item) => item.info.requester === "Autoplay"), true);
  assert.equal(client.calls.length, 1);
  assert.equal(getPlayerState(client, "runway-guild").autoplayBuffer.length, 0);
});

test("autoplay stays quiet when the FreqBlog key is missing", async () => {
  const seed = track("seed", "Seed Artist", "Seed Song");
  const client = clientFor([], { fail: "missing_key" });
  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    { autoplaySeed: seed, recentTrackKeys: [] },
  );
  assert.equal(result, null);
  assert.equal(client.searches.length, 0);
});

test("a requested track replaces the station anchor and artist list", () => {
  const state = getPlayerState({}, "station-anchor");
  state.autoplayBuffer = [{ id: "1", title: "Old", artist: "Old", isrc: null }];
  state.autoplayFetchedKeys = ["name:old|old"];
  noteStationTrack(state, track("seed", "Seed Artist", "Seed Song", { id: "user" }, SEED_ARTIST));
  noteStationTrack(state, track("auto", "Other", "Auto", "Autoplay", NEXT_ARTIST));
  noteStationTrack(state, track("next", "Other", "Next", { id: "user" }, "c".repeat(22)));

  assert.equal(state.autoplaySeed.info.uri, "spotify:track:next");
  assert.deepEqual(state.recentTrackUris, ["spotify:track:next"]);
  assert.deepEqual(state.recentArtistIds, ["c".repeat(22)]);
  assert.equal(state.autoplayCount, 0);
  assert.deepEqual(state.autoplayBuffer, []);
  assert.deepEqual(state.autoplayFetchedKeys, []);
});

test("autoplay tracks extend the recent uri list, remember artists, and keep the anchor", () => {
  const state = getPlayerState({}, "station-recent");
  noteStationTrack(state, track("seed", "Seed Artist", "Seed Song", { id: "user" }, SEED_ARTIST));
  state.autoplayBuffer = [{ id: "1", title: "Kept", artist: "Kept", isrc: null }];
  state.autoplayFetchedKeys = ["name:seed artist|seed song"];
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
  assert.equal(state.autoplayBuffer[0].title, "Kept");
  assert.deepEqual(state.autoplayFetchedKeys, ["name:seed artist|seed song"]);
});
