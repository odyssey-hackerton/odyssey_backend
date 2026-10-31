import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BYTES, validBox, validateFiles } from "../src/media.ts";

test("uploads enforce the combined photo count and current backend limit", () => {
  const image = { type: "image/jpeg", size: MAX_BYTES };
  assert.equal(validateFiles([image], 3), null);
  assert.match(validateFiles([image, image], 3)!, /4장/);
  assert.match(validateFiles([image, image], 0, 1)!, /1장/);
  assert.match(validateFiles([{ type: "text/html", size: 1 }], 0)!, /JPG/);
  assert.match(validateFiles([{ ...image, size: MAX_BYTES + 1 }], 0)!, /10MB/);
});

test("invalid and out-of-bounds detection rectangles cannot reach the editor", () => {
  assert.equal(validBox([40, 10, 20, 30], 100, 100), null);
  assert.equal(validBox([NaN, 10, 20, 30], 100, 100), null);
  assert.equal(validBox([110, 10, 120, 30], 100, 100), null);
  assert.deepEqual(validBox([-10, -20, 120, 110], 100, 100), [0, 0, 100, 100]);
  assert.equal(validBox(undefined, 100, 100), null);
});
