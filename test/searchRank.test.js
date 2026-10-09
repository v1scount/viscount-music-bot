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

test("studio recordings stay ahead of official videos and alternate versions", () => {
  const music = [
    track("remix", "Song (Remix)"),
    track("studio", "Song", "Artist - Topic"),
  ];
  const youtube = [
    track("video", "Song (Official Video)"),
    track("live", "Song (Live at Wembley)"),
    track("audio", "Song (Official Audio)"),
    track("lyrics", "Song (Lyrics)"),
    track("concert", "Song (Full Concert)"),
    track("cover", "Song (Cover)"),
    track("karaoke", "Song (Karaoke)"),
    track("instrumental", "Song (Instrumental)"),
    track("acoustic", "Song (Acoustic)"),
    track("nightcore", "Song (Nightcore)"),
    track("sped", "Song (Sped Up)"),
    track("slowed", "Song (Slowed + Reverb)"),
    track("8d", "Song (8D Audio)"),
    track("visualizer", "Song (Official Visualizer)"),
    track("mv", "Song (MV)"),
  ];

  const ranked = rankSearchResults("song", [music, youtube]).map(
    (entry) => entry.info.identifier,
  );

  assert.deepEqual(ranked.slice(0, 2), ["audio", "studio"]);
  assert.deepEqual(ranked.slice(2, 4), ["video", "mv"]);
  assert.ok(ranked.indexOf("remix") > ranked.indexOf("mv"));
  assert.ok(ranked.indexOf("live") > ranked.indexOf("video"));
  assert.equal(ranked.filter((id) => id === "studio").length, 1);
});

test("YouTube order is preserved inside a tier", () => {
  const ranked = rankSearchResults("song", [
    [
      track("video-b", "Song (Music Video)"),
      track("video-a", "Song (Official Music Video)"),
    ],
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["video-b", "video-a"]);
});

test("a version named in the query stays ahead of the studio recording", () => {
  const tracks = [
    track("studio", "Song"),
    track("live", "Song (Live)"),
    track("remix", "Song (Remix)"),
    track("video", "Song (Official Video)"),
  ];

  const ranked = rankSearchResults("song live", [tracks]).map(
    (entry) => entry.info.identifier,
  );

  assert.deepEqual(ranked, ["live", "studio", "video", "remix"]);
});

test("searching for the official video puts that version first", () => {
  const ranked = rankSearchResults("song official video", [
    [
      track("studio", "Song"),
      track("video", "Song (Official Video)"),
      track("live", "Song (Live)"),
    ],
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["video", "studio", "live"]);
});

test("live in the song title stays up when the query includes it", () => {
  const ranked = rankSearchResults("oasis live forever", [
    [
      track("remix", "Live Forever (Remix)"),
      track("other", "Wonderwall"),
      track("song", "Live Forever"),
    ],
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["song", "remix", "other"]);
});

test("the song YouTube ranks first stays ahead of a cleaner title by someone else", () => {
  const music = [
    track("obscure", "Just Dance", "Bedroom Producer"),
    track("gaga-audio", "Just Dance", "Lady Gaga - Topic"),
  ];
  const youtube = [
    track("gaga-video", "Lady Gaga - Just Dance (Official Video)", "LadyGagaVEVO"),
    track("gaga-live", "Just Dance (Live)", "Lady Gaga"),
    track("other-video", "Just Dance (Official Video)", "Someone Else"),
  ];

  const ranked = rankSearchResults("just dance", [music, youtube]).map(
    (entry) => entry.info.identifier,
  );

  assert.deepEqual(ranked, [
    "gaga-audio",
    "gaga-video",
    "gaga-live",
    "other-video",
    "obscure",
  ]);
});

test("a timed-out source still leaves the other source's matches", () => {
  const merged = mergeLoadedSearches("song", [
    undefined,
    { loadType: "search", tracks: [track("studio", "Song")] },
  ]);

  assert.equal(merged.loadType, "search");
  assert.equal(merged.tracks[0].info.identifier, "studio");
});

test("duplicate videos are kept once", () => {
  const ranked = rankSearchResults("song", [
    [track("same", "Song", "Artist - Topic")],
    [track("same", "Song (Official Audio)", "Artist"), track("video", "Song (Official Video)")],
  ]).map((entry) => entry.info.identifier);

  assert.deepEqual(ranked, ["same", "video"]);
});

test("a failed source still leaves the other source's matches", () => {
  const merged = mergeLoadedSearches("song", [
    { loadType: "error", tracks: [] },
    {
      loadType: "search",
      tracks: [
        track("video", "Song (Official Video)"),
        track("studio", "Song"),
      ],
    },
  ]);

  assert.equal(merged.loadType, "search");
  assert.deepEqual(
    merged.tracks.map((entry) => entry.info.identifier),
    ["studio", "video"],
  );
});

test("settleWithin returns results that finished before the timeout", async () => {
  const results = await settleWithin(
    [
      Promise.resolve("music"),
      new Promise((resolve) => setTimeout(() => resolve("youtube"), 200)),
    ],
    50,
  );

  assert.equal(results[0], "music");
  assert.equal(results[1], undefined);
});
