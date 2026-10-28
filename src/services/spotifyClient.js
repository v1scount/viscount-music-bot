import net from "node:net";
import { debug, log, logError } from "../utils/logger.js";
import { PcmParser } from "../utils/pcmParser.js";

const RETRY_MS = 2_000;

/**
 * @param {unknown} body
 */
function toTrack(body) {
  return {
    info: {
      identifier: body.identifier,
      isSeekable: body.isSeekable !== false,
      author: body.author ?? "Unknown",
      length: Number(body.length) || 0,
      isStream: Boolean(body.isStream),
      position: 0,
      title: body.title ?? "Unknown",
      uri: body.uri,
      artworkUrl: body.artworkUrl ?? null,
      isrc: body.isrc ?? null,
      sourceName: body.sourceName ?? "spotify",
    },
  };
}

/**
 * @param {unknown} payload
 */
function toResolveResult(payload) {
  const tracks = Array.isArray(payload?.tracks)
    ? payload.tracks.map(toTrack)
    : [];
  return {
    loadType: payload?.loadType ?? (tracks.length ? "search" : "empty"),
    playlistInfo: { name: payload?.playlistName ?? "" },
    tracks,
  };
}

export class SpotifyClient {
  /**
   * @param {{ engineUrl: string, pcmHost: string, pcmPort: number }} options
   */
  constructor(options) {
    this.engineUrl = options.engineUrl.replace(/\/$/, "");
    this.pcmHost = options.pcmHost;
    this.pcmPort = options.pcmPort;
    this.parser = new PcmParser();
    /** @type {import("node:net").Socket | null} */
    this.socket = null;
    this.started = false;
    /** @type {((event: object) => void) | null} */
    this.onEvent = null;
  }

  /**
   * @param {{ onEvent: (event: object) => void, onPcm: (pcm: Buffer) => void, onDiscontinuity: () => void }} handlers
   */
  start(handlers) {
    if (this.started) return;
    this.started = true;
    this.onEvent = handlers.onEvent;
    this.parser.onPcm = handlers.onPcm;
    this.parser.onDiscontinuity = handlers.onDiscontinuity;
    void this.loopEvents();
    void this.loopPcm();
  }

  async healthy() {
    try {
      const response = await fetch(`${this.engineUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} query
   * @param {number} [timeoutMs]
   */
  async search(query, timeoutMs = 6000) {
    const url = new URL(`${this.engineUrl}/search`);
    url.searchParams.set("q", query);
    return toResolveResult(await this.getJson(url, timeoutMs));
  }

  /**
   * @param {string} uri
   * @param {number} [timeoutMs]
   */
  async resolve(uri, timeoutMs = 8000) {
    const url = new URL(`${this.engineUrl}/resolve`);
    url.searchParams.set("uri", uri);
    return toResolveResult(await this.getJson(url, timeoutMs));
  }

  /**
   * @param {string} uri
   */
  async radio(uri) {
    const url = new URL(`${this.engineUrl}/radio`);
    url.searchParams.set("uri", uri);
    return toResolveResult(await this.getJson(url, 8000));
  }

  /**
   * @param {string} uri
   * @param {number} [positionMs]
   */
  async load(uri, positionMs = 0) {
    await this.post("/player/load", { uri, positionMs });
  }

  async pause() {
    await this.post("/player/pause", {});
  }

  async resume() {
    await this.post("/player/resume", {});
  }

  /**
   * @param {number} positionMs
   */
  async seek(positionMs) {
    await this.post("/player/seek", { positionMs });
  }

  async stop() {
    await this.post("/player/stop", {});
  }

  /**
   * @param {string} uri
   */
  async preload(uri) {
    await this.post("/player/preload", { uri });
  }

  /**
   * @param {URL} url
   * @param {number} timeoutMs
   */
  async getJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Spotify engine ${response.status}: ${body}`);
    }
    return response.json();
  }

  /**
   * @param {string} path
   * @param {object} body
   */
  async post(path, body) {
    const response = await fetch(`${this.engineUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Spotify engine ${response.status}: ${text}`);
    }
  }

  async loopEvents() {
    while (this.started) {
      try {
        const response = await fetch(`${this.engineUrl}/events`);
        if (!response.ok || !response.body) {
          throw new Error(`events ${response.status}`);
        }
        log("spotify", "Event stream connected");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (this.started) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const data = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            try {
              this.onEvent?.(JSON.parse(data));
            } catch (error) {
              debug("spotify", `ignored event: ${error}`);
            }
          }
        }
      } catch (error) {
        logError("spotify:events", error);
      }
      await delay(RETRY_MS);
    }
  }

  async loopPcm() {
    while (this.started) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(this.pcmPort, this.pcmHost);
          this.socket = socket;
          socket.on("connect", () => {
            socket.setNoDelay(true);
            log("spotify", `PCM connected ${this.pcmHost}:${this.pcmPort}`);
          });
          socket.on("data", (chunk) => {
            try {
              this.parser.push(chunk);
            } catch (error) {
              logError("spotify:pcm", error);
            }
          });
          socket.on("error", reject);
          socket.on("close", resolve);
        });
      } catch (error) {
        logError("spotify:pcm", error);
      }
      this.socket = null;
      await delay(RETRY_MS);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
