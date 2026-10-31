import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BYTES, sharePhotos, validBox, validateFiles } from "../src/media.ts";

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

test("blur spreads pixels smoothly without changing opacity, including single-pixel areas", async () => {
  const { blurPixels } = await import("../src/media.ts");
  const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  blurPixels(data, 3, 1, 1);
  assert.deepEqual([...data], [85, 85, 85, 255, 85, 85, 85, 255, 85, 85, 85, 255]);
  const single = new Uint8ClampedArray([20, 40, 60, 255]);
  blurPixels(single, 1, 1, 80);
  assert.deepEqual([...single], [20, 40, 60, 255]);
});

test("sharing immediately passes the prepared photos in order with the processed caption", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: ShareData[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      canShare: (data: ShareData) => {
        assert.deepEqual(Object.keys(data), ["files"]);
        return true;
      },
      share: async (data: ShareData) => { calls.push(data); },
    },
  });
  try {
    for (const count of [0, 1, 3, 4]) {
      const files = Array.from({ length: count }, (_, i) =>
        new File([`processed-${i}`], `odyssey-${i + 1}.png`, { type: "image/png" }),
      );
      const sharing = sharePhotos(files, "처리된 본문");
      // No fetch or asynchronous preparation before navigator.share: keep user activation.
      assert.deepEqual(calls.at(-1), { text: "처리된 본문", ...(count ? { files } : {}) });
      await sharing;
    }
    const photo = new File(["processed"], "odyssey.png", { type: "image/png" });
    await sharePhotos([photo], "");
    assert.deepEqual(calls.at(-1), { files: [photo] });
    await assert.rejects(sharePhotos(Array(5).fill(photo), "caption"), /4장/);
    await assert.rejects(sharePhotos([], "  "), /없어요/);
    assert.equal(calls.length, 5);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("unsupported file sharing never silently sends just text; cancellation remains distinguishable", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let calls = 0;
  const share = async () => { calls++; };
  const photo = new File(["processed"], "odyssey.png", { type: "image/png" });
  try {
    for (const navigator of [{}, { share }, { share, canShare: () => false }]) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
      await assert.rejects(sharePhotos([photo], "caption"), /다운로드/);
    }
    assert.equal(calls, 0);
    const abort = new DOMException("cancelled", "AbortError");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { share: async () => { throw abort; } },
    });
    await assert.rejects(sharePhotos([], "caption"), (error) => error === abort);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
