import test from "node:test";
import assert from "node:assert/strict";
import { ResolveCache } from "../src/utils/resolveCache.js";

test("resolve cache returns values within TTL", () => {
  const cache = new ResolveCache({ ttlMs: 1_000, maxEntries: 10 });
  const key = cache.key("ytsearch", "never gonna");
  cache.set(key, { loadType: "search", tracks: [1] });

  assert.deepEqual(cache.get(key), { loadType: "search", tracks: [1] });
});

test("resolve cache expires entries", async () => {
  const cache = new ResolveCache({ ttlMs: 20, maxEntries: 10 });
  const key = cache.key("ytsearch", "expired");
  cache.set(key, { loadType: "search" });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cache.get(key), undefined);
});

test("resolve cache evicts oldest entries past max size", () => {
  const cache = new ResolveCache({ ttlMs: 60_000, maxEntries: 2 });
  cache.set(cache.key("ytsearch", "a"), 1);
  cache.set(cache.key("ytsearch", "b"), 2);
  cache.set(cache.key("ytsearch", "c"), 3);

  assert.equal(cache.size, 2);
  assert.equal(cache.get(cache.key("ytsearch", "a")), undefined);
  assert.equal(cache.get(cache.key("ytsearch", "b")), 2);
  assert.equal(cache.get(cache.key("ytsearch", "c")), 3);
});
