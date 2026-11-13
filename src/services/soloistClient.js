import WebSocket from "ws";

const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/;

/**
 * @param {unknown} entry
 */
export function entryToTrack(entry) {
  const item = entry?.item && typeof entry.item === "object" ? entry.item : entry;
  const uri = trackUri(item?.uri) ?? trackUri(entry?.uri);
  if (!uri) return null;

  const decorations = item?.decorations ?? {};
  const title = typeof decorations.identity?.name === "string" ? decorations.identity.name : "";
  const creators = Array.isArray(decorations.creators) ? decorations.creators : [];
  const names = creators
    .map((creator) => creator?.decorations?.identity?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  const artistUri = creators.find((creator) => typeof creator?.uri === "string" && creator.uri.startsWith("spotify:artist:"))?.uri
    ?? "";
  const artistId = artistUri.slice("spotify:artist:".length);
  const covers = Array.isArray(decorations.visual_identity?.cover)
    ? decorations.visual_identity.cover
    : [];
  const cover = covers.find((image) => image?.size === "large" && typeof image.url === "string")?.url
    ?? covers.find((image) => typeof image?.url === "string")?.url
    ?? null;
  const length = Number(decorations.playback?.duration_ms) || 0;

  return {
    info: {
      identifier: uri.slice("spotify:track:".length),
      isSeekable: true,
      author: names.length > 0 ? names.join(", ") : title ? "Unknown" : null,
      artistId: /^[0-9A-Za-z]{22}$/.test(artistId) ? artistId : null,
      length,
      isStream: false,
      position: 0,
      title: title || null,
      uri,
      artworkUrl: cover,
      isrc: null,
      sourceName: "spotify",
      requester: "Autoplay",
    },
  };
}

/**
 * @param {unknown} message
 * @param {string} seedUri
 * @param {string[]} [recentUris]
 */
export function tracksFromQueue(message, seedUri, recentUris = []) {
  const upcoming = Array.isArray(message?.upcoming) ? message.upcoming : [];
  const blocked = new Set([seedUri, ...recentUris]);
  /** @type {ReturnType<entryToTrack>[]} */
  const tracks = [];
  for (const entry of upcoming) {
    if (entry?.source !== "autoplay") continue;
    const track = entryToTrack(entry);
    if (!track?.info?.uri || blocked.has(track.info.uri)) continue;
    blocked.add(track.info.uri);
    tracks.push(track);
  }
  return tracks;
}

/**
 * @param {string | undefined} value
 */
function trackUri(value) {
  return typeof value === "string" && TRACK_URI.test(value) ? value : null;
}

/**
 * @param {WebSocket} socket
 */
function attachInbox(socket) {
  /** @type {object[]} */
  const messages = [];
  /** @type {((message: object) => void) | null} */
  let waiting = null;

  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(message);
      return;
    }
    messages.push(message);
  });

  return {
    /**
     * @param {number} timeoutMs
     */
    next(timeoutMs) {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const onMessage = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          if (waiting === onMessage) waiting = null;
          reject(new Error("soloist timed out"));
        }, Math.max(1, timeoutMs));
        waiting = onMessage;
      });
    },
  };
}

/**
 * @param {WebSocket} socket
 * @param {ReturnType<attachInbox>} inbox
 * @param {Record<string, unknown> & { command: string }} command
 * @param {number} timeoutMs
 */
async function request(socket, inbox, command, timeoutMs) {
  socket.send(JSON.stringify({ type: "command", ...command }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await inbox.next(deadline - Date.now());
    if (message.type === "error") {
      throw new Error(typeof message.message === "string" ? message.message : "soloist command failed");
    }
    if (command.command === "get_queue" && message.type === "queue_changed") return message;
    if (command.command === "get_state" && message.type === "playback_state") return message;
    if (message.type === "command_result" && message.command === command.command) return message;
  }
  throw new Error("soloist timed out");
}

/**
 * @param {WebSocket} socket
 */
/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function release(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ type: "command", command: "pause" }));
    socket.send(JSON.stringify({ type: "command", command: "deactivate" }));
  } catch {
    // The socket can close between the ready check and the send.
  }
}

/**
 * Play the seed on an open Soloist socket and copy its autoplay rows.
 * The caller must already know librespot is idle.
 *
 * @param {WebSocket} socket
 * @param {{ seedUri: string, recentUris?: string[], timeoutMs: number }} options
 */
export async function harvestOnSocket(socket, options) {
  const inbox = attachInbox(socket);
  const started = Date.now();
  const budget = () => Math.max(1, options.timeoutMs - (Date.now() - started));
  const recentUris = options.recentUris ?? [];

  try {
    await request(socket, inbox, { command: "set_repeat_track", enabled: false }, budget());
    await request(socket, inbox, { command: "set_repeat_context", enabled: false }, budget());
    await request(socket, inbox, { command: "set_volume", volume: 0 }, budget());
    await request(socket, inbox, { command: "play", uri: options.seedUri }, budget());

    const playback = await request(socket, inbox, { command: "get_state" }, budget()).catch(() => null);
    const enhancement = playback?.options?.modes?.context_enhancement;
    if (enhancement === "NONE") {
      const message = await request(socket, inbox, { command: "get_queue", limit: 0 }, budget());
      return {
        tracks: tracksFromQueue(message, options.seedUri, recentUris),
        recommendations: false,
      };
    }

    /** @type {NonNullable<ReturnType<entryToTrack>>[]} */
    let best = [];
    while (Date.now() - started < options.timeoutMs) {
      let message;
      try {
        message = await request(socket, inbox, { command: "get_queue", limit: 0 }, budget());
      } catch (error) {
        if (best.length > 0 || error?.message === "soloist timed out") {
          return { tracks: best, recommendations: best.length > 0 };
        }
        throw error;
      }
      const tracks = tracksFromQueue(message, options.seedUri, recentUris);
      if (tracks.length > best.length) best = tracks;
      if (best.length === 0) {
        await delay(Math.min(200, budget()));
        continue;
      }

      try {
        const again = await request(
          socket,
          inbox,
          { command: "get_queue", limit: 0 },
          Math.min(1000, budget()),
        );
        const more = tracksFromQueue(again, options.seedUri, recentUris);
        if (more.length > best.length) best = more;
      } catch {
        // The first autoplay list is enough when the follow-up read expires.
      }
      break;
    }
    return { tracks: best, recommendations: best.length > 0 };
  } finally {
    release(socket);
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
function connectSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("soloist connect timeout"));
    }, Math.max(1, timeoutMs));
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("soloist websocket failed"));
    };
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.removeEventListener("error", fail);
      resolve(socket);
    });
    socket.addEventListener("error", fail);
  });
}

export class SoloistClient {
  /**
   * @param {{ url?: string, harvestTimeoutMs?: number, connect?: typeof connectSocket }} [options]
   */
  constructor(options = {}) {
    this.url = options.url ?? "";
    this.harvestTimeoutMs = options.harvestTimeoutMs ?? 8000;
    this.connect = options.connect ?? connectSocket;
  }

  get enabled() {
    return this.url.length > 0;
  }

  /**
   * @param {string} seedUri
   * @param {string[]} [recentUris]
   */
  async harvest(seedUri, recentUris = []) {
    if (!this.enabled) return [];
    const started = Date.now();
    const socket = await this.connect(this.url, this.harvestTimeoutMs);
    try {
      const elapsed = Date.now() - started;
      return await harvestOnSocket(socket, {
        seedUri,
        recentUris,
        timeoutMs: Math.max(1, this.harvestTimeoutMs - elapsed),
      });
    } finally {
      socket.close();
    }
  }
}
