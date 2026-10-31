// 화면 흐름에서 쓰는 순수 로직. 서버 호출이나 DOM 없이 테스트할 수 있게 모아 둔다.
//
// 서버는 작업 하나에 사진 1장(+글)을 받는다. 그래서 사진이 여러 장이면 사진마다 작업을 만들고,
// 글은 첫 번째 사진 작업에 붙여 사진과 함께 분석되게 한다(input_type=image_text).

import type { Finding } from "./api";
import { typeLabel } from "./labels";

export type EditAction = "blur" | "mask" | "remove" | "skip";
export type Risk = "high" | "medium" | "low";
/** image: 사진 속 영역, text: 글 속 문구, file: 사진 파일 정보(EXIF 등) */
export type ClueKind = "image" | "text" | "file";

export interface Clue {
  key: string;
  jobIndex: number;
  /** 서버 findings 배열의 인덱스. transform 요청의 idx 로 그대로 보낸다. */
  idx: number;
  imageIndex: number | null;
  kind: ClueKind;
  type: string;
  title: string;
  description: string;
  risk?: Risk;
  bbox?: [number, number, number, number];
  spans?: [number, number][];
  /** AI(③)가 추천한 처리. 되돌리기에 쓴다. */
  recommended: EditAction;
  action: EditAction;
}

export interface JobPlan {
  photoIndex: number | null;
  withText: boolean;
}

/** 사진마다 작업 하나. 글은 첫 사진과 함께, 사진이 없으면 글만 보낸다. */
export function planJobs(photoCount: number, hasText: boolean): JobPlan[] {
  if (photoCount === 0) return hasText ? [{ photoIndex: null, withText: true }] : [];
  return Array.from({ length: photoCount }, (_, i) => ({
    photoIndex: i,
    withText: hasText && i === 0,
  }));
}

const ACTIONS: EditAction[] = ["blur", "mask", "remove", "skip"];
const isAction = (v: unknown): v is EditAction =>
  typeof v === "string" && (ACTIONS as string[]).includes(v);
const isRisk = (v: unknown): v is Risk => v === "high" || v === "medium" || v === "low";

function spansOf(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const spans = value.filter(
    (s): s is [number, number] =>
      Array.isArray(s) &&
      s.length === 2 &&
      Number.isInteger(s[0]) &&
      Number.isInteger(s[1]) &&
      s[0] >= 0 &&
      s[1] > s[0],
  );
  return spans.length ? spans : undefined;
}

/** 서버 리포트의 findings 를 화면용 단서로 바꾼다. 모르는 필드·유형도 버리지 않고 표시한다. */
export function cluesFromFindings(
  findings: Finding[],
  jobIndex: number,
  photoIndex: number | null,
): Clue[] {
  return findings.map((f, idx) => {
    const spans = spansOf(f.spans);
    const kind: ClueKind =
      f.source === "text" || spans
        ? "text"
        : f.source === "exif" || !Array.isArray(f.bbox)
          ? "file"
          : "image";
    const recommended: EditAction =
      kind === "file" ? "remove" : isAction(f.action) && f.action !== "skip" ? f.action : "mask";
    return {
      key: `${jobIndex}:${idx}`,
      jobIndex,
      idx,
      imageIndex: kind === "text" ? null : photoIndex,
      kind,
      type: f.type,
      title: typeof f.title === "string" ? f.title : typeLabel(f.type),
      description:
        typeof f.description === "string"
          ? f.description
          : "이 단서로 무엇을 알 수 있는지 확인해 주세요.",
      risk: isRisk(f.risk_level) ? f.risk_level : undefined,
      bbox: kind === "image" ? (f.bbox as Clue["bbox"]) : undefined,
      spans,
      recommended,
      action: recommended,
    };
  });
}

/** 사진 한 장 안에서 영역 단서에 A, B, C … 를 붙인다. */
export function regionLetters(clues: Clue[], imageIndex: number): Map<string, string> {
  const letters = new Map<string, string>();
  clues
    .filter((c) => c.kind === "image" && c.imageIndex === imageIndex)
    .forEach((c, i) => letters.set(c.key, String.fromCharCode(65 + (i % 26))));
  return letters;
}

/**
 * 글 가림. 워커(stages/transform.py)와 같은 규칙:
 * remove 는 문구를 지우고, 나머지는 "[가림]" 으로 바꾼다. 겹친 범위는 합친다.
 */
export function maskText(text: string, clues: Clue[]): string {
  const edits: [number, number, string][] = [];
  for (const c of clues) {
    if (c.kind !== "text" || c.action === "skip" || !c.spans) continue;
    for (const [start, end] of c.spans) {
      if (end > text.length) continue;
      edits.push([start, end, c.action === "remove" ? "" : "[가림]"]);
    }
  }
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number, string][] = [];
  for (const e of edits) {
    const last = merged.at(-1);
    if (last && e[0] < last[1]) {
      last[1] = Math.max(last[1], e[1]);
      last[2] = last[2] || e[2];
    } else merged.push([...e]);
  }
  let out = text;
  for (const [start, end, replacement] of merged.reverse()) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

/** transform 요청에 보낼 선택. 그 작업의 모든 단서를 빠짐없이 보낸다. */
export function choicesFor(
  clues: Clue[],
  jobIndex: number,
  applyText: boolean,
): { idx: number; action: EditAction }[] {
  return clues
    .filter((c) => c.jobIndex === jobIndex)
    .map((c) => ({
      idx: c.idx,
      action: c.kind === "text" && !applyText ? "skip" : c.action,
    }));
}

/** 위험 등급을 0~1 점수로 (데모와 리포트에 점수가 없을 때 사용). */
export const RISK_SCORE: Record<Risk, number> = { high: 0.82, medium: 0.55, low: 0.3 };

export function riskScore(clues: Clue[]): number {
  return clues.reduce((max, c) => Math.max(max, c.risk ? RISK_SCORE[c.risk] : 0.3), 0.05);
}

// ---- 화면 데모용 예시 (서버 없이 흐름을 확인할 때만) ----

const PHONE = /01[016789]-?\d{3,4}-?\d{4}/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** 데모에서 글 속 전화번호·이메일을 찾는다. 실제 분석은 AI 워커가 한다. */
export function demoTextClues(text: string, jobIndex = 0): Clue[] {
  const found: { type: string; title: string; description: string; spans: [number, number][] }[] = [];
  const phones = [...text.matchAll(PHONE)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
  const emails = [...text.matchAll(EMAIL)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
  if (phones.length)
    found.push({
      type: "phone_number",
      title: "연락처 노출",
      description: "글에 적힌 전화번호로 연락처가 그대로 드러나요.",
      spans: phones,
    });
  if (emails.length)
    found.push({
      type: "email",
      title: "이메일 노출",
      description: "글에 적힌 이메일 주소로 계정을 찾을 수 있어요.",
      spans: emails,
    });
  return found.map((f, i) => ({
    key: `${jobIndex}:t${i}`,
    jobIndex,
    idx: 100 + i,
    imageIndex: null,
    kind: "text",
    type: f.type,
    title: f.title,
    description: f.description,
    risk: "high",
    spans: f.spans,
    recommended: "mask",
    action: "mask",
  }));
}

/** 두 영역이 얼마나 겹치는지 (0~1). 재검증에서 다시 찾은 단서가 사용자가 남겨 둔 영역인지 판단할 때 쓴다. */
export function overlap(a?: Clue["bbox"], b?: Clue["bbox"]): number {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (r: NonNullable<Clue["bbox"]>) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

/** 재검증에서 다시 찾은 단서 중, 사용자가 '그대로 두기'한 영역과 같은 것을 짝지어 준다. */
export function matchKept(kept: Clue[], remaining: Clue[]): Map<string, Clue> {
  const matched = new Map<string, Clue>();
  for (const r of remaining) {
    const k = kept.find(
      (c) =>
        !matched.has(c.key) &&
        c.imageIndex === r.imageIndex &&
        (overlap(c.bbox, r.bbox) > 0.3 || (c.kind === r.kind && c.kind === "text" && c.type === r.type)),
    );
    if (k) matched.set(k.key, r);
  }
  return matched;
}
