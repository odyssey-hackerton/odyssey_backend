// 보호 편집 흐름에서 쓰는 순수 로직. 화면 없이 테스트할 수 있게 모아 둔다.
// 서버 없이 브라우저에서만 동작한다. 단서는 예시 데이터와 글 속 전화번호·이메일 찾기로 만든다.

export type EditAction = "blur" | "mask" | "remove" | "skip";
export type Risk = "high" | "medium" | "low";
/** image: 사진 속 영역, text: 글 속 문구, file: 사진 파일 정보(EXIF 등) */
export type ClueKind = "image" | "text" | "file";

export interface Clue {
  key: string;
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

/** 위험 등급을 0~1 점수로 (데모와 리포트에 점수가 없을 때 사용). */
export const RISK_SCORE: Record<Risk, number> = { high: 0.82, medium: 0.55, low: 0.3 };

export function riskScore(clues: Clue[]): number {
  return clues.reduce((max, c) => Math.max(max, c.risk ? RISK_SCORE[c.risk] : 0.3), 0.05);
}

// ---- 글 속 연락처 찾기 ----

const PHONE = /01[016789]-?\d{3,4}-?\d{4}/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** 글 속 전화번호·이메일을 찾는다. */
export function textClues(text: string): Clue[] {
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
    key: `text:${i}`,
    idx: i,
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
