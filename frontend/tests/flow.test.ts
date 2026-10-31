import assert from "node:assert/strict";
import { test } from "node:test";
import {
  choicesFor,
  cluesFromFindings,
  demoTextClues,
  maskText,
  matchKept,
  planJobs,
  regionLetters,
} from "../src/flow.ts";

test("one job per photo, caption rides with the first photo", () => {
  assert.deepEqual(planJobs(0, true), [{ photoIndex: null, withText: true }]);
  assert.deepEqual(planJobs(0, false), []);
  assert.deepEqual(planJobs(3, true), [
    { photoIndex: 0, withText: true },
    { photoIndex: 1, withText: false },
    { photoIndex: 2, withText: false },
  ]);
  assert.equal(planJobs(2, false)[0].withText, false);
});

const findings = [
  { type: "landmark", source: "vlm", bbox: [10, 10, 50, 40] as [number, number, number, number], title: "간판", risk_level: "medium", action: "mask" },
  { type: "phone_number", source: "text", spans: [[6, 19]], title: "연락처", risk_level: "high", action: "mask" },
  { type: "metadata", source: "exif", title: "사진 파일 정보", action: "remove" },
  { type: "school_uniform", source: "vlm", bbox: [60, 60, 90, 90] as [number, number, number, number] },
];

test("report findings become image, text and file clues without losing unknown types", () => {
  const clues = cluesFromFindings(findings, 1, 2);
  assert.deepEqual(
    clues.map((c) => [c.kind, c.idx, c.imageIndex, c.jobIndex]),
    [
      ["image", 0, 2, 1],
      ["text", 1, null, 1],
      ["file", 2, 2, 1],
      ["image", 3, 2, 1],
    ],
  );
  assert.equal(clues[1].risk, "high");
  assert.equal(clues[2].recommended, "remove");
  assert.equal(clues[3].title, "school_uniform");
  assert.equal(clues[3].recommended, "mask");
  const letters = regionLetters(clues, 2);
  assert.deepEqual([...letters.values()], ["A", "B"]);
});

test("caption masking matches the worker: remove deletes, others become [가림]", () => {
  const text = "문의는 010-1234-5678 또는 a@b.kr";
  const clues = demoTextClues(text);
  assert.equal(clues.length, 2);
  assert.equal(maskText(text, clues), "문의는 [가림] 또는 [가림]");
  assert.equal(
    maskText(text, clues.map((c) => ({ ...c, action: "remove" as const }))),
    "문의는  또는 ",
  );
  assert.equal(maskText(text, clues.map((c) => ({ ...c, action: "skip" as const }))), text);
  // 겹치는 범위는 한 번만 가린다.
  const overlap = [{ ...clues[0], spans: [[4, 10], [6, 13]] as [number, number][] }];
  assert.equal(maskText(text, overlap), "문의는 [가림]5678 또는 a@b.kr");
});

test("transform choices cover every finding of the job; declined caption edits become skip", () => {
  const clues = cluesFromFindings(findings, 0, 0).map((c) =>
    c.idx === 0 ? { ...c, action: "remove" as const } : c,
  );
  assert.deepEqual(choicesFor(clues, 0, true), [
    { idx: 0, action: "remove" },
    { idx: 1, action: "mask" },
    { idx: 2, action: "remove" },
    { idx: 3, action: "mask" },
  ]);
  assert.equal(choicesFor(clues, 0, false)[1].action, "skip");
  assert.deepEqual(choicesFor(clues, 1, true), []);
});

test("a region kept as-is and found again by re-verification is reported once", () => {
  const [kept, other] = cluesFromFindings(
    [
      { type: "address", source: "vlm", bbox: [0, 0, 100, 100] },
      { type: "face", source: "vlm", bbox: [300, 300, 400, 400] },
    ],
    0,
    0,
  ).map((c, i) => (i === 0 ? { ...c, action: "skip" as const } : c));
  const again = cluesFromFindings([{ type: "address", source: "vlm", bbox: [5, 5, 98, 102] }], 0, 0);
  const elsewhere = cluesFromFindings([{ type: "address", source: "vlm", bbox: [500, 500, 600, 600] }], 0, 0);
  assert.equal(matchKept([kept], again).get(kept.key), again[0]);
  assert.equal(matchKept([kept], elsewhere).size, 0);
  assert.equal(matchKept([other], again).size, 0);
});
