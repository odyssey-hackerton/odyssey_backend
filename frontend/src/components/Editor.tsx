import { useEffect, useRef, useState } from "react";
import { ACTION_LABEL, ALLOWED_ACTIONS, CATEGORY_LABEL, generationBase, regionLetters, type Clue, type EditAction } from "../flow";
import { renderPhoto, type Photo } from "../media";
import { Filmstrip } from "./Analysis";
import Icon, { type IconName } from "./Icon";
import ImageRegeneration from "./ImageRegeneration";
import PhotoView, { clueColor } from "./PhotoView";
import { RiskTag } from "./RiskTag";

export { ACTION_LABEL } from "../flow";
const TOOL_ICONS: Record<EditAction, IconName> = {
  mask: "eye", blur: "search", mosaic: "image", partialMask: "edit",
  remove: "erase", regenerate: "refresh", skip: "eye",
};

export default function Editor({ photos, clues, textClueCount, onChange, onReset, onApply, onZoom, onGenerated, onBusy, busy, generationAttempts, onGenerationAttempt, demo = false }: {
  demo?: boolean;
  busy: boolean;
  photos: Photo[];
  clues: Clue[];
  textClueCount: number;
  generationAttempts: Record<number, number>;
  onGenerationAttempt: (index: number) => void;
  onChange: (key: string, patch: Partial<Clue>) => void;
  onReset: (imageIndex: number) => void;
  onApply: () => void;
  onZoom: (url: string) => void;
  onGenerated: (key: string, blob: Blob) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState<boolean[]>(() => photos.map(() => false));
  const top = useRef<HTMLFieldSetElement>(null);
  const photo = photos[photoIndex];
  const attempts = generationAttempts[photoIndex] ?? 0;
  const regions = clues.filter((c) => c.kind === "image" && c.imageIndex === photoIndex && !c.deleted);
  const chosen = regions.find((c) => c.key === selected) ?? regions[0];
  const letters = regionLetters(clues, photoIndex);
  const regionKey = JSON.stringify(regions);
  const fileClues = clues.filter((c) => c.kind === "file" && c.imageIndex === photoIndex);
  const pendingMask = clues.some((c) => !c.deleted && c.action === "partialMask" && !c.maskBox);

  useEffect(() => {
    if (!photo) return;
    let url: string | undefined;
    let cancelled = false;
    setRendering(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const blob = await renderPhoto(photo, regions.map((c) => c.action === "regenerate" && !c.generatedUrl ? { ...c, action: "mask" } : c.action === "partialMask" && !c.maskBox ? { ...c, action: "skip" } : c));
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "미리보기를 만들지 못했어요.");
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 80);
    return () => { cancelled = true; window.clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
    // regionKey includes geometry, effects and generated patches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, regionKey]);

  function change(key: string, patch: Partial<Clue>) {
    setConfirmed((all) => all.map((v, i) => i === photoIndex ? false : v));
    onChange(key, patch);
  }
  function openPhoto(i: number) {
    if (i === photoIndex) return;
    setPhotoIndex(i); setSelected(undefined); setPreviewing(false); setPreview(undefined);
  }
  const nextPending = photos.findIndex((_, i) => i !== photoIndex && !confirmed[i]);
  function finishPhoto() {
    if (nextPending === -1) { onApply(); return; }
    setConfirmed((all) => all.map((v, i) => v || i === photoIndex));
    openPhoto(nextPending);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <fieldset className="workspace-grid editor-grid editor-fieldset" disabled={busy} aria-label="AI 보호 편집" ref={top}>
      <section className="card image-workspace">
        <div className="image-toolbar">
          <span><Icon name="image" size={16} />{photo ? `사진 ${photoIndex + 1} / ${photos.length}` : "글"}
            {photos.length > 1 && <b className="done-count">편집 완료 {confirmed.filter(Boolean).length} / {photos.length}</b>}
          </span>
          <span className={`view-chip ${previewing ? "on" : ""}`}>
            {previewing ? "미리보기 · 보호가 적용된 모습" : "편집 · 영역을 눌러 바꿀 수 있어요"}
          </span>
        </div>
        <div className="image-stage">
          {photo ? <>
            <PhotoView key={`${photoIndex}:${chosen?.key}:${chosen?.action}`} photo={photo} src={preview} clues={regions}
              labelOf={(c) => letters.get(c.key) ?? ""} selected={chosen?.key} showBoxes={!previewing}
              onBoxChange={!busy ? (key, bbox) => change(key, { bbox }) : undefined}
              onMaskChange={!busy ? (key, maskBox) => change(key, { maskBox }) : undefined}
              onDelete={!busy ? (key) => change(key, { deleted: true, action: "skip" }) : undefined}
              onSelect={(c) => { if (!busy) { setSelected(c.key); setPreviewing(false); } }} />
            {rendering && <span className="render-badge">그리는 중…</span>}
            <button className="undo-button" aria-label="이 사진을 추천 보호로 되돌리기" title="추천 보호로 되돌리기"
              onClick={() => { onReset(photoIndex); setConfirmed((all) => all.map((v, i) => i === photoIndex ? false : v)); }}>
              <Icon name="undo" />
            </button>
            <button className="zoom-button" aria-label="미리보기 크게 보기" disabled={!preview || rendering || !!error}
              onClick={() => preview && onZoom(preview)}><Icon name="search" /></button>
          </> : <p className="text-preview">사진 없이 글만 올렸어요. 글은 적용할 때 확인해요.</p>}
        </div>
        {photo && chosen?.bbox && (
          <ImageRegeneration key={`${photoIndex}:${chosen.key}`} demo={demo}
            letter={letters.get(chosen.key) ?? ""}
            bbox={chosen.bbox} attempts={attempts} disabled={busy || rendering || pendingMask || !!error}
            prepareImage={() => renderPhoto(photo, generationBase(clues, photoIndex, chosen.key))}
            onAttempt={() => onGenerationAttempt(photoIndex)}
            onGenerated={(blob) => {
              onGenerated(chosen.key, blob);
              setConfirmed((all) => all.map((v, i) => i === photoIndex ? false : v));
            }}
            onBusy={onBusy} />
        )}
        {photos.length > 1 && <Filmstrip photos={photos} index={photoIndex} done={confirmed} onSelect={openPhoto} />}
      </section>

      <aside className="card controls-card">
        <div className="section-heading">
          <div><span className="eyebrow">{demo ? "화면 데모 · 샘플 영역" : "보호 편집 · 추천 보호 적용됨"}</span>
            <h2>영역마다 보호 방법을 바꿀 수 있어요</h2></div>
          <span className="count-badge">{regions.length}</span>
        </div>
        <div className="region-list" role="listbox" aria-label="보호 영역">
          {regions.map((c) => (
            <button key={c.key} role="option" aria-selected={chosen?.key === c.key}
              className={`region-row ${chosen?.key === c.key ? "selected" : ""}`}
              onClick={() => { setSelected(c.key); setPreviewing(false); }}>
              <span className="region-letter" style={{ background: clueColor(c) }}>{letters.get(c.key)}</span>
              <span className="region-copy"><strong>{c.title} <RiskTag risk={c.risk} /></strong>
                <small className={c.action === "skip" ? "kept" : ""}>
                  {CATEGORY_LABEL[c.category ?? "object"]} · {ACTION_LABEL[c.action]}
                  {c.action !== c.recommended && " · 직접 바꿈"}
                </small>
              </span><Icon name="chevron" size={14} />
            </button>
          ))}
          {!regions.length && <p className="editor-note">이 사진에는 바꿀 영역이 없어요.</p>}
        </div>

        {chosen && <div className="editor">
          <label className="field-label">
            <b className="letter-inline" style={{ background: clueColor(chosen) }}>{letters.get(chosen.key)}</b>
            {chosen.title} · 어떻게 보호할까요?
          </label>
          <div className="edit-actions">
            {ALLOWED_ACTIONS[chosen.category ?? "object"].map((id) => (
              <button key={id} aria-pressed={chosen.action === id}
                onClick={() => change(chosen.key, { action: id })}>
                <Icon name={TOOL_ICONS[id]} size={22} /><span>{ACTION_LABEL[id]}</span>
              </button>
            ))}
          </div>
          {chosen.action === "partialMask" && <>
            <p className="editor-note">네모 안에서 가릴 부분을 드래그해 주세요. 다시 드래그하면 범위가 바뀌어요.</p>
            <p id="partial-mask-keyboard" className="visually-hidden">키보드: 사진의 영역에서 Enter를 누르고 방향키로 시작점을 이동하세요. Enter로 시작점을 정하고 방향키로 끝점을 이동한 뒤 Enter로 적용하세요. Shift는 10픽셀씩 이동하고 Escape는 취소합니다.</p>
          </>}
          {chosen.action === "remove" && <p className="editor-note">선택 영역을 주변 배경으로 채워요. 복잡한 무늬에서는 흔적이 남을 수 있어요.</p>}
          <p className="editor-note">모서리를 드래그해 크기를 조절하고 ×로 영역을 삭제해요. 중심과 비율은 유지돼요.</p>
          <label className="skip-option">
            <input type="checkbox" checked={chosen.action === "skip"}
              onChange={(e) => change(chosen.key, { action: e.target.checked ? "skip" : chosen.recommended })} />
            이 영역은 그대로 두기
          </label>
        </div>}

        {(fileClues.length > 0 || textClueCount > 0) && <ul className="auto-notes">
          {fileClues.length > 0 && <li><Icon name="check" size={15} />사진 파일 정보(촬영 위치·기기)는 적용할 때 자동으로 지워요.</li>}
          {textClueCount > 0 && <li><Icon name="info" size={15} />편집이 끝나면 글에서 찾은 단서 {textClueCount}개를 가린 글을 적용할지 물어볼게요.</li>}
        </ul>}
        {error && <p className="editor-warning" role="alert">{error}</p>}
        <div className="control-footer two">
          <button className="button secondary" disabled={!photo} onClick={() => setPreviewing((v) => !v)}>
            <Icon name={previewing ? "edit" : "search"} size={18} />{previewing ? "편집으로 돌아가기" : "미리보기"}
          </button>
          <button className="button primary" disabled={rendering || !!error || pendingMask || busy} onClick={finishPhoto}>
            {nextPending === -1 ? "적용" : `사진 ${photoIndex + 1} 완료 · 다음 사진`}<Icon name="arrow" />
          </button>
        </div>
      </aside>
    </fieldset>
  );
}
