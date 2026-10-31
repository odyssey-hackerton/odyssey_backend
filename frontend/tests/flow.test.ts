import assert from "node:assert/strict";
import { test } from "node:test";
import type { PostReport } from "../src/api.ts";
import {
  choicesFor,
  cluesFromReport,
  maskText,
  matchKept,
  regionLetters,
} from "../src/flow.ts";

const report: PostReport = {
  post_id: "p",
  status: "AWAITING_USER",
  risk_before: 0.82,
  risk_after: null,
  items: [
    {
      position: 0,
      job_id: "a",
      input_type: "image_text",
      status: "AWAITING_USER",
      risk_detected: true,
      risk_before: 0.82,
      risk_after: null,
      iterations: 0,
      details: {},
      findings: [
        { type: "landmark", source: "vlm", bbox: [10, 10, 50, 40], title: "간판", risk_level: "medium", action: "mask" },
        { type: "phone_number", source: "text", spans: [[4, 17]], title: "연락처", risk_level: "high", action: "mask" },
        { type: "metadata", source: "exif", title: "사진 파일 정보", action: "remove" },
      ],
    },
    {
      position: 1,
      job_id: "b",
      input_type: "image",
      status: "AWAITING_USER",
      risk_detected: true,
      risk_before: 0.5,
      risk_after: null,
      iterations: 0,
      details: {},
      findings: [
        { type: "school_uniform", source: "vlm", bbox: [60, 60, 90, 90] },
        { type: "face", source: "vlm", bbox: [100, 10, 140, 50], action: "blur" },
      ],
    },
  ],
};

test("report items become image, text and file clues tied to their photo", () => {
  const clues = cluesFromReport(report);
  assert.deepEqual(
    clues.map((c) => [c.kind, c.position, c.idx, c.imageIndex]),
    [
      ["image", 0, 0, 0],
      ["text", 0, 1, null],
      ["file", 0, 2, 0],
      ["image", 1, 0, 1],
      ["image", 1, 1, 1],
    ],
  );
  assert.equal(clues[1].risk, "high");
  assert.equal(clues[2].recommended, "remove");
  assert.equal(clues[3].title, "school_uniform");
  assert.equal(clues[3].recommended, "mask");
  assert.equal(clues[4].recommended, "blur");
  assert.deepEqual([...regionLetters(clues, 1).values()], ["A", "B"]);
});

test("transform choices cover every clue; declined caption edits become skip", () => {
  const clues = cluesFromReport(report).map((c) =>
    c.key === "1:0" ? { ...c, action: "skip" as const } : c,
  );
  assert.deepEqual(choicesFor(clues, true), [
    { position: 0, idx: 0, action: "mask" },
    { position: 0, idx: 1, action: "mask" },
    { position: 0, idx: 2, action: "remove" },
    { position: 1, idx: 0, action: "skip" },
    { position: 1, idx: 1, action: "blur" },
  ]);
  assert.equal(choicesFor(clues, false)[1].action, "skip");
});

test("caption masking follows the worker rule: remove deletes, others become [가림]", () => {
  const text = "문의는 010-1234-5678 또는 a@b.kr";
  const [, phone] = cluesFromReport(report);
  const email = { ...phone, key: "e", spans: [[21, 27]] as [number, number][] };
  assert.equal(maskText(text, [phone, email]), "문의는 [가림] 또는 [가림]");
  assert.equal(maskText(text, [{ ...phone, action: "remove" }]), "문의는  또는 a@b.kr");
  assert.equal(maskText(text, [{ ...phone, action: "skip" }]), text);
  const overlapping = { ...phone, spans: [[4, 10], [6, 13]] as [number, number][] };
  assert.equal(maskText(text, [overlapping]), "문의는 [가림]5678 또는 a@b.kr");
});

test("a region kept as-is and found again by re-verification is reported once", () => {
  const clues = cluesFromReport(report);
  const kept = { ...clues[0], action: "skip" as const };
  const again = { ...clues[0], key: "again", bbox: [12, 8, 52, 41] as [number, number, number, number] };
  const elsewhere = { ...clues[0], key: "far", bbox: [300, 300, 340, 340] as [number, number, number, number] };
  assert.equal(matchKept([kept], [again]).get(kept.key), again);
  assert.equal(matchKept([kept], [elsewhere]).size, 0);
});

test("image categories enforce their own tool sets and normalize unsupported recommendations", async () => {
  const { categoryOf, ALLOWED_ACTIONS, cluesFromFindings } = await import("../src/flow.ts");
  assert.equal(categoryOf({ type: "address", source: "vlm" }), "text");
  assert.equal(categoryOf({ type: "store", source: "vlm" }), "text");
  assert.equal(categoryOf({ type: "unknown", source: "ocr" }), "text");
  assert.equal(categoryOf({ type: "face" }), "object");
  assert.equal(categoryOf({ type: "window_reflection" }), "location");
  assert.equal(categoryOf({ type: "architecture", source: "agent2" }), "location");
  assert.equal(categoryOf({ type: "face", category: "location" }), "location");
  assert.deepEqual(ALLOWED_ACTIONS.text, ["mask", "blur", "partialMask", "remove"]);
  assert.deepEqual(ALLOWED_ACTIONS.object, ["mask", "blur", "mosaic"]);
  assert.deepEqual(ALLOWED_ACTIONS.location, ["mask"]);
  const [clue] = cluesFromFindings([{ type: "reflection", bbox: [0, 0, 10, 10], action: "blur" }], 0, 0);
  assert.equal(clue.action, "mask");
  assert.notEqual(clue.bbox, clue.originalBox);
});

test("scaling keeps the original center and ratio, clamps to photo bounds and restores exactly", async () => {
  const { scaleBox } = await import("../src/flow.ts");
  const box: [number, number, number, number] = [20, 20, 60, 40];
  for (const scale of [-100, 0.25, 0.5, 1, 1.5, 2, 100, NaN]) {
    const b = scaleBox(box, scale, 100, 80);
    assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 100 && b[3] <= 80);
    assert.ok(Math.abs((b[2] - b[0]) / (b[3] - b[1]) - 2) < 1e-9);
    assert.equal((b[0] + b[2]) / 2, 40);
    assert.equal((b[1] + b[3]) / 2, 30);
  }
  assert.deepEqual(scaleBox(box, 1, 100, 80), box);
  assert.deepEqual(scaleBox(box, 0.75, 100, 80), [25, 22.5, 55, 37.5]);
  assert.deepEqual(scaleBox([0, 0, 20, 10], 2, 100, 80), [0, 0, 20, 10]);
});

test("dragging any corner preserves center and ratio, including image boundaries", async () => {
  const { resizeBox } = await import("../src/flow.ts");
  const box: [number, number, number, number] = [20, 20, 60, 40];
  for (const corner of [0, 1, 2, 3]) for (const delta of [-1000, -10, 0, 10, 1000]) {
    const b = resizeBox(box, delta, delta, 100, 80, corner);
    assert.equal((b[0] + b[2]) / 2, 40);
    assert.equal((b[1] + b[3]) / 2, 30);
    assert.ok(Math.abs((b[2] - b[0]) / (b[3] - b[1]) - 2) < 1e-9);
    assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 100 && b[3] <= 80);
    assert.ok(b[3] - b[1] >= 12);
  }
});
