import test from "node:test";
import assert from "node:assert/strict";
import { colors } from "../src/utils/theme.js";

test("theme exposes brand colors", () => {
  assert.equal(colors.active, 0x14b8a6);
  assert.equal(colors.ended, 0x747f8d);
});
