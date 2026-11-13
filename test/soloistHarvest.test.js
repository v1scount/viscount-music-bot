import test from "node:test";
import assert from "node:assert/strict";
import {
  dropQueuedAutoplay,
  harvestSeed,
  startAutoplay,
} from "../src/services/autoplay.js";
import { harvestOnSocket, tracksFromQueue } from "../src/services/soloistClient.js";
import { getPlayerState } from "../src/utils/playerState.js";

const SEED = "aaaaaaaaaaaaaaaaaaaaaa";
const NEXT = "bbbbbbbbbbbbbbbbbbbbbb";
const LATER = "cccccccccccccccccccccc";

function track(identifier, requester = null, title = identifier) {
  return {
    info: {
      identifier,
      uri: `spotify:track:${identifier}`,
      sourceName: "spotify",
      author: "Artist",
      title,
      requester,
    },
  };
}

function queueOf(...tracks) {
  const queue = [...tracks];
  queue.add = (item) => {
    queue.push(item);
    return queue;
  };
  return queue;
}

function row(identifier, source, name = identifier) {
  return {
    source,
    item: {
      uri: `spotify:track:${identifier}`,
      entity_type: "track",
      decorations: {
        identity: { name },
        creators: [
          {
            uri: "spotify:artist:dddddddddddddddddddddd",
            decorations: { identity: { name: "Artist" } },
          },
        ],
        playback: { duration_ms: 180000 },
        visual_identity: { cover: [{ url: "https://i.scdn.co/cover", size: "large" }] },
      },
    },
  };
}

function fakeSocket(respond) {
  /** @type {Record<string, ((event: { data: string }) => void)[]>} */
  const listeners = {};
  return {
    readyState: 1,
    sent: [],
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    send(data) {
      const command = JSON.parse(data);
      this.sent.push(command);
      const replies = respond(command) ?? [];
      for (const reply of replies) {
        queueMicrotask(() => {
          for (const fn of listeners.message ?? []) {
            fn({ data: JSON.stringify(reply) });
          }
        });
      }
    },
    close() {
      this.readyState = 3;
    },
  };
}

function commandResult(command) {
  return [{ type: "command_result", command }];
}

test("queue rows keep autoplay tracks and drop the seed, context, and recent uris", () => {
  const tracks = tracksFromQueue(
    {
      type: "queue_changed",
      upcoming: [
        row(SEED, "context", "Seed"),
        row(NEXT, "autoplay", "Next"),
        row("eeeeeeeeeeeeeeeeeeeeee", "queue", "Manual"),
        row(LATER, "autoplay", "Later"),
        row(NEXT, "autoplay", "Next again"),
      ],
    },
    `spotify:track:${SEED}`,
    [`spotify:track:${LATER}`],
  );

  assert.deepEqual(tracks.map((item) => item.info.uri), [`spotify:track:${NEXT}`]);
  assert.equal(tracks[0].info.title, "Next");
  assert.equal(tracks[0].info.author, "Artist");
  assert.equal(tracks[0].info.length, 180000);
  assert.equal(tracks[0].info.artworkUrl, "https://i.scdn.co/cover");
  assert.equal(tracks[0].info.requester, "Autoplay");
});

test("harvest reads the autoplay list, then pauses and deactivates", async () => {
  const socket = fakeSocket((command) => {
    if (command.command === "get_state") {
      return [{
        type: "playback_state",
        options: { modes: { context_enhancement: "RECOMMENDATION" } },
      }];
    }
    if (command.command === "get_queue") {
      return [{
        type: "queue_changed",
        upcoming: [row(SEED, "context", "Seed"), row(NEXT, "autoplay", "Next"), row(LATER, "autoplay", "Later")],
      }];
    }
    if (command.command === "pause" || command.command === "deactivate") return [];
    return commandResult(command.command);
  });

  const result = await harvestOnSocket(socket, {
    seedUri: `spotify:track:${SEED}`,
    recentUris: [],
    timeoutMs: 2000,
  });

  assert.deepEqual(result.tracks.map((item) => item.info.title), ["Next", "Later"]);
  assert.equal(result.recommendations, true);
  assert.deepEqual(
    socket.sent.map((command) => command.command),
    ["set_repeat_track", "set_repeat_context", "set_volume", "play", "get_state", "get_queue", "get_queue", "pause", "deactivate"],
  );
  assert.equal(socket.sent[2].volume, 0);
  assert.equal(socket.sent[3].uri, `spotify:track:${SEED}`);
  assert.equal(socket.sent[1].enabled, false);
});

test("a disabled recommendation mode returns without waiting", async () => {
  const socket = fakeSocket((command) => {
    if (command.command === "get_state") {
      return [{
        type: "playback_state",
        options: { modes: { context_enhancement: "NONE" } },
      }];
    }
    if (command.command === "get_queue") return [{ type: "queue_changed", upcoming: [] }];
    if (command.command === "pause" || command.command === "deactivate") return [];
    return commandResult(command.command);
  });

  const started = Date.now();
  const result = await harvestOnSocket(socket, {
    seedUri: `spotify:track:${SEED}`,
    timeoutMs: 8000,
  });

  assert.deepEqual(result.tracks, []);
  assert.equal(result.recommendations, false);
  assert.ok(Date.now() - started < 1000);
  assert.ok(socket.sent.some((command) => command.command === "deactivate"));
});

test("a played autoplay track becomes the next harvest seed", () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const played = track(NEXT, "Autoplay", "Played");
  const seed = harvestSeed(
    { previousTrack: played },
    { autoplaySeed: requested, lastTrack: requested },
  );
  assert.equal(seed.info.uri, `spotify:track:${NEXT}`);
});

test("a finished request keeps the last requested track as the seed", () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const seed = harvestSeed(
    { previousTrack: requested },
    { autoplaySeed: requested },
  );
  assert.equal(seed.info.uri, `spotify:track:${SEED}`);
});

test("a new request removes queued autoplay tracks and leaves requested ones", () => {
  const queue = queueOf(
    track(NEXT, "Autoplay", "Old"),
    track(SEED, { id: "user" }, "Kept"),
    track(LATER, "Autoplay", "Also old"),
  );

  assert.equal(dropQueuedAutoplay(queue), 2);
  assert.deepEqual(queue.map((item) => item.info.uri), [`spotify:track:${SEED}`]);
});

test("soloist rows are queued and the built-in radio is not asked", async () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const client = {
    guildId: "harvest-queue",
    soloist: {
      enabled: true,
      async harvest(uri, recent) {
        client.harvests.push({ uri, recent });
        return [track(NEXT, null, "Next"), track(LATER, null, "Later")];
      },
    },
    harvests: [],
    radioCalls: 0,
    stops: 0,
    spotify: {
      async stop() {
        client.stops += 1;
      },
      async radio() {
        client.radioCalls += 1;
        return { tracks: [] };
      },
      async resolve() {
        throw new Error("titled rows do not need resolve");
      },
    },
  };
  const state = getPlayerState(client, "soloist-queue");
  state.autoplay = true;
  state.autoplaySeed = requested;
  state.recentTrackUris = [`spotify:track:${SEED}`];
  const player = {
    guildId: "soloist-queue",
    queue: queueOf(),
    currentTrack: null,
    isPlaying: false,
    previousTrack: requested,
    async play() {
      this.currentTrack = this.queue.shift();
      this.isPlaying = true;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.equal(client.stops, 1);
  assert.equal(client.radioCalls, 0);
  assert.deepEqual(client.harvests, [{
    uri: `spotify:track:${SEED}`,
    recent: [`spotify:track:${SEED}`],
  }]);
  assert.equal(player.currentTrack.info.uri, `spotify:track:${NEXT}`);
  assert.equal(player.currentTrack.info.requester, "Autoplay");
  assert.equal(player.queue[0].info.uri, `spotify:track:${LATER}`);
  assert.equal(player.isAutoPlay, true);
});

test("a soloist miss queues the radio batch and does not harvest again", async () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const fallback = track(NEXT, null, "Radio");
  const another = track(LATER, null, "Another");
  let harvests = 0;
  const client = {
    soloist: {
      enabled: true,
      async harvest() {
        harvests += 1;
        return { tracks: [], recommendations: false };
      },
    },
    spotify: {
      async stop() {},
      async radio() {
        return { tracks: [requested, fallback, another] };
      },
    },
  };
  const state = getPlayerState(client, "soloist-fallback");
  state.autoplay = true;
  state.autoplaySeed = requested;
  state.recentTrackKeys = [];
  state.recentTrackUris = [];
  const player = {
    guildId: "soloist-fallback",
    queue: queueOf(),
    currentTrack: null,
    isPlaying: false,
    previousTrack: requested,
    async play() {
      this.currentTrack = this.queue.shift();
      this.isPlaying = true;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.equal(player.currentTrack.info.uri, `spotify:track:${NEXT}`);
  assert.equal(player.queue[0].info.uri, `spotify:track:${LATER}`);
  assert.equal(state.soloistRecommendations, false);

  player.currentTrack = null;
  player.isPlaying = false;
  player.previousTrack = fallback;
  player.queue = queueOf();
  assert.equal(await startAutoplay(client, player), true);
  assert.equal(harvests, 1);
});

test("a row without a title is resolved after the harvest", async () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const resolved = track(NEXT, null, "Resolved");
  let resolvedUri = null;
  const client = {
    soloist: {
      enabled: true,
      async harvest() {
        return [{ info: { uri: `spotify:track:${NEXT}`, title: null } }];
      },
    },
    spotify: {
      async stop() {},
      async radio() {
        return { tracks: [] };
      },
      async resolve(uri) {
        resolvedUri = uri;
        return { tracks: [resolved] };
      },
    },
  };
  const state = getPlayerState(client, "soloist-resolve");
  state.autoplay = true;
  state.autoplaySeed = requested;
  state.recentTrackKeys = [];
  state.recentTrackUris = [];
  const player = {
    guildId: "soloist-resolve",
    queue: queueOf(),
    currentTrack: null,
    isPlaying: false,
    previousTrack: requested,
    async play() {
      this.currentTrack = this.queue.shift();
      this.isPlaying = true;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.equal(resolvedUri, `spotify:track:${NEXT}`);
  assert.equal(player.currentTrack.info.title, "Resolved");
  assert.equal(player.currentTrack.info.requester, "Autoplay");
});

test("continuation harvest uses the autoplay track that just finished", async () => {
  const requested = track(SEED, { id: "user" }, "Requested");
  const played = track(NEXT, "Autoplay", "Played");
  const client = {
    seeds: [],
    soloist: {
      enabled: true,
      async harvest(uri) {
        client.seeds.push(uri);
        return [track(LATER, null, "Further")];
      },
    },
    spotify: {
      async stop() {},
      async radio() {
        throw new Error("radio should not run");
      },
    },
  };
  const state = getPlayerState(client, "soloist-continue");
  state.autoplay = true;
  state.autoplaySeed = requested;
  state.recentTrackKeys = [];
  state.recentTrackUris = [`spotify:track:${SEED}`, `spotify:track:${NEXT}`];
  const player = {
    guildId: "soloist-continue",
    queue: queueOf(),
    currentTrack: null,
    isPlaying: false,
    previousTrack: played,
    async play() {
      this.currentTrack = this.queue.shift();
      this.isPlaying = true;
    },
  };

  assert.equal(await startAutoplay(client, player), true);
  assert.deepEqual(client.seeds, [`spotify:track:${NEXT}`]);
  assert.equal(player.currentTrack.info.uri, `spotify:track:${LATER}`);
});
