import test from "node:test";
import assert from "node:assert/strict";
import {
  getSimilarTracks,
  normalizeSimilarTracks,
} from "../src/services/lastFm.js";

test("normalizeSimilarTracks removes incomplete results", () => {
  const tracks = normalizeSimilarTracks({
    similartracks: {
      track: [
        { name: "Song A", artist: { name: "Artist A" }, match: "0.9" },
        { name: "", artist: { name: "Artist B" } },
      ],
    },
  });

  assert.deepEqual(tracks, [
    { title: "Song A", artist: "Artist A", match: 0.9 },
  ]);
});

test("getSimilarTracks sends the required Last.fm parameters", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      async json() {
        return {
          similartracks: {
            track: { name: "Next", artist: { name: "Other" }, match: "1" },
          },
        };
      },
    };
  };

  const tracks = await getSimilarTracks({
    apiKey: "key",
    artist: "Seed Artist",
    title: "Seed Song",
    fetchImpl,
  });

  assert.equal(requestedUrl.searchParams.get("method"), "track.getSimilar");
  assert.equal(requestedUrl.searchParams.get("artist"), "Seed Artist");
  assert.equal(requestedUrl.searchParams.get("track"), "Seed Song");
  assert.equal(tracks[0].title, "Next");
});

test("getSimilarTracks requires an API key", async () => {
  await assert.rejects(
    getSimilarTracks({ apiKey: "", artist: "A", title: "B" }),
    /LASTFM_API_KEY/,
  );
});
