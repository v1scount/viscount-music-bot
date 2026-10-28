import test from "node:test";
import assert from "node:assert/strict";
import { PcmParser } from "../src/utils/pcmParser.js";

test("pcm parser splits frames and discontinuities", () => {
  const parser = new PcmParser();
  const frames = [];
  let breaks = 0;
  parser.onPcm = (pcm) => frames.push(Buffer.from(pcm));
  parser.onDiscontinuity = () => {
    breaks += 1;
  };

  const pcm = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(pcm.length);
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(0xffffffff);

  parser.push(Buffer.concat([header.subarray(0, 2)]));
  parser.push(Buffer.concat([header.subarray(2), pcm.subarray(0, 1)]));
  parser.push(Buffer.concat([pcm.subarray(1), marker]));

  assert.equal(breaks, 1);
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
});
