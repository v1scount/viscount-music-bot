import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FreqblogClient, RADIO_TIMEOUT_MS } from "../src/services/freqblogClient.js";
import { matchSpotifyTrack, similarCandidates } from "../src/services/freqblog.js";

const SEED_ISRC = "USUM71500001";
const OTHER_ISRC = "USUM71500002";

function seed(isrc = SEED_ISRC) {
  return {
    info: {
      uri: "spotify:track:seed",
      title: "Blinding Lights",
      author: "The Weeknd",
      isrc,
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function similarRow(track, genreRelation = "same") {
  return { genre_relation: genreRelation, score: 0.9, track };
}

function playlistBody() {
  return {
    results: [
      similarRow({
        itunes_track_id: "1",
        track_name: "Blinding Lights",
        artist_name: "The Weeknd",
        isrc: SEED_ISRC,
      }),
      similarRow({
        itunes_track_id: "2",
        track_name: "Save Your Tears",
        artist_name: "The Weeknd",
        isrc: OTHER_ISRC,
      }),
      similarRow({
        itunes_track_id: "2",
        track_name: "Save Your Tears",
        artist_name: "The Weeknd",
        isrc: OTHER_ISRC,
      }),
      similarRow(
        {
          itunes_track_id: "3",
          track_name: "Evidências",
          artist_name: "Chitãozinho & Xororó",
          isrc: "BRBMG0300001",
        },
        "cross",
      ),
    ],
  };
}

test("radio spends one call for 50 tracks and then serves the cache", async () => {
  const fetches = [];
  const client = new FreqblogClient({
    apiKey: "fb_test",
    cachePath: null,
    fetchImpl: async (url, options) => {
      fetches.push({ url, options });
      return jsonResponse(playlistBody());
    },
  });

  const first = await client.similar(seed());
  const second = await client.similar(seed());

  assert.equal(fetches.length, 1);
  const url = new URL(fetches[0].url);
  assert.equal(url.origin + url.pathname, "https://api.freqblog.com/similar");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("cross_genre"), "strict");
  assert.equal(url.searchParams.get("exclude_same_artist"), "false");
  assert.equal(url.searchParams.get("charted"), "true");
  assert.equal(url.searchParams.get("min_chart_peak"), "40");
  assert.equal(url.searchParams.get("isrc"), SEED_ISRC);
  assert.equal(url.searchParams.get("spotify_id"), null);
  assert.equal(url.searchParams.get("track"), null);
  assert.equal(fetches[0].options.headers["X-Api-Key"], "fb_test");
  assert.ok(RADIO_TIMEOUT_MS >= 30_000);
  assert.equal(fetches[0].options.signal.aborted, false);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.deepEqual(first.tracks, [
    { id: "2", title: "Save Your Tears", artist: "The Weeknd", isrc: OTHER_ISRC },
  ]);
  first.tracks[0].title = "mutated";
  assert.equal(second.tracks[0].title, "Save Your Tears");
});

test("radio seeds by title and artist when the recording has no ISRC", async () => {
  const fetches = [];
  const client = new FreqblogClient({
    apiKey: "fb_test",
    cachePath: null,
    fetchImpl: async (url) => {
      fetches.push(url);
      return jsonResponse({
        results: [
          similarRow({
            itunes_track_id: "9",
            track_name: "Song",
            artist_name: "Kanye West, GLC, Consequence",
            isrc: null,
          }),
          similarRow({ itunes_track_id: "10", track_name: "Next", artist_name: "Other", isrc: null }),
          similarRow(
            { itunes_track_id: "11", track_name: "Out", artist_name: "Elsewhere", isrc: null },
            "compatible",
          ),
        ],
      });
    },
  });

  const result = await client.similar({
    info: {
      uri: "spotify:track:song",
      title: "Song",
      author: "Kanye West, GLC, Consequence",
      isrc: null,
    },
  });

  const url = new URL(fetches[0]);
  assert.equal(url.searchParams.get("isrc"), null);
  assert.equal(url.searchParams.get("track"), "Song");
  assert.equal(url.searchParams.get("artist"), "Kanye West");
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].title, "Next");
});

test("a miss is remembered without another call", async () => {
  let fetches = 0;
  const client = new FreqblogClient({
    apiKey: "fb_test",
    cachePath: null,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({ detail: "missing" }, 404);
    },
  });

  const track = seed();
  assert.deepEqual(await client.similar(track), { tracks: [], fromCache: false });
  assert.deepEqual(await client.similar(track), { tracks: [], fromCache: true });
  assert.equal(fetches, 1);
});

test("a limit response pauses later calls", async () => {
  let fetches = 0;
  const client = new FreqblogClient({
    apiKey: "fb_test",
    cachePath: null,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({ detail: "quota" }, 429, { "retry-after": "30" });
    },
  });

  await assert.rejects(client.similar(seed()), /FreqBlog 429/);
  await assert.rejects(client.similar(seed()), /cooling down/);
  assert.equal(fetches, 1);
});

test("radio does not call FreqBlog without an API key", async () => {
  let fetches = 0;
  const client = new FreqblogClient({
    apiKey: "",
    cachePath: null,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({});
    },
  });

  await assert.rejects(client.similar(seed()), (error) => error.code === "missing_key");
  assert.equal(fetches, 0);
});

test("a playlist is reloaded from disk for the next process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "freqblog-"));
  const cachePath = path.join(dir, "freqblog-radio.json");
  try {
    let fetches = 0;
    const first = new FreqblogClient({
      apiKey: "fb_test",
      cachePath,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse(playlistBody());
      },
    });
    await first.similar(seed());

    const second = new FreqblogClient({
      apiKey: "fb_test",
      cachePath,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse(playlistBody());
      },
    });
    const cached = await second.similar(seed());
    assert.equal(fetches, 1);
    assert.equal(cached.fromCache, true);
    assert.equal(cached.tracks[0].title, "Save Your Tears");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a low chart peak is dropped and a hit in the genre stays", () => {
  const tracks = similarCandidates(
    {
      seed: { genre: "hip-hop", artist_name: "Kanye West", track_name: "Spaceship" },
      results: [
        {
          genre_relation: "same",
          track: {
            itunes_track_id: "1",
            track_name: "Letter To My Son",
            artist_name: "Mazza_l20",
            genre: "hip-hop",
            chart_peak: 5,
          },
        },
        {
          genre_relation: "same",
          track: {
            itunes_track_id: "2",
            track_name: "A Milli",
            artist_name: "Lil Wayne",
            genre: "hip-hop",
            chart_peak: 57,
          },
        },
      ],
    },
    { artist: "Kanye West", title: "Spaceship" },
  );

  assert.deepEqual(
    tracks.map((track) => track.title),
    ["A Milli"],
  );
});

test("tracks that fall away from the closest match are left out", () => {
  const row = (title, artist, score) => ({
    genre_relation: "same",
    score,
    track: {
      itunes_track_id: title,
      track_name: title,
      artist_name: artist,
      genre: "hip-hop",
      chart_peak: 80,
    },
  });
  const tracks = similarCandidates(
    {
      seed: { genre: "hip-hop", artist_name: "Lil Wayne", track_name: "Comfortable" },
      results: [
        row("Trap Queen", "Fetty Wap", 0.914),
        row("Best I Ever Had", "Drake", 0.912),
        row("Right On", "Lil Baby", 0.9),
        row("Weck mich auf 2026", "Finity & Tyaz", 0.891),
        row("Satasen laina", "Ares", 0.889),
      ],
    },
    { artist: "Lil Wayne", title: "Comfortable" },
  );

  assert.deepEqual(
    tracks.map((track) => track.title),
    ["Trap Queen", "Best I Ever Had", "Right On"],
  );
});

test("similar stays in the genre and leads with related artists", () => {
  const tracks = similarCandidates(
    {
      seed: { genre: "hip-hop", artist_name: "Kanye West", track_name: "PREACHER MAN" },
      results: [
        {
          genre_relation: "same",
          track: {
            itunes_track_id: "1",
            track_name: "Relação ou Prisão",
            artist_name: "Mc Davi",
            genre: "funk",
          },
        },
        {
          genre_relation: "same",
          track: {
            itunes_track_id: "2",
            track_name: "Up It",
            artist_name: "VonOff1700",
            genre: "hip-hop",
          },
        },
        {
          genre_relation: "same",
          track: {
            itunes_track_id: "3",
            track_name: "Follow God",
            artist_name: "Kanye West",
            genre: "hip-hop",
          },
        },
        {
          genre_relation: "cross",
          track: {
            itunes_track_id: "4",
            track_name: "Evidências",
            artist_name: "Chitãozinho & Xororó",
            genre: "sertanejo",
          },
        },
      ],
    },
    { artist: "Kanye West, Ye", title: "PREACHER MAN" },
  );

  assert.deepEqual(
    tracks.map((track) => track.title),
    ["Up It", "Follow God"],
  );
});

test("a long same-artist run is mixed behind other artists in the genre", () => {
  const artist = (name, title) => ({
    itunes_track_id: title,
    track_name: title,
    artist_name: name,
    genre: "metal",
  });
  const tracks = similarCandidates(
    {
      seed: { genre: "metal", artist_name: "Ozzy Osbourne", track_name: "No More Tears" },
      results: [
        artist("Ozzy Osbourne", "Mama I'm Coming Home"),
        artist("Ozzy Osbourne", "Crazy Train"),
        artist("Ozzy Osbourne", "Mr. Crowley"),
        artist("Ozzy Osbourne", "Shot in the Dark"),
        artist("Ozzy Osbourne", "Bark at the Moon"),
        artist("TOOL", "Sober"),
        artist("Dio", "Holy Diver"),
        artist("Judas Priest", "Painkiller"),
        artist("Samson", "Riding with the Angels"),
        artist("Arkangel", "No More Fear"),
      ].map((track) => ({ genre_relation: "same", track })),
    },
    { artist: "Ozzy Osbourne", title: "No More Tears" },
  );

  assert.deepEqual(tracks.slice(0, 5).map((track) => track.artist), [
    "TOOL",
    "Dio",
    "Judas Priest",
    "Ozzy Osbourne",
    "Samson",
  ]);
  assert.equal(tracks.filter((track) => track.artist === "Ozzy Osbourne").length, 1);
});

test("Spotify matching prefers ISRC and still accepts the title", () => {
  const byIsrc = {
    info: { uri: "spotify:track:isrc", title: "Other Name", author: "Other", isrc: SEED_ISRC },
  };
  const byName = {
    info: { uri: "spotify:track:name", title: "Titi", author: "The Weeknd", isrc: null },
  };
  const differentRecording = {
    info: { uri: "spotify:track:no", title: "Titi", author: "The Weeknd", isrc: OTHER_ISRC },
  };

  assert.equal(
    matchSpotifyTrack(
      { title: "Tití", artist: "The Weeknd", isrc: SEED_ISRC },
      [byName, byIsrc],
    ).info.uri,
    "spotify:track:isrc",
  );
  assert.equal(
    matchSpotifyTrack({ title: "Tití", artist: "The Weeknd", isrc: null }, [byName]).info.uri,
    "spotify:track:name",
  );
  assert.equal(
    matchSpotifyTrack({ title: "Tití", artist: "The Weeknd", isrc: SEED_ISRC }, [differentRecording]),
    null,
  );
});
