import test from "node:test";
import assert from "node:assert/strict";
import {
  clearGenreCache,
  filterSameGenre,
  genreFamily,
  primaryArtistName,
  sameStationGenre,
} from "../src/services/genre.js";
import { arrangeStation } from "../src/services/reccobeats.js";
import { ReccoBeatsClient } from "../src/services/reccobeatsClient.js";

const SEED = "a".repeat(22);
const DURK = "b".repeat(22);
const SZA = "c".repeat(22);
const KENNY = "d".repeat(22);
const PANTERA = "e".repeat(22);
const KANYE = "f".repeat(22);

test("genre families keep hip-hop with R&B and rock with metal", () => {
  assert.equal(genreFamily("Hip-Hop/Rap"), "hip-hop");
  assert.equal(genreFamily("R&B/Soul"), "r&b");
  assert.equal(genreFamily("Modern Dancehall"), "dancehall");
  assert.equal(genreFamily("Urbano latino"), "latin-urban");
  assert.equal(genreFamily("Bollywood"), "indian");
  assert.equal(sameStationGenre("hip-hop", "r&b"), true);
  assert.equal(sameStationGenre("hip-hop", "country"), false);
  assert.equal(sameStationGenre("hip-hop", "dancehall"), false);
  assert.equal(sameStationGenre("rock", "metal"), true);
  assert.equal(sameStationGenre("rock", "alternative"), true);
  assert.equal(primaryArtistName("Tyler, The Creator"), "Tyler, The Creator");
  assert.equal(primaryArtistName("Kanye West, Jay-Z"), "Kanye West");
});

test("round-robin only mixes artists from the seed genre", async () => {
  clearGenreCache();
  const fetchImpl = async (input) => {
    const term = new URL(input).searchParams.get("term") ?? "";
    const found = CATALOG.find(([artist, title]) => term === `${artist} ${title}`);
    if (!found) return Response.json({ resultCount: 0, results: [] });
    const [artist, title, genre] = found;
    return Response.json({
      resultCount: 1,
      results: [{ kind: "song", artistName: artist, trackName: title, primaryGenreName: genre }],
    });
  };

  const candidates = [
    track(KENNY, "Kenny Chesney", "Country Song"),
    track(PANTERA, "Pantera", "Metal Song"),
    track(DURK, "Lil Durk", "Rap Song"),
    track(SZA, "SZA", "Soul Song"),
    track(KANYE, "Kanye West", "Again"),
  ];
  const filtered = await filterSameGenre(
    candidates,
    { artist: "Kanye West", title: "Anchor" },
    fetchImpl,
  );
  assert.equal(filtered.genre, "hip-hop");
  assert.deepEqual(
    arrangeStation(filtered.tracks, { id: KANYE, name: "Kanye West" }).map((item) => item.artist),
    ["Lil Durk", "SZA", "Kanye West"],
  );
});

test("a failed genre lookup leaves the recommendation list alone", async () => {
  clearGenreCache();
  const tracks = [track(DURK, "Lil Durk", "All Love")];
  const filtered = await filterSameGenre(
    tracks,
    { artist: "Kanye West", title: "30 Hours" },
    async () => {
      throw new Error("itunes down");
    },
  );
  assert.equal(filtered.genre, null);
  assert.deepEqual(filtered.tracks, tracks);
});

test("client round-robin runs after other genres are removed", async () => {
  clearGenreCache();
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "itunes.apple.com") {
      const term = url.searchParams.get("term") ?? "";
      const found = CATALOG.find(([artist, title]) => term === `${artist} ${title}`);
      if (!found) return Response.json({ resultCount: 0, results: [] });
      const [artist, title, genre] = found;
      return Response.json({
        resultCount: 1,
        results: [{ kind: "song", artistName: artist, trackName: title, primaryGenreName: genre }],
      });
    }
    if (url.pathname.endsWith("/track")) {
      return Response.json({
        content: [row(SEED, 62, "Anchor", "Kanye West", KANYE)],
      });
    }
    return Response.json({
      content: [
        row(KENNY, 62, "Country Song", "Kenny Chesney", "g".repeat(22)),
        row(DURK, 62, "Rap Song", "Lil Durk", "h".repeat(22)),
        row(SZA, 61, "Soul Song", "SZA", "i".repeat(22)),
        row(KANYE, 62, "Again", "Kanye West", KANYE),
      ],
    });
  };

  const result = await new ReccoBeatsClient({ fetchImpl }).recommendations({
    info: { uri: `spotify:track:${SEED}` },
  });
  assert.equal(result.genre, "hip-hop");
  assert.deepEqual(
    result.tracks.map((item) => item.artist),
    ["Lil Durk", "SZA", "Kanye West"],
  );
});

const CATALOG = [
  ["Kanye West", "Anchor", "Hip-Hop/Rap"],
  ["Kenny Chesney", "Country Song", "Country"],
  ["Pantera", "Metal Song", "Metal"],
  ["Lil Durk", "Rap Song", "Hip-Hop/Rap"],
  ["SZA", "Soul Song", "R&B/Soul"],
  ["Kanye West", "Again", "Hip-Hop/Rap"],
];

/**
 * @param {string} spotifyId
 * @param {string} artist
 * @param {string} title
 */
function track(spotifyId, artist, title) {
  return { spotifyId, uri: `spotify:track:${spotifyId}`, title, artist, popularity: 62 };
}

/**
 * @param {string} spotifyId
 * @param {number} popularity
 * @param {string} title
 * @param {string} artist
 * @param {string} artistId
 */
function row(spotifyId, popularity, title, artist, artistId) {
  return {
    id: `recco-${spotifyId}`,
    trackTitle: title,
    artists: [{ name: artist, id: artistId, href: `https://open.spotify.com/artist/${artistId}` }],
    href: `https://open.spotify.com/track/${spotifyId}`,
    popularity,
  };
}
