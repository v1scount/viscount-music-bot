const statesByClient = new WeakMap();

function createState() {
  return {
    autoplay: true,
    autoplayPending: false,
    lastPanelUpdateAt: 0,
    lastTrack: null,
    panelChannelId: null,
    panelMessage: null,
    panelMessageId: null,
    panelUpdatePromise: null,
    recentTrackKeys: [],
    stopped: false,
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

export function trackKeys(track) {
  const identifier = track?.info?.identifier?.trim().toLowerCase();
  const metadata = `${track?.info?.author ?? ""}:${track?.info?.title ?? ""}`
    .trim()
    .toLowerCase();
  return [identifier, metadata].filter(Boolean);
}

export function rememberTrack(state, track, limit = 20) {
  const keys = trackKeys(track);
  if (keys.length === 0) return;

  state.recentTrackKeys = [
    ...keys,
    ...state.recentTrackKeys.filter((value) => !keys.includes(value)),
  ].slice(0, limit * 2);
}
