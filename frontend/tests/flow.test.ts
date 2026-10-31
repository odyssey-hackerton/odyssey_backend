import assert from "node:assert/strict";
import { test } from "node:test";
import { maskText, regionLetters, riskScore, textClues, type Clue } from "../src/flow.ts";

test("caption masking follows the worker rule: remove deletes, others become [가림]", () => {
  const text = "문의는 010-1234-5678 또는 a@b.kr";
  const clues = textClues(text);
  assert.deepEqual(
    clues.map((c) => c.type),
    ["phone_number", "email"],
  );
  assert.equal(maskText(text, clues), "문의는 [가림] 또는 [가림]");
  assert.equal(
    maskText(text, clues.map((c) => ({ ...c, action: "remove" as const }))),
    "문의는  또는 ",
  );
  assert.equal(maskText(text, clues.map((c) => ({ ...c, action: "skip" as const }))), text);
  // 겹치는 범위는 한 번만 가린다.
  const overlap = [{ ...clues[0], spans: [[4, 10], [6, 13]] as [number, number][] }];
  assert.equal(maskText(text, overlap), "문의는 [가림]5678 또는 a@b.kr");
  assert.deepEqual(textClues("연락처 없음"), []);
});

const region = (key: string, imageIndex: number, kind: Clue["kind"] = "image"): Clue => ({
  key,
  idx: 0,
  imageIndex,
  kind,
  type: "x",
  title: key,
  description: "",
  recommended: "mask",
  action: "mask",
});

test("regions are lettered A, B, C per photo; file and text clues get no letter", () => {
  const clues = [
    region("a", 0),
    region("file", 0, "file"),
    region("b", 0),
    region("c", 1),
  ];
  assert.deepEqual([...regionLetters(clues, 0)], [
    ["a", "A"],
    ["b", "B"],
  ]);
  assert.deepEqual([...regionLetters(clues, 1)], [["c", "A"]]);
});

test("risk score is the highest risk among the clues", () => {
  assert.equal(riskScore([{ ...region("a", 0), risk: "medium" }, { ...region("b", 0), risk: "high" }]), 0.82);
  assert.equal(riskScore([]), 0.05);
});
