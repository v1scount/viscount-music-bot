import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { logError } from "../utils/logger.js";
import {
  MIN_CHART_PEAK,
  PLAYLIST_CACHE,
  arrangeStation,
  playlistCacheKey,
  primaryArtistName,
  radioCandidates,
  similarCandidates,
} from "./freqblog.js";

const RADIO_SIZE = 50;
const CACHE_LIMIT = 80;
const HOUR_MS = 60 * 60 * 1000;
/** A 50-track walk is one quota unit and can take well over 10s. */
export const RADIO_TIMEOUT_MS = 45_000;

/**
 * FreqBlog catalog client.
 * `GET /similar?limit=50&cross_genre=strict&charted=true&min_chart_peak=40` is one
 * quota unit. Results stay in the seed's genre, and only records with a real chart
 * peak are asked for, so a mainstream song does not walk into uncharted catalogue
 * tracks. Spotify ids are not
 * sent: the API only remembers one that was looked up in the last day.
 */
export class FreqblogClient {
  /**
   * @param {{ apiUrl?: string, apiKey?: string, cachePath?: string | null, fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || "https://api.freqblog.com").replace(/\/$/, "");
    this.apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    this.cachePath = options.cachePath || null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    /** @type {Map<string, Array<{ id: string, title: string, artist: string, isrc: string | null }>>} */
    this.memory = new Map();
    /** @type {Map<string, number>} */
    this.savedAt = new Map();
    /** @type {Set<string>} */
    this.misses = new Set();
    this.cacheLoaded = false;
    /** @type {Promise<void> | null} */
    this.loading = null;
    this.pausedUntil = 0;
    /** @type {Promise<void>} */
    this.persistChain = Promise.resolve();
  }

  /**
   * @param {object} track Spotify track or anything with title, artist, and optional ISRC
   * @returns {Promise<{ tracks: Array<{ id: string, title: string, artist: string, isrc: string | null }>, fromCache: boolean }>}
   */
  async similar(track) {
    if (!this.apiKey) {
      const error = new Error("Missing FREQBLOG_API_KEY");
      error.code = "missing_key";
      throw error;
    }
    if (this.pausedUntil > Date.now()) {
      const error = new Error("FreqBlog is cooling down after a limit or auth error");
      error.code = "limited";
      throw error;
    }

    const key = playlistCacheKey(track);
    if (!key) return { tracks: [], fromCache: true };

    await this.loadCache();
    if (this.memory.has(key)) {
      return { tracks: arrangeStation(copyTracks(this.memory.get(key)), track), fromCache: true };
    }
    if (this.misses.has(key)) {
      return { tracks: [], fromCache: true };
    }

    const params = new URLSearchParams();
    params.set("limit", String(RADIO_SIZE));
    params.set("cross_genre", "strict");
    params.set("exclude_same_artist", "false");
    params.set("charted", "true");
    params.set("min_chart_peak", String(MIN_CHART_PEAK));
    const recordingKey = key.slice(PLAYLIST_CACHE.length + 1);
    if (recordingKey.startsWith("isrc:")) {
      params.set("isrc", recordingKey.slice(5));
    } else {
      params.set("track", track.info?.title ?? track.title);
      params.set("artist", primaryArtistName(track.info?.author ?? track.artist));
    }

    const response = await this.fetchImpl(`${this.apiUrl}/similar?${params}`, {
      headers: {
        accept: "application/json",
        "X-Api-Key": this.apiKey,
      },
      signal: AbortSignal.timeout(RADIO_TIMEOUT_MS),
    });

    if (response.status === 404) {
      this.misses.add(key);
      return { tracks: [], fromCache: false };
    }

    if (response.status === 401 || response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const pauseMs = response.status === 401 ? 6 * HOUR_MS : retryDelayMs(retryAfter);
      this.pausedUntil = Date.now() + pauseMs;
      const body = await response.text();
      const error = new Error(`FreqBlog ${response.status}: ${body.slice(0, 300)}`);
      error.code = response.status === 401 ? "unauthorized" : "limited";
      throw error;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FreqBlog ${response.status}: ${body.slice(0, 300)}`);
    }

    const tracks = similarCandidates(await response.json(), track);
    if (tracks.length === 0) {
      this.misses.add(key);
      return { tracks: [], fromCache: false };
    }

    this.memory.set(key, tracks);
    this.savedAt.set(key, Date.now());
    await this.persist();
    return { tracks: copyTracks(tracks), fromCache: false };
  }

  async loadCache() {
    if (this.cacheLoaded) return;
    if (!this.loading) {
      this.loading = this.readCache().finally(() => {
        this.cacheLoaded = true;
      });
    }
    await this.loading;
  }

  async readCache() {
    if (!this.cachePath) return;

    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {};
      for (const [key, entry] of Object.entries(entries)) {
        if (!key.startsWith(`${PLAYLIST_CACHE}:`)) continue;
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.tracks)) continue;
        const tracks = radioCandidates({ tracks: entry.tracks }, null);
        if (tracks.length === 0) continue;
        this.memory.set(key, tracks);
        this.savedAt.set(key, Number(entry.at) || 0);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      logError("freqblog:cache", error);
    }
  }

  persist() {
    if (!this.cachePath) return Promise.resolve();
    this.persistChain = this.persistChain
      .then(() => this.saveCache())
      .catch((error) => logError("freqblog:cache", error));
    return this.persistChain;
  }

  async saveCache() {
    if (!this.cachePath) return;
    const ranked = [...this.savedAt.entries()].sort((left, right) => right[1] - left[1]).slice(0, CACHE_LIMIT);
    const keep = new Set(ranked.map(([key]) => key));
    for (const key of [...this.memory.keys()]) {
      if (!keep.has(key)) {
        this.memory.delete(key);
        this.savedAt.delete(key);
      }
    }

    /** @type {Record<string, { at: number, tracks: object[] }>} */
    const entries = {};
    for (const [key, at] of ranked) {
      const tracks = this.memory.get(key);
      if (!tracks?.length) continue;
      entries[key] = {
        at,
        tracks: tracks.map((track) => ({
          itunes_track_id: track.id,
          track_name: track.title,
          artist_name: track.artist,
          isrc: track.isrc,
        })),
      };
    }

    await mkdir(path.dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, `${JSON.stringify({ entries })}\n`, "utf8");
  }
}

/**
 * @param {Array<{ id: string, title: string, artist: string, isrc: string | null }> | undefined} tracks
 */
function copyTracks(tracks) {
  return (tracks ?? []).map((track) => ({ ...track }));
}

/**
 * @param {string | null} header
 */
function retryDelayMs(header) {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 32 * 24 * HOUR_MS);
  }
  return 60_000;
}
