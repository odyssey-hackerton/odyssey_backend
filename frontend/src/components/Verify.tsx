import { useState } from "react";
import { regionLetters, type Clue } from "../flow";
import type { Photo } from "../media";
import { Filmstrip } from "./Analysis";
import Icon from "./Icon";

const DONE_WORD = { blur: "흐리게 가렸어요", mask: "덮어서 가렸어요", remove: "지웠어요", skip: "" };

type Row = { key: string; ok: boolean; title: string; detail: string };

/**
 * 05 재검증: ③ 변환 결과를 ② 위험 분석으로 다시 확인한 결과.
 * 남은 위험이 있으면 추가 보호(04로), 사용자가 알고 넘어가면 공유(06)로 간다.
 */
export default function Verify({
  before,
  after,
  text,
  outputText,
  clues,
  applyText,
  riskBefore,
  riskAfter,
  onMore,
  onContinue,
}: {
  before: Photo[];
  after: Photo[];
  text: string;
  outputText: string;
  clues: Clue[];
  applyText: boolean;
  riskBefore: number | null;
  riskAfter: number | null;
  onMore: () => void;
  onContinue: () => void;
}) {
  const [index, setIndex] = useState(0);
  const textClues = clues.filter((c) => c.kind === "text");

  const rows: Row[] = [];
  before.forEach((_, imageIndex) => {
    const letters = regionLetters(clues, imageIndex);
    const prefix = before.length > 1 ? `사진 ${imageIndex + 1} · ` : "";
    for (const c of clues.filter((x) => x.imageIndex === imageIndex && x.kind === "image")) {
      const letter = letters.get(c.key);
      rows.push(
        c.action === "skip"
          ? {
              key: c.key,
              ok: false,
              title: `${prefix}${c.title} 그대로 둠`,
              detail: `${letter} 영역은 직접 그대로 두기로 했어요. 공유 후에도 보여요.`,
            }
          : {
              key: c.key,
              ok: true,
              title: `${prefix}${c.title} 보호`,
              detail: `${letter} 영역을 ${DONE_WORD[c.action]}.`,
            },
      );
    }
    if (clues.some((x) => x.imageIndex === imageIndex && x.kind === "file"))
      rows.push({
        key: `file-${imageIndex}`,
        ok: true,
        title: `${prefix}사진 파일 정보 제거`,
        detail: "촬영 위치·기기 같은 파일 정보를 지웠어요.",
      });
  });
  if (textClues.length)
    rows.push(
      applyText
        ? {
            key: "text",
            ok: true,
            title: "글 속 단서 가림",
            detail: `${textClues.map((c) => c.title).join(", ")} 부분을 가렸어요.`,
          }
        : {
            key: "text",
            ok: false,
            title: "글은 원래대로",
            detail: "글은 고치지 않기로 했어요. 찾은 단서가 글에 그대로 있어요.",
          },
    );
  const warnings = rows.filter((r) => !r.ok).length;
  const pct = (v: number | null) => (v == null ? null : Math.round(v * 100));
  const b = pct(riskBefore);
  const a = pct(riskAfter);

  return (
    <section className="card verification-card">
      <div className="section-heading">
        <span className={`icon-tile ${warnings ? "amber" : "mint"}`}>
          <Icon name={warnings ? "info" : "shield"} size={25} />
        </span>
        <div>
          <span className="eyebrow">③ 변환 → ② 재검증 완료</span>
          <h2>{warnings ? `확인이 필요한 단서가 ${warnings}개 있어요` : "보호 효과를 확인했어요"}</h2>
          <p>편집된 사진과 글을 다시 분석한 결과예요. 아직 남아 있는 단서도 확인해 보세요.</p>
        </div>
        {b != null && a != null && (
          <div className="risk-meter" aria-label={`노출 위험 ${b}에서 ${a}로`}>
            <span>노출 위험</span>
            <div>
              <strong className="before">{b}</strong>
              <Icon name="arrow" size={16} />
              <strong className={a >= 50 ? "after high" : a >= 30 ? "after mid" : "after"}>{a}</strong>
            </div>
            <i
              style={{
                ["--w" as string]: `${a}%`,
                ["--c" as string]: a >= 50 ? "#f26478" : a >= 30 ? "#efa310" : "#1eb487",
              }}
            />
          </div>
        )}
      </div>

      {before[index] && after[index] && (
        <div className="compare-grid">
          <figure>
            <img src={before[index].url} alt="편집 전 사진" />
            <figcaption>편집 전</figcaption>
          </figure>
          <figure>
            <img src={after[index].url} alt="편집 후 사진" />
            <figcaption>편집 후</figcaption>
          </figure>
        </div>
      )}
      {before.length > 1 && (
        <Filmstrip photos={after} index={index} onSelect={setIndex} />
      )}
      {text && (
        <div className="compare-grid text-pair">
          <figure>
            <p className="text-preview">{text}</p>
            <figcaption>원래 글</figcaption>
          </figure>
          <figure>
            <p className="text-preview">{outputText}</p>
            <figcaption>{outputText === text ? "글 · 바뀐 곳 없음" : "고친 글"}</figcaption>
          </figure>
        </div>
      )}

      <div className="verification-list">
        {rows.map((r) => (
          <div className="verification-row" key={r.key}>
            <span className={`status-dot ${r.ok ? "" : "warning"}`}>
              <Icon name={r.ok ? "check" : "info"} size={16} />
            </span>
            <div>
              <strong>{r.title}</strong>
              <p>{r.detail}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="residual-note">
        <Icon name="info" size={19} />
        <p>
          자동으로 찾지 못한 정보가 남아 있을 수 있어요. 공유 전에 결과 사진과 글을 직접 확인해
          주세요.
        </p>
      </div>
      <div className="bottom-actions">
        <button className="button secondary" onClick={onMore}>
          추가 보호
          <Icon name="edit" size={17} />
        </button>
        <button className="button primary" onClick={onContinue}>
          {warnings ? "잔여 위험 확인 후 계속" : "공유 준비하기"}
          <Icon name="arrow" />
        </button>
      </div>
    </section>
  );
}
