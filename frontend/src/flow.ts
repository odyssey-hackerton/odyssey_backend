// 보호 편집 흐름에서 쓰는 순수 로직. 화면 없이 테스트할 수 있게 모아 둔다.
// 단서는 서버 게시물 리포트(/api/posts/{id}/report)의 findings 에서 만든다.

import type { Choice, Finding, PostReport } from "./api";

export type EditAction = "blur" | "mask" | "remove" | "skip";
export type Risk = "high" | "medium" | "low";
/** image: 사진 속 영역, text: 글 속 문구, file: 사진 파일 정보(EXIF 등) */
export type ClueKind = "image" | "text" | "file";

export interface Clue {
  key: string;
  /** 게시물 안의 항목 순서 (= 사진 순서). transform 요청의 position. */
  position: number;
  /** 그 항목 findings 배열의 인덱스. transform 요청의 idx. */
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

/** 사진 한 장 안에서 영역 단서에 A, B, C … 를 붙인다. */
export function regionLetters(clues: Clue[], imageIndex: number): Map<string, string> {
  const letters = new Map<string, string>();
  clues
    .filter((c) => c.kind === "image" && c.imageIndex === imageIndex)
    .forEach((c, i) => letters.set(c.key, String.fromCharCode(65 + (i % 26))));
  return letters;
}

/**
 * 글 가림. AI 워커(stages/transform.py)와 같은 규칙:
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

/** 한 항목의 findings 를 화면용 단서로 바꾼다. 모르는 유형·필드도 버리지 않고 표시한다. */
export function cluesFromFindings(
  findings: Finding[],
  position: number,
  imageIndex: number | null,
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
      key: `${position}:${idx}`,
      position,
      idx,
      imageIndex: kind === "text" ? null : imageIndex,
      kind,
      type: f.type,
      title: typeof f.title === "string" ? f.title : f.type,
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

/** 게시물 리포트 전체를 단서로. 사진이 있는 항목은 position 이 곧 사진 번호다. */
export function cluesFromReport(report: PostReport): Clue[] {
  return report.items.flatMap((item) =>
    cluesFromFindings(
      item.findings,
      item.position,
      item.input_type === "text" ? null : item.position,
    ),
  );
}

/** transform 요청에 보낼 선택. 모든 단서를 보내고, 글을 고치지 않기로 했으면 글 단서는 skip. */
export function choicesFor(clues: Clue[], applyText: boolean): Choice[] {
  return clues.map((c) => ({
    position: c.position,
    idx: c.idx,
    action: c.kind === "text" && !applyText ? "skip" : c.action,
  }));
}

/** 두 영역이 얼마나 겹치는지 (0~1). */
export function overlap(a?: Clue["bbox"], b?: Clue["bbox"]): number {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (r: NonNullable<Clue["bbox"]>) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

/** 재검증에서 다시 찾은 단서 중, 사용자가 그대로 둔 단서와 같은 것을 짝지어 한 줄로 보여 준다. */
export function matchKept(kept: Clue[], remaining: Clue[]): Map<string, Clue> {
  const matched = new Map<string, Clue>();
  for (const r of remaining) {
    const k = kept.find(
      (c) =>
        !matched.has(c.key) &&
        c.imageIndex === r.imageIndex &&
        (overlap(c.bbox, r.bbox) > 0.3 ||
          (c.kind === "text" && r.kind === "text" && c.type === r.type)),
    );
    if (k) matched.set(k.key, r);
  }
  return matched;
}
