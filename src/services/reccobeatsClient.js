import { filterSameGenre } from "./genre.js";
import {
  RECOMMENDATION_SIZE,
  arrangeStation,
  needsArtistExclusion,
  normalizePopularity,
  recommendationCandidates,
  seedArtistFromTrack,
  spotifyTrackId,
} from "./reccobeats.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_NEGATIVE_SEEDS = 20;

export class ReccoBeatsClient {
  /**
   * @param {{ apiUrl?: string, fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || "https://api.reccobeats.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pausedUntil = 0;
  }

  /**
   * Request a station around the original Spotify track and its popularity.
   * ReccoBeats uses Spotify popularity (0-100) as its reproduction/audience
   * signal, so the seed's value is sent back as an explicit target.
   *
   * @param {object} track
   * @param {string[]} [recentUris]
   */
  async recommendations(track, recentUris = []) {
    const seedId = spotifyTrackId(track);
    if (!seedId) return { tracks: [], targetPopularity: null, excludedArtist: false, genre: null };

    const seed = await this.getJson(this.url("/track", { ids: seedId }));
    const seedTrack = (seed?.content ?? []).find((item) => spotifyTrackId(item) === seedId);
    const targetPopularity = normalizePopularity(seedTrack?.popularity);
    const seedArtist = seedArtistFromTrack(seedTrack);

    // Do not set featureWeight here. ReccoBeats applies values above 1 to its
    // wider feature model and can move results dozens of popularity points
    // away even when popularity is the only explicit target.
    const first = recommendationCandidates(
      await this.getJson(this.recommendationUrl(seedId, recentUris, targetPopularity)),
      track,
      targetPopularity,
    );

    let tracks = first;
    let excludedArtist = false;
    if (needsArtistExclusion(first, seedArtist) && seedArtist?.id) {
      try {
        const second = recommendationCandidates(
          await this.getJson(
            this.recommendationUrl(seedId, recentUris, targetPopularity, [seedArtist.id]),
          ),
          track,
          targetPopularity,
        );
        if (second.length > 0) {
          tracks = second;
          excludedArtist = true;
        }
      } catch (error) {
        if (first.length === 0) throw error;
      }
    }

    const seedMeta = {
      artist: seedArtist?.name ?? "",
      title: typeof seedTrack?.trackTitle === "string" ? seedTrack.trackTitle : "",
    };
    const tuned = await filterSameGenre(tracks, seedMeta, this.fetchImpl);
    return {
      tracks: arrangeStation(tuned.tracks, seedArtist),
      targetPopularity,
      excludedArtist,
      genre: tuned.genre,
    };
  }

  /**
   * @param {string} seedId
   * @param {string[]} recentUris
   * @param {number | null} popularity
   * @param {string[]} [excludedIds]
   */
  recommendationUrl(seedId, recentUris, popularity, excludedIds = []) {
    const negatives = negativeSeedList(recentUris, seedId, excludedIds);
    return this.url("/track/recommendation", {
      size: RECOMMENDATION_SIZE,
      seeds: seedId,
      negativeSeeds: negatives.length > 0 ? negatives.join(",") : null,
      popularity,
    });
  }

  /**
   * @param {string} pathname
   * @param {Record<string, string | number | null>} params
   */
  url(pathname, params) {
    const url = new URL(`${this.apiUrl}${pathname}`);
    for (const [name, value] of Object.entries(params)) {
      if (value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    return url;
  }

  /**
   * @param {URL} url
   */
  async getJson(url) {
    if (this.pausedUntil > Date.now()) {
      const error = new Error("ReccoBeats is cooling down after a rate limit");
      error.code = "limited";
      throw error;
    }

    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 429) {
      this.pausedUntil = Date.now() + retryDelayMs(response.headers.get("retry-after"));
      const error = new Error("ReccoBeats rate limit exceeded");
      error.code = "limited";
      throw error;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ReccoBeats ${response.status}: ${body.slice(0, 300)}`);
    }
    return response.json();
  }
}

/**
 * @param {unknown} value
 */
function uriToSpotifyId(value) {
  if (typeof value !== "string") return null;
  const match = /^spotify:track:([0-9A-Za-z]{22})$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Keep an excluded artist even when the recent-track list is long.
 *
 * @param {string[]} recentUris
 * @param {string} seedId
 * @param {string[]} excludedIds
 */
function negativeSeedList(recentUris, seedId, excludedIds) {
  const recent = [...new Set(recentUris.map(uriToSpotifyId).filter(Boolean))].filter(
    (id) => id !== seedId,
  );
  const extras = [...new Set(excludedIds.filter((id) => id && id !== seedId))];
  return [...extras, ...recent.slice(-(MAX_NEGATIVE_SEEDS - extras.length))].slice(
    0,
    MAX_NEGATIVE_SEEDS,
  );
}

/**
 * @param {string | null} header
 */
function retryDelayMs(header) {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60 * 60 * 1000);
  }
  return DEFAULT_RETRY_MS;
}
