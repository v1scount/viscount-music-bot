const DEFAULT_TTL_MS = 45_000;
const DEFAULT_MAX_ENTRIES = 200;

/**
 * @typedef {{ expiresAt: number, value: unknown }} CacheEntry
 */

export class ResolveCache {
  /**
   * @param {{ ttlMs?: number, maxEntries?: number }} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    /** @type {Map<string, CacheEntry>} */
    this.entries = new Map();
  }

  /**
   * @param {string} source
   * @param {string} query
   */
  key(source, query) {
    return `${source}:${String(query).trim().toLowerCase()}`;
  }

  /**
   * @param {string} cacheKey
   */
  get(cacheKey) {
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    // Refresh insertion order for simple LRU eviction.
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry.value;
  }

  /**
   * @param {string} cacheKey
   * @param {unknown} value
   */
  set(cacheKey, value) {
    if (this.entries.has(cacheKey)) {
      this.entries.delete(cacheKey);
    }
    this.entries.set(cacheKey, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export const resolveCache = new ResolveCache();
