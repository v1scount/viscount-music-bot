import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Track } from "poru";
import { config } from "../config.js";
import { debug, log, logError } from "../utils/logger.js";
import { getPlayerState } from "../utils/playerState.js";
import {
  ensurePlayer,
  waitForVoiceConnection,
} from "../utils/voiceConnection.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";

const SAVE_DEBOUNCE_MS = 750;

/** @type {NodeJS.Timeout | null} */
let saveTimer = null;
/** @type {import("../client.js").MusicBot | null} */
let pendingClient = null;

/**
 * @param {import("poru").Track | null | undefined} track
 */
export function serializeTrack(track) {
  if (!track?.track) return null;
  return {
    encoded: track.track,
    info: {
      identifier: track.info.identifier,
      isSeekable: track.info.isSeekable,
      author: track.info.author,
      length: track.info.length,
      isStream: track.info.isStream,
      position: track.info.position ?? 0,
      title: track.info.title,
      uri: track.info.uri ?? null,
      artworkUrl: track.info.artworkUrl ?? null,
      isrc: track.info.isrc ?? null,
      sourceName: track.info.sourceName ?? "unknown",
    },
    pluginInfo: track.pluginInfo ?? {},
    userData: track.userData ?? {},
    requester:
      typeof track.info.requester === "string"
        ? track.info.requester
        : track.info.requester?.id
          ? { id: track.info.requester.id }
          : track.info.requester?.username ?? "Unknown",
  };
}

/**
 * @param {ReturnType<typeof serializeTrack>} data
 */
export function deserializeTrack(data) {
  if (!data?.encoded || !data.info) return null;
  return new Track(
    {
      encoded: data.encoded,
      info: data.info,
      pluginInfo: data.pluginInfo ?? {},
      userData: data.userData ?? {},
    },
    data.requester,
  );
}

/**
 * @param {import("../client.js").MusicBot} client
 */
export function collectSessions(client) {
  /** @type {Record<string, object>} */
  const sessions = {};
  if (!client?.poru?.players) return sessions;

  for (const [guildId, player] of client.poru.players) {
    if (!player.currentTrack && player.queue.length === 0) continue;

    const state = getPlayerState(client, guildId);
    sessions[guildId] = {
      voiceChannelId: player.voiceChannel,
      textChannelId: player.textChannel ?? state.panelChannelId,
      panelMessageId: state.panelMessageId,
      panelChannelId: state.panelChannelId,
      autoplay: state.autoplay,
      position: player.position ?? 0,
      current: serializeTrack(player.currentTrack),
      queue: player.queue.map((track) => serializeTrack(track)).filter(Boolean),
      recentTrackKeys: state.recentTrackKeys ?? [],
    };
  }

  return sessions;
}

/**
 * @param {import("../client.js").MusicBot} client
 */
export async function saveAll(client) {
  const filePath = config.dataPath;
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const payload = {
    savedAt: Date.now(),
    sessions: collectSessions(client),
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  debug("sessionStore", `Saved ${Object.keys(payload.sessions).length} session(s)`);
}

/**
 * @param {import("../client.js").MusicBot} client
 */
export function scheduleSave(client) {
  pendingClient = client;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const target = pendingClient;
    pendingClient = null;
    if (!target) return;
    saveAll(target).catch((error) => logError("sessionStore:save", error));
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced save immediately.
 *
 * @param {import("../client.js").MusicBot} client
 */
export async function flushSave(client) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingClient = null;
  await saveAll(client);
}

export async function loadSessions() {
  try {
    const raw = await readFile(config.dataPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.sessions && typeof parsed.sessions === "object"
      ? parsed.sessions
      : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    logError("sessionStore:load", error);
    return {};
  }
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {import("poru").Track} track
 */
async function ensurePlayableTrack(client, track) {
  if (track.track) return track;
  if (!track.info?.uri) return null;
  const result = await client.poru.resolve({
    query: track.info.uri,
    requester: track.info.requester,
  });
  if (["error", "empty"].includes(result.loadType)) return null;
  const resolved = result.tracks?.[0];
  if (!resolved) return null;
  resolved.info.requester = track.info.requester;
  return resolved;
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {number} [timeoutMs]
 */
async function waitForLavalink(client, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const node of client.poru.nodes.values()) {
      if (node.isConnected) return node;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * @param {import("../client.js").MusicBot} client
 */
export async function restoreSessions(client) {
  const node = await waitForLavalink(client);
  if (!node) {
    log("sessionStore", "Skipping restore — Lavalink not connected");
    return;
  }

  const sessions = await loadSessions();
  const guildIds = Object.keys(sessions);
  if (guildIds.length === 0) {
    debug("sessionStore", "No sessions to restore");
    return;
  }

  log("sessionStore", `Restoring ${guildIds.length} session(s)`);

  for (const guildId of guildIds) {
    const session = sessions[guildId];
    try {
      await restoreGuildSession(client, guildId, session);
    } catch (error) {
      logError("sessionStore:restore", error, { guildId });
    }
  }
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} guildId
 * @param {object} session
 */
async function restoreGuildSession(client, guildId, session) {
  if (!session?.voiceChannelId || !session?.textChannelId) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    log("sessionStore", `Guild ${guildId} not cached — skipping restore`);
    return;
  }

  const current = session.current
    ? deserializeTrack(session.current)
    : null;
  const queueTracks = (session.queue ?? [])
    .map((item) => deserializeTrack(item))
    .filter(Boolean);

  if (!current && queueTracks.length === 0) return;

  const player = ensurePlayer(client, {
    guildId,
    voiceChannelId: session.voiceChannelId,
    textChannelId: session.textChannelId,
  });

  await waitForVoiceConnection(player);

  const state = getPlayerState(client, guildId);
  state.autoplay = Boolean(session.autoplay);
  state.recentTrackKeys = Array.isArray(session.recentTrackKeys)
    ? session.recentTrackKeys
    : [];
  state.panelMessageId = session.panelMessageId ?? null;
  state.panelChannelId = session.panelChannelId ?? session.textChannelId;
  state.panelMessage = null;

  const playableCurrent = current
    ? await ensurePlayableTrack(client, current)
    : null;

  for (const queued of queueTracks) {
    const playable = await ensurePlayableTrack(client, queued);
    if (playable) player.queue.add(playable);
  }

  if (playableCurrent) {
    player.queue.splice(0, 0, playableCurrent);
    await player.play();
    const position = Number(session.position) || 0;
    if (position > 5_000 && !playableCurrent.info.isStream) {
      try {
        await player.seekTo(position);
        player.position = position;
      } catch (error) {
        logError("sessionStore:seek", error, { guildId });
      }
    }
  } else if (player.queue.length > 0) {
    await player.play();
  }

  await updatePlayerPanel(client, player);
  log("sessionStore", `Restored session for guild ${guildId}`);
}
