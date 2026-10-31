import { useEffect, useRef, useState } from "react";
import { regionLetters, type Clue, type EditAction } from "../flow";
import { renderPhoto, type Photo } from "../media";
import { Filmstrip } from "./Analysis";
import Icon, { type IconName } from "./Icon";
import PhotoView, { clueColor } from "./PhotoView";
import { RiskTag } from "./RiskTag";

type Tool = { id: string; label: string; icon: IconName; ready: boolean };
const TOOLS: Tool[] = [
  { id: "cover", label: "가리기", icon: "eye", ready: true },
  { id: "remove", label: "지우기", icon: "erase", ready: true },
  { id: "replace", label: "바꾸기", icon: "refresh", ready: false },
  { id: "crop", label: "잘라내기", icon: "crop", ready: false },
];

export const ACTION_LABEL: Record<EditAction, string> = {
  blur: "가리기 · 흐리게",
  mask: "가리기 · 덮기",
  remove: "지우기",
  skip: "그대로 두기",
};

/**
 * 04 보호 편집: ③이 추천한 보호를 적용한 모습을 보여 주고, 영역(A, B, C …)마다 바꿀 수 있다.
 * 미리보기는 브라우저에서 그리고, 적용하면 서버(③ 변환 → ② 재검증)로 보낸다.
 */
export default function Editor({
  photos,
  clues,
  textClueCount,
  onChange,
  onReset,
  onApply,
  onZoom,
}: {
  photos: Photo[];
  clues: Clue[];
  textClueCount: number;
  onChange: (key: string, action: EditAction) => void;
  onReset: (imageIndex: number) => void;
  onApply: () => void;
  onZoom: (url: string) => void;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [rendering, setRendering] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  // 사진이 여러 장이면 한 장씩 편집을 마쳐야 적용할 수 있다.
  const [confirmed, setConfirmed] = useState<boolean[]>(() => photos.map(() => false));
  const photo = photos[photoIndex];
  const regions = clues.filter((c) => c.kind === "image" && c.imageIndex === photoIndex);
  const fileClues = clues.filter((c) => c.kind === "file" && c.imageIndex === photoIndex);
  const letters = regionLetters(clues, photoIndex);
  const chosen = regions.find((c) => c.key === selected) ?? regions[0];
  const regionKey = regions.map((c) => `${c.key}=${c.action}`).join(",");

  // 선택이 바뀔 때마다 이 사진의 미리보기를 다시 그린다 (워커와 같은 방식).
  useEffect(() => {
    if (!photo) return;
    let url: string | undefined;
    let cancelled = false;
    setRendering(true);
    const timer = window.setTimeout(async () => {
      try {
        const blob = await renderPhoto(photo, regions);
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
    // regionKey 가 사진과 선택을 모두 담고 있다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, regionKey]);

  const many = photos.length > 1;
  const doneCount = confirmed.filter(Boolean).length;
  const nextPending = (from: number) => {
    for (let k = 1; k < photos.length; k++) {
      const i = (from + k) % photos.length;
      if (!confirmed[i]) return i;
    }
    return -1;
  };
  const isLast = !many || nextPending(photoIndex) === -1;
  function openPhoto(i: number) {
    setPhotoIndex(i);
    setSelected(undefined);
    setPreviewing(false);
  }
  function finishPhoto() {
    if (isLast) {
      setConfirmed((c) => c.map(() => true));
      onApply();
      return;
    }
    const next = nextPending(photoIndex);
    setConfirmed((c) => c.map((v, i) => v || i === photoIndex));
    openPhoto(next);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const toolOf = (a?: EditAction) => (a === "blur" || a === "mask" ? "cover" : a === "remove" ? "remove" : null);

  return (
    <div className="workspace-grid editor-grid" ref={top}>
      <section className="card image-workspace">
        <div className="image-toolbar">
          <span>
            <Icon name="image" size={16} />
            {photo ? `사진 ${photoIndex + 1} / ${photos.length}` : "글"}
            {many && <b className="done-count">편집 완료 {doneCount} / {photos.length}</b>}
          </span>
          <span className={`view-chip ${previewing ? "on" : ""}`}>
            {previewing ? "미리보기 · 보호가 적용된 모습" : "편집 · 영역을 눌러 바꿀 수 있어요"}
          </span>
        </div>
        <div className="image-stage">
          {photo ? (
            <>
              <PhotoView
                photo={photo}
                src={preview}
                clues={regions}
                labelOf={(c) => letters.get(c.key) ?? ""}
                selected={chosen?.key}
                showBoxes={!previewing}
                onSelect={(c) => {
                  setSelected(c.key);
                  setPreviewing(false);
                }}
              />
              {rendering && <span className="render-badge">그리는 중…</span>}
              <button
                className="undo-button"
                aria-label="이 사진을 추천 보호로 되돌리기"
                title="추천 보호로 되돌리기"
                onClick={() => onReset(photoIndex)}
              >
                <Icon name="undo" />
              </button>
              <button
                className="zoom-button"
                aria-label="미리보기 크게 보기"
                onClick={() => preview && onZoom(preview)}
              >
                <Icon name="search" />
              </button>
            </>
          ) : (
            <p className="text-preview">사진 없이 글만 올렸어요. 글은 적용할 때 확인해요.</p>
          )}
        </div>
        {photos.length > 1 && (
          <Filmstrip photos={photos} index={photoIndex} done={confirmed} onSelect={openPhoto} />
        )}
      </section>

      <aside className="card controls-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">보호 편집 · ③ 추천 보호 적용됨</span>
            <h2>영역마다 보호 방법을 바꿀 수 있어요</h2>
          </div>
          <span className="count-badge">{regions.length}</span>
        </div>

        <div className="region-list" role="listbox" aria-label="보호 영역">
          {regions.map((c) => (
            <button
              key={c.key}
              role="option"
              aria-selected={chosen?.key === c.key}
              className={`region-row ${chosen?.key === c.key ? "selected" : ""}`}
              onClick={() => {
                setSelected(c.key);
                setPreviewing(false);
              }}
            >
              <span className="region-letter" style={{ background: clueColor(c) }}>
                {letters.get(c.key)}
              </span>
              <span className="region-copy">
                <strong>
                  {c.title} <RiskTag risk={c.risk} />
                </strong>
                <small className={c.action === "skip" ? "kept" : ""}>
                  {ACTION_LABEL[c.action]}
                  {c.action !== c.recommended && " · 직접 바꿈"}
                </small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {!regions.length && (
            <p className="editor-note">이 사진에는 바꿀 영역이 없어요.</p>
          )}
        </div>

        {chosen && (
          <div className="editor">
            <label className="field-label">
              <b className="letter-inline" style={{ background: clueColor(chosen) }}>
                {letters.get(chosen.key)}
              </b>
              {chosen.title} · 어떻게 보호할까요?
            </label>
            <div className="edit-actions">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  disabled={!t.ready}
                  aria-pressed={toolOf(chosen.action) === t.id}
                  onClick={() =>
                    onChange(
                      chosen.key,
                      t.id === "remove"
                        ? "remove"
                        : chosen.action === "blur" || chosen.action === "mask"
                          ? chosen.action
                          : chosen.recommended === "mask"
                            ? "mask"
                            : "blur",
                    )
                  }
                >
                  <Icon name={t.icon} size={22} />
                  <span>{t.label}</span>
                  {!t.ready && <em>준비 중</em>}
                </button>
              ))}
            </div>
            {toolOf(chosen.action) === "cover" && (
              <div className="segmented" role="radiogroup" aria-label="가리는 방식">
                {(["blur", "mask"] as const).map((a) => (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={chosen.action === a}
                    onClick={() => onChange(chosen.key, a)}
                  >
                    {a === "blur" ? "흐리게" : "덮기"}
                  </button>
                ))}
              </div>
            )}
            <label className="skip-option">
              <input
                type="checkbox"
                checked={chosen.action === "skip"}
                onChange={(e) =>
                  onChange(chosen.key, e.target.checked ? "skip" : chosen.recommended)
                }
              />
              이 영역은 그대로 두기
            </label>
            <p className="editor-note">
              {chosen.action === "remove"
                ? "지우기는 지금은 단색으로 채워요. 자연스럽게 지우는 기능은 준비 중이에요."
                : "미리보기는 실제 적용 결과와 같은 방식으로 그려요."}
            </p>
          </div>
        )}

        {(fileClues.length > 0 || textClueCount > 0) && (
          <ul className="auto-notes">
            {fileClues.length > 0 && (
              <li>
                <Icon name="check" size={15} />
                사진 파일 정보(촬영 위치·기기)는 적용할 때 자동으로 지워요.
              </li>
            )}
            {textClueCount > 0 && (
              <li>
                <Icon name="info" size={15} />
                {many ? "모든 사진 편집이 끝나면" : "편집이 끝나면"} 글에서 찾은 단서 {textClueCount}개를
                가린 글을 적용할지 물어볼게요.
              </li>
            )}
          </ul>
        )}

        <div className="control-footer two">
          <button
            className="button secondary"
            disabled={!photo}
            onClick={() => setPreviewing((v) => !v)}
          >
            <Icon name={previewing ? "edit" : "search"} size={18} />
            {previewing ? "편집으로 돌아가기" : "미리보기"}
          </button>
          <button className="button primary" onClick={finishPhoto}>
            {isLast ? "적용" : `사진 ${photoIndex + 1} 완료 · 다음 사진`}
            <Icon name="arrow" />
          </button>
        </div>
      </aside>
    </div>
  );
}
