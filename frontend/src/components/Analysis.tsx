import { useState } from "react";
import type { Clue } from "../flow";
import type { Photo } from "../media";
import Icon from "./Icon";
import PhotoView, { clueColor } from "./PhotoView";
import { RiskTag } from "./RiskTag";

/** 03 분석 결과: ① 탐지 + ② 위험 분석까지 끝난 상태. 아직 아무것도 바꾸지 않았다. */
export default function Analysis({
  photos,
  text,
  clues,
  demo,
  onRecommend,
  onDeep,
  onZoom,
}: {
  photos: Photo[];
  text: string;
  clues: Clue[];
  demo: boolean;
  onRecommend: () => void;
  onDeep: () => void;
  onZoom: (url: string) => void;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [selected, setSelected] = useState<string>();
  const photo = photos[photoIndex];
  const photoClues = clues.filter((c) => c.kind !== "text" && c.imageIndex === photoIndex);
  const textClues = clues.filter((c) => c.kind === "text");
  const listed = [...photoClues, ...textClues];
  const number = new Map(listed.map((c, i) => [c.key, String(i + 1)]));
  const otherPhotos = clues.filter(
    (c) => c.kind !== "text" && c.imageIndex !== photoIndex,
  ).length;

  return (
    <div className="workspace-grid">
      <section className="card image-workspace">
        <div className="image-toolbar">
          <span>
            <Icon name="image" size={16} />
            {photo ? `사진 ${photoIndex + 1} / ${photos.length}` : "글"}
          </span>
          <span>번호를 눌러 단서를 확인하세요</span>
        </div>
        <div className="image-stage">
          {photo ? (
            <>
              <PhotoView
                photo={photo}
                clues={photoClues}
                labelOf={(c) => number.get(c.key) ?? ""}
                selected={selected}
                onSelect={(c) => setSelected(c.key)}
              />
              <button
                className="zoom-button"
                aria-label="사진 크게 보기"
                onClick={() => onZoom(photo.url)}
              >
                <Icon name="search" />
              </button>
            </>
          ) : (
            <HighlightedText text={text} clues={textClues} />
          )}
        </div>
        {photos.length > 1 && (
          <Filmstrip
            photos={photos}
            index={photoIndex}
            counts={photos.map(
              (_, i) => clues.filter((c) => c.kind !== "text" && c.imageIndex === i).length,
            )}
            onSelect={(i) => {
              setPhotoIndex(i);
              setSelected(undefined);
            }}
          />
        )}
        {photo && text && (
          <div className="caption-strip">
            <span className="caption-label">함께 올릴 글</span>
            <HighlightedText text={text} clues={textClues} compact />
          </div>
        )}
      </section>
      <aside className="card controls-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">분석 리포트 · ① 탐지 ② 위험 분석 완료</span>
            <h2>사진 속에서 개인정보로 이어질 수 있는 단서예요</h2>
          </div>
          <span className="count-badge">{clues.length}</span>
        </div>
        <div className="clue-list">
          {listed.map((clue) => (
            <button
              key={clue.key}
              className={`clue-card ${selected === clue.key ? "selected" : ""}`}
              aria-pressed={selected === clue.key}
              onClick={() => setSelected(clue.key)}
            >
              <span className="clue-number" style={{ background: clueColor(clue) }}>
                {number.get(clue.key)}
              </span>
              <span className="clue-copy">
                <span className="clue-title">
                  {clue.title}
                  <RiskTag risk={clue.risk} />
                  {clue.kind !== "image" && (
                    <span className="kind-tag">
                      {clue.kind === "text" ? "글" : "파일 정보"}
                    </span>
                  )}
                </span>
                <span className="clue-description">{clue.description}</span>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
        {otherPhotos > 0 && (
          <p className="editor-note">다른 사진에서 찾은 단서 {otherPhotos}개는 아래 사진을 눌러 확인하세요.</p>
        )}
        {!clues.length && (
          <div className="empty-state">
            <Icon name="shield" size={32} />
            <h3>찾은 단서가 없어요</h3>
            <p>
              단서가 없다는 결과가 모든 개인정보의 안전을 보장하지는 않아요. 사진 파일 정보는
              보호 단계에서 지워요.
            </p>
          </div>
        )}
        <div className="control-footer">
          <button className="button primary full" onClick={onRecommend}>
            추천 보호안 보기
            <Icon name="arrow" />
          </button>
          <button className="button ghost full" onClick={onDeep}>
            <Icon name="spark" size={17} />
            심층 분석
          </button>
          <p className="editor-note center">
            심층 분석은 준비 중이에요. 지금은 보호 편집 없이 공유 단계로 넘어가요.
            {demo && " (화면 데모의 단서는 고정 예시예요.)"}
          </p>
        </div>
      </aside>
    </div>
  );
}

export function Filmstrip({
  photos,
  index,
  counts,
  onSelect,
}: {
  photos: { url: string }[];
  index: number;
  counts?: number[];
  onSelect: (i: number) => void;
}) {
  return (
    <div className="filmstrip">
      {photos.map((p, i) => (
        <button
          key={p.url}
          className={i === index ? "active" : ""}
          aria-label={`사진 ${i + 1} 보기`}
          aria-pressed={i === index}
          onClick={() => onSelect(i)}
        >
          <img src={p.url} alt="" />
          <span>{i + 1}</span>
          {!!counts?.[i] && <em className="film-count">{counts[i]}</em>}
        </button>
      ))}
    </div>
  );
}

/** 글에서 단서 문구를 강조해서 보여준다. */
export function HighlightedText({
  text,
  clues,
  compact = false,
}: {
  text: string;
  clues: Clue[];
  compact?: boolean;
}) {
  const spans = clues
    .flatMap((c) => c.spans ?? [])
    .filter(([s, e]) => e <= text.length && s < e)
    .sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of spans) {
    if (s < at) continue;
    if (s > at) parts.push({ text: text.slice(at, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <p className={compact ? "caption-text" : "text-preview"}>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </p>
  );
}
