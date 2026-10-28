const SPOTIFY_URI = /^spotify:(track|album|playlist):([A-Za-z0-9]+)/i;

/**
 * @param {string} query
 * @returns {{ kind: "track" | "album" | "playlist" | "search" | "unsupported", uri?: string, query?: string }}
 */
export function classifyQuery(query) {
  const trimmed = String(query ?? "").trim();
  const uri = trimmed.match(SPOTIFY_URI);
  if (uri) {
    const kind = uri[1].toLowerCase();
    return { kind, uri: `spotify:${kind}:${uri[2]}` };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname === "open.spotify.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        const offset = parts[0]?.startsWith("intl-") ? 1 : 0;
        const kind = parts[offset];
        const id = parts[offset + 1];
        if (
          (kind === "track" || kind === "album" || kind === "playlist") &&
          id &&
          /^[A-Za-z0-9]+$/.test(id)
        ) {
          return { kind, uri: `spotify:${kind}:${id}` };
        }
      }
    } catch {
      // fall through to unsupported
    }
    return { kind: "unsupported" };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { kind: "unsupported" };
  }

  return { kind: "search", query: trimmed };
}
