const statesByClient = new WeakMap();

function createState() {
  return {
    autoplay: true,
    autoplayPending: false,
    lastPanelUpdateAt: 0,
    autoplayCount: 0,
    autoplaySeed: null,
    lastTrack: null,
    panelChannelId: null,
    panelMessage: null,
    panelMessageId: null,
    panelRelocateTimer: null,
    panelUpdatePromise: null,
    recentArtistIds: [],
    recentTrackKeys: [],
    recentTrackUris: [],
    stopping: false,
  };
}

export function getPlayerState(client, guildId) {
  let states = statesByClient.get(client);
  if (!states) {
    states = new Map();
    statesByClient.set(client, states);
  }

  if (!states.has(guildId)) {
    states.set(guildId, createState());
  }

  return states.get(guildId);
}

/**
 * Drop now-playing message refs after a session ends. Keeps autoplay.
 *
 * @param {ReturnType<typeof createState>} state
 */
export function clearPanelRefs(state) {
  if (state.panelRelocateTimer) {
    clearTimeout(state.panelRelocateTimer);
    state.panelRelocateTimer = null;
  }
  state.panelMessage = null;
  state.panelMessageId = null;
  state.panelChannelId = null;
  state.lastTrack = null;
}

export function trackKeys(track) {
  const identifier = track?.info?.identifier?.trim().toLowerCase();
  const metadata = `${track?.info?.author ?? ""}:${track?.info?.title ?? ""}`
    .trim()
    .toLowerCase();
  return [identifier, metadata].filter(Boolean);
}

export const RECENT_URI_LIMIT = 40;
export const ARTIST_COOLDOWN = 3;

/**
 * @param {unknown} value
 */
function stationArtistId(value) {
  return typeof value === "string" && /^[0-9A-Za-z]{22}$/.test(value) ? value : null;
}

/**
 * A requested track becomes the station anchor and starts a new rotation.
 * Autoplay tracks advance the count and remember who just played.
 *
 * @param {ReturnType<typeof createState>} state
 * @param {{ info?: { uri?: string, artistId?: string, requester?: unknown } }} track
 */
export function noteStationTrack(state, track) {
  const uri = track?.info?.uri;
  const isAutoplay = track?.info?.requester === "Autoplay";
  if (typeof uri !== "string" || !uri.startsWith("spotify:track:")) {
    if (!isAutoplay) {
      state.autoplaySeed = null;
      state.recentTrackUris = [];
      state.recentArtistIds = [];
      state.autoplayCount = 0;
    }
    return;
  }

  const artistId = stationArtistId(track?.info?.artistId);
  if (isAutoplay) {
    state.recentTrackUris = [
      ...state.recentTrackUris.filter((item) => item !== uri),
      uri,
    ].slice(-RECENT_URI_LIMIT);
    state.autoplayCount = (state.autoplayCount ?? 0) + 1;
    if (artistId) {
      state.recentArtistIds = [
        ...(state.recentArtistIds ?? []).filter((id) => id !== artistId),
        artistId,
      ].slice(-ARTIST_COOLDOWN);
    }
    return;
  }

  state.autoplaySeed = track;
  state.recentTrackUris = [uri];
  state.autoplayCount = 0;
  state.recentArtistIds = artistId ? [artistId] : [];
}

export function rememberTrack(state, track, limit = 20) {
  const keys = trackKeys(track);
  if (keys.length === 0) return;

  state.recentTrackKeys = [
    ...keys,
    ...state.recentTrackKeys.filter((value) => !keys.includes(value)),
  ].slice(0, limit * 2);
}
