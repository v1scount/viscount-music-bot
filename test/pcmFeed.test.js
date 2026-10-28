import test from "node:test";
import assert from "node:assert/strict";
import { PcmFeed } from "../src/player/pcmFeed.js";

test("pcm feed holds audio until the preroll and then passes it through", () => {
  const feed = new PcmFeed(8);
  assert.equal(feed.push(Buffer.alloc(4)), null);
  assert.equal(feed.pendingBytes, 4);

  const ready = feed.push(Buffer.from([1, 2, 3, 4]));
  assert.equal(ready.length, 2);
  assert.equal(ready[0].length, 4);
  assert.deepEqual([...ready[1]], [1, 2, 3, 4]);

  const next = feed.push(Buffer.from([9]));
  assert.deepEqual(next.map((chunk) => [...chunk]), [[9]]);
});

test("pcm feed reset drops a partial preroll", () => {
  const feed = new PcmFeed(8);
  feed.push(Buffer.alloc(4));
  feed.reset();
  assert.equal(feed.pendingBytes, 0);
  assert.equal(feed.push(Buffer.alloc(4)), null);
});

test("pcm feed flush releases a short tail", () => {
  const feed = new PcmFeed(8);
  feed.push(Buffer.from([1, 2]));
  const flushed = feed.flush();
  assert.deepEqual([...flushed[0]], [1, 2]);
  assert.equal(feed.started, true);
});
