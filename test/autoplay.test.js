import test from "node:test";
import assert from "node:assert/strict";
import {
  buildYoutubeMixUrl,
  findAutoplayTrack,
} from "../src/services/autoplay.js";

function track(identifier, sourceName, author, title) {
  return {
    info: { identifier, sourceName, author, title },
  };
}

test("buildYoutubeMixUrl uses the YouTube radio playlist", () => {
  assert.equal(
    buildYoutubeMixUrl("abc123"),
    "https://www.youtube.com/watch?v=abc123&list=RDabc123",
  );
});

test("autoplay converts non-YouTube seeds before loading a mix", async () => {
  const seed = track("spotify-id", "spotify", "Seed Artist", "Seed Song");
  const youtubeSeed = track("youtube-seed", "youtube", "Seed Artist", "Seed Song");
  const recommendation = track("recommended", "youtube", "Other", "Next Song");
  const queries = [];
  const client = {
    poru: {
      async resolve(options) {
        queries.push(options);
        if (options.source === "ytmsearch") {
          return { loadType: "search", tracks: [youtubeSeed] };
        }
        return {
          loadType: "playlist",
          tracks: [youtubeSeed, recommendation],
        };
      },
    },
  };

  const result = await findAutoplayTrack(
    client,
    { previousTrack: null },
    { lastTrack: seed, recentTrackKeys: [] },
    () => 0,
  );

  assert.equal(result, recommendation);
  assert.equal(queries[0].source, "ytmsearch");
  assert.match(queries[1].query, /list=RDyoutube-seed/);
});
