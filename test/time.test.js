import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, progressBar } from "../src/utils/time.js";

test("parseDuration accepts seconds and clock formats", () => {
  assert.equal(parseDuration("90"), 90_000);
  assert.equal(parseDuration("1:30"), 90_000);
  assert.equal(parseDuration("1:02:03"), 3_723_000);
  assert.equal(parseDuration("90:00"), 5_400_000);
});

test("parseDuration rejects malformed positions", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("1:60"), null);
  assert.equal(parseDuration("1:75:00"), null);
  assert.equal(parseDuration("soon"), null);
});

test("progressBar clamps positions", () => {
  assert.equal(progressBar(-10, 100, 4), "🔘▬▬▬");
  assert.equal(progressBar(100, 100, 4), "▬▬▬🔘");
  assert.equal(progressBar(10, 0, 4), "▬▬▬▬");
});
