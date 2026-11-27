import test from "node:test";
import assert from "node:assert/strict";
import {
  POPULARITY_WINDOW,
  arrangeStation,
  needsArtistExclusion,
  recommendationCandidates,
  sanitizeRecommendationBuffer,
  spotifyTrackId,
} from "../src/services/reccobeats.js";
import { ReccoBeatsClient } from "../src/services/reccobeatsClient.js";

const SEED = "a".repeat(22);
const RECENT = "b".repeat(22);
const CLOSE = "c".repeat(22);
const CLOSER = "d".repeat(22);
const FAR = "e".repeat(22);
const SEED_ARTIST = "f".repeat(22);
const OTHER_ARTIST = "g".repeat(22);
const THIRD_ARTIST = "h".repeat(22);

function trackRow(spotifyId, popularity, title = spotifyId, artist = "Artist", artistId = null) {
  return {
    id: `recco-${spotifyId}`,
    trackTitle: title,
    artists: [
      {
        name: artist,
        ...(artistId ? { id: artistId, href: `https://open.spotify.com/artist/${artistId}` } : {}),
      },
    ],
    href: `https://open.spotify.com/track/${spotifyId}`,
    isrc: "USRC17607839",
    popularity,
  };
}

function candidate(spotifyId, artist, artistId = null) {
  return {
    spotifyId,
    uri: `spotify:track:${spotifyId}`,
    title: artist,
    artist,
    ...(artistId ? { artistId } : {}),
    popularity: 60,
  };
}

test("Spotify track ids are accepted from librespot tracks and ReccoBeats hrefs", () => {
  assert.equal(spotifyTrackId({ info: { uri: `spotify:track:${SEED}` } }), SEED);
  assert.equal(
    spotifyTrackId({ href: `https://open.spotify.com/track/${SEED}` }),
    SEED,
  );
  assert.equal(spotifyTrackId({ info: { identifier: SEED } }), SEED);
  assert.equal(spotifyTrackId({ info: { uri: "spotify:album:not-a-track" } }), null);
});

test("recommendations stay inside the popularity window and closest tracks lead", () => {
  const candidates = recommendationCandidates(
    {
      content: [
        trackRow(SEED, 60, "Seed"),
        trackRow(CLOSE, 67, "Close"),
        trackRow(FAR, 60 + POPULARITY_WINDOW + 1, "Too far"),
        trackRow(CLOSER, 61, "Closer"),
      ],
    },
    { info: { uri: `spotify:track:${SEED}` } },
    60,
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.spotifyId),
    [CLOSER, CLOSE],
  );
});

test("other artists lead and the seed artist is spaced through the station", () => {
  const seedArtist = { id: SEED_ARTIST, name: "Seed Artist" };
  const arranged = arrangeStation(
    [
      candidate(CLOSE, "Seed Artist", SEED_ARTIST),
      candidate(CLOSER, "Seed Artist", SEED_ARTIST),
      candidate(`${"i".repeat(22)}`, "Alpha", OTHER_ARTIST),
      candidate(`${"j".repeat(22)}`, "Alpha", OTHER_ARTIST),
      candidate(`${"k".repeat(22)}`, "Beta", THIRD_ARTIST),
    ],
    seedArtist,
  );

  assert.deepEqual(
    arranged.map((item) => item.artist),
    ["Alpha", "Beta", "Alpha", "Seed Artist"],
  );
  assert.equal(needsArtistExclusion(arranged, seedArtist), false);
});

test("a seed-artist heavy list asks for another pass without that artist", () => {
  const seedArtist = { id: SEED_ARTIST, name: "Seed Artist" };
  const sticky = [
    candidate(CLOSE, "Seed Artist", SEED_ARTIST),
    candidate(CLOSER, "Seed Artist", SEED_ARTIST),
    candidate(FAR, "Neighbor", OTHER_ARTIST),
  ];
  assert.equal(needsArtistExclusion(sticky, seedArtist), true);
});

test("client sends seed popularity and recent tracks to ReccoBeats", async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname.endsWith("/track")) {
      return Response.json({
        content: [trackRow(SEED, 72, "Seed", "Seed Artist", SEED_ARTIST)],
      });
    }
    return Response.json({
      content: [
        trackRow(CLOSE, 68, "Close", "Other", OTHER_ARTIST),
        trackRow(CLOSER, 72, "Closest", "Closer", THIRD_ARTIST),
        trackRow(FAR, 40, "Far", "Far Artist", "i".repeat(22)),
      ],
    });
  };
  const client = new ReccoBeatsClient({
    apiUrl: "https://example.test/v1",
    fetchImpl,
  });

  const result = await client.recommendations(
    { info: { uri: `spotify:track:${SEED}` } },
    [`spotify:track:${SEED}`, `spotify:track:${RECENT}`],
  );

  const request = urls.find((url) => url.pathname.endsWith("/track/recommendation"));
  assert.ok(request);
  assert.equal(request.searchParams.get("seeds"), SEED);
  assert.equal(request.searchParams.get("negativeSeeds"), RECENT);
  assert.equal(request.searchParams.get("popularity"), "72");
  assert.equal(request.searchParams.get("size"), "50");
  assert.equal(result.targetPopularity, 72);
  assert.equal(result.excludedArtist, false);
  assert.equal(urls.filter((url) => url.hostname === "example.test").length, 2);
  assert.deepEqual(
    result.tracks.map((item) => item.spotifyId),
    [CLOSER, CLOSE],
  );
});

test("a sticky recommendation excludes the seed artist on a second request", async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname.endsWith("/track")) {
      return Response.json({
        content: [trackRow(SEED, 70, "Seed", "Seed Artist", SEED_ARTIST)],
      });
    }
    if (url.searchParams.get("negativeSeeds")?.includes(SEED_ARTIST)) {
      return Response.json({
        content: [
          trackRow(CLOSE, 70, "Neighbor", "Neighbor", OTHER_ARTIST),
          trackRow(CLOSER, 69, "Another", "Another", THIRD_ARTIST),
        ],
      });
    }
    return Response.json({
      content: [
        trackRow(FAR, 70, "Again", "Seed Artist", SEED_ARTIST),
        trackRow("i".repeat(22), 71, "Again too", "Seed Artist", SEED_ARTIST),
        trackRow(CLOSE, 68, "One neighbor", "Neighbor", OTHER_ARTIST),
      ],
    });
  };
  const client = new ReccoBeatsClient({
    apiUrl: "https://example.test/v1",
    fetchImpl,
  });

  const result = await client.recommendations(
    { info: { uri: `spotify:track:${SEED}` } },
    [`spotify:track:${RECENT}`],
  );

  assert.equal(result.excludedArtist, true);
  const reccobeatsUrls = urls.filter((url) => url.hostname === "example.test");
  assert.equal(reccobeatsUrls.length, 3);
  assert.equal(reccobeatsUrls[2].searchParams.get("negativeSeeds"), `${SEED_ARTIST},${RECENT}`);
  assert.deepEqual(
    result.tracks.map((item) => item.spotifyId),
    [CLOSE, CLOSER],
  );
});

test("persisted recommendation buffers are normalized and deduplicated", () => {
  const buffer = sanitizeRecommendationBuffer([
    {
      spotifyId: CLOSE,
      title: " Song ",
      artist: " Artist ",
      popularity: 55,
    },
    {
      uri: `spotify:track:${CLOSE}`,
      title: "Duplicate",
      artist: "Artist",
      popularity: 55,
    },
    { spotifyId: "invalid", title: "Bad", artist: "Artist" },
  ]);

  assert.deepEqual(buffer, [
    {
      id: "",
      spotifyId: CLOSE,
      uri: `spotify:track:${CLOSE}`,
      title: "Song",
      artist: "Artist",
      isrc: null,
      popularity: 55,
    },
  ]);
});
