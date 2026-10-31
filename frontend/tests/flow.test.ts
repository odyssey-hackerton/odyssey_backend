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
