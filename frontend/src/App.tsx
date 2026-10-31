import { useEffect, useRef, useState } from "react";
import { maskText, riskScore, textClues, type Clue, type EditAction } from "./flow";
import {
  demoClues,
  hasExif,
  photoFromBlob,
  readPhoto,
  renderPhoto,
  validateFiles,
  type Photo,
} from "./media";
import Analysis from "./components/Analysis";
import Editor from "./components/Editor";
import Icon from "./components/Icon";
import InputPanel from "./components/InputPanel";
import ProgressTrack, { type Stage } from "./components/ProgressTrack";
import ResultView from "./components/ResultView";
import TextReview from "./components/TextReview";
import Verify from "./components/Verify";

// 서버 없이 브라우저에서만 동작한다. 사진·글은 어디에도 보내지 않는다.
// 단서는 예시 영역 + 글 속 전화번호·이메일 + 사진 파일 정보(EXIF) 확인으로 만들고,
// 보호 편집은 Canvas 로 그린다. AI 에이전트 단계(① 탐지 → ② 분석 → ③ 변환 → ② 재검증)는
// 진행 표시로만 보여 준다.

const STEPS = ["홈", "업로드", "분석 결과", "보호 편집", "재검증", "공유"];
const TITLES = [
  "",
  "사진을 추가해 주세요",
  "보호가 필요한 단서",
  "필요한 부분만, 원하는 방식으로",
  "보호 효과를 확인했어요",
  "게시할 준비가 됐어요",
];
const SUBTITLES = [
  "",
  "게시할 사진(최대 4장)과 함께 올릴 글을 넣어 주세요.",
  "① 탐지와 ② 위험 분석 결과예요. 아직 아무것도 바꾸지 않았어요.",
  "추천 보호가 적용된 모습이에요. 영역을 눌러 가리거나 지우거나 그대로 둘 수 있어요.",
  "편집한 결과를 다시 확인했어요.",
  "보호된 사진과 글로 더 안심하고 공유하세요.",
];
const STAGE_MS = 650;

type Verification = { before: number; after: number };

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 처리하지 못했어요. 다시 시도해 주세요.";
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export default function App() {
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(1);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState("");
  const [clues, setClues] = useState<Clue[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [applyText, setApplyText] = useState(true);
  const [outputs, setOutputs] = useState<Photo[]>([]);
  const [outputText, setOutputText] = useState("");
  const [verification, setVerification] = useState<Verification | null>(null);
  const [skippedEdit, setSkippedEdit] = useState(false);
  const [busy, setBusy] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const objectUrls = useRef(new Set<string>());
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  useEffect(() => {
    if (step > 0) heading.current?.focus();
  }, [step]);

  const track = (p: Photo) => {
    objectUrls.current.add(p.url);
    return p;
  };

  function go(next: number) {
    setStep(next);
    setFurthest((old) => Math.max(old, next));
    setError("");
  }
  /** 입력이 바뀌면 그 뒤 단계 결과는 모두 무효 */
  function invalidate() {
    setClues([]);
    setOutputs([]);
    setOutputText("");
    setVerification(null);
    setSkippedEdit(false);
    setFurthest(1);
  }
  function reset() {
    invalidate();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
    setPhotos([]);
    setText("");
    go(0);
  }

  /** 단계 진행 표시를 보여 주며 작업을 실행한다. */
  async function run(label: string, stages: Stage[], task: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    try {
      for (const s of stages) {
        setStage(s);
        await wait(STAGE_MS);
      }
      await task();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy("");
      setStage(null);
    }
  }

  const renderAll = (base: Photo[], items: Clue[]) =>
    Promise.all(
      base.map(async (p, i) =>
        track(
          await photoFromBlob(
            await renderPhoto(p, items.filter((c) => c.imageIndex === i)),
            `odyssey-${i + 1}.png`,
          ),
        ),
      ),
    );

  // ---- 02 → 03: ① 탐지 + ② 위험 분석 ----
  async function analyze() {
    const caption = text.trim();
    if (!photos.length && !caption) return;
    await run("사진과 글에서 단서를 찾고 있어요", ["DETECTING", "ANALYZING"], async () => {
      const exif = await Promise.all(photos.map((p) => hasExif(p.file)));
      const fileClues: Clue[] = exif.flatMap((has, imageIndex) =>
        has
          ? [
              {
                key: `${imageIndex}:file`,
                idx: 99,
                imageIndex,
                kind: "file" as const,
                type: "metadata",
                title: "사진 파일 정보",
                description: "촬영 위치·시각·기기 같은 정보가 파일에 남아 있어요.",
                risk: "medium" as const,
                recommended: "remove" as const,
                action: "remove" as const,
              },
            ]
          : [],
      );
      setClues([...demoClues(photos), ...fileClues, ...textClues(caption)]);
      go(2);
    });
  }

  // ---- 03 → 06: 심층 분석은 아직 없어 보호 편집 없이 공유 단계로 ----
  async function skipToShare() {
    await run("공유할 파일을 준비하고 있어요", [], async () => {
      // 원본 그대로지만 PNG로 다시 그려 사진 파일 정보(EXIF)는 남기지 않는다.
      setOutputs(await renderAll(photos, []));
      setOutputText(text.trim());
      setSkippedEdit(true);
      go(5);
    });
  }

  // ---- 04 편집 ----
  function changeAction(key: string, action: EditAction) {
    setClues((all) => all.map((c) => (c.key === key ? { ...c, action } : c)));
    setFurthest(3);
  }
  function resetPhoto(imageIndex: number) {
    setClues((all) =>
      all.map((c) => (c.imageIndex === imageIndex ? { ...c, action: c.recommended } : c)),
    );
  }
  function requestApply() {
    if (clues.some((c) => c.kind === "text")) setReviewing(true);
    else void apply(false);
  }

  // ---- 04 → 05: ③ 변환 + ② 재검증 ----
  async function apply(useMaskedText: boolean) {
    setReviewing(false);
    setApplyText(useMaskedText);
    setSkippedEdit(false);
    const caption = text.trim();
    await run("보호를 적용하고 다시 확인하고 있어요", ["TRANSFORMING", "VERIFYING"], async () => {
      const rendered = await renderAll(photos, clues);
      const left = clues.filter(
        (c) => (c.kind === "image" && c.action === "skip") || (c.kind === "text" && !useMaskedText),
      );
      setOutputs(rendered);
      setOutputText(
        useMaskedText ? maskText(caption, clues.filter((c) => c.kind === "text")) : caption,
      );
      setVerification({
        before: riskScore(clues),
        after: left.length ? riskScore(left) * 0.8 : 0.08,
      });
      go(4);
    });
  }

  async function addFiles(files: File[]) {
    if (!files.length || busy) return;
    const issue = validateFiles(files, photos.length);
    if (issue) {
      setError(issue);
      return;
    }
    setError("");
    try {
      const added = (await Promise.all(files.map(readPhoto))).map(track);
      setPhotos((p) => [...p, ...added]);
      invalidate();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function sample() {
    if (busy) return;
    try {
      const response = await fetch("/cafe.jpg");
      if (!response.ok) throw new Error("예시 사진을 불러오지 못했어요.");
      const file = new File([await response.blob()], "cafe-example.jpg", { type: "image/jpeg" });
      invalidate();
      setPhotos([track(await readPhoto(file))]);
      setText("좋은 날, 카페에서 ☕ 예약 문의는 010-1234-5678");
      go(1);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" disabled={!!busy} onClick={() => go(0)} aria-label="Odyssey 홈">
            <span className="brand-mark">
              <Icon name="shield" size={23} />
            </span>
            <span>
              odyssey<span className="brand-caption">개인정보 보호 편집</span>
            </span>
          </button>
          <div className="header-right">
            <span className="header-tag">
              <span />
              게시 전, 한 번 더 안심
            </span>
          </div>
        </div>
      </header>
      <main className="page" aria-busy={!!busy}>
        <nav className="journey" aria-label="보호 편집 단계">
          {STEPS.map((label, index) => (
            <button
              key={label}
              disabled={index > furthest || !!busy}
              className={`${step === index ? "current" : ""} ${index < step ? "complete" : ""}`}
              aria-current={step === index ? "step" : undefined}
              onClick={() => go(index)}
            >
              <span className="step-number">
                {index < step ? <Icon name="check" size={15} /> : String(index + 1).padStart(2, "0")}
              </span>
              <span>{label}</span>
              {index < STEPS.length - 1 && <Icon name="chevron" size={14} />}
            </button>
          ))}
        </nav>
        {error && (
          <div className="alert error" role="alert">
            <Icon name="info" />
            <span>{error}</span>
            <button className="icon-button" aria-label="오류 알림 닫기" onClick={() => setError("")}>
              <Icon name="close" size={17} />
            </button>
          </div>
        )}

        {step === 0 ? (
          <Home busy={!!busy} onStart={() => go(1)} onSample={sample} />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  STEP {String(step + 1).padStart(2, "0")} / {STEPS[step]}
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  {step === 2 ? `${TITLES[2]} ${clues.length}개` : TITLES[step]}
                </h1>
                <p>{SUBTITLES[step]}</p>
              </div>
            </div>

            {step === 1 && (
              <InputPanel
                photos={photos}
                text={text}
                busy={!!busy}
                onFiles={addFiles}
                onRemove={(index) => {
                  setPhotos((p) => p.filter((_, i) => i !== index));
                  invalidate();
                }}
                onText={(value) => {
                  setText(value);
                  invalidate();
                }}
                onSample={sample}
                onSubmit={() => void analyze()}
              />
            )}
            {step === 2 && (
              <Analysis
                photos={photos}
                text={text.trim()}
                clues={clues}
                onRecommend={() => go(3)}
                onDeep={() => void skipToShare()}
                onZoom={setZoom}
              />
            )}
            {step === 3 && (
              <Editor
                photos={photos}
                clues={clues}
                textClueCount={clues.filter((c) => c.kind === "text").length}
                onChange={changeAction}
                onReset={resetPhoto}
                onApply={requestApply}
                onZoom={setZoom}
              />
            )}
            {step === 4 && verification && (
              <Verify
                before={photos}
                after={outputs}
                text={text.trim()}
                outputText={outputText}
                clues={clues}
                applyText={applyText}
                riskBefore={verification.before}
                riskAfter={verification.after}
                onMore={() => go(3)}
                onContinue={() => go(5)}
              />
            )}
            {step === 5 && (
              <ResultView
                photos={outputs}
                text={outputText}
                notice={
                  skippedEdit
                    ? `보호 편집 없이 넘어왔어요. 찾은 단서 ${clues.length}개가 그대로 있어요. 사진 파일 정보만 지웠어요.`
                    : undefined
                }
                onRestart={reset}
                onBack={() => go(skippedEdit ? 2 : 4)}
              />
            )}
          </>
        )}

        {!!busy && (
          <div className="busy-panel" role="status" aria-live="polite">
            {stage ? (
              <div className="busy-progress">
                <strong>{busy}</strong>
                <ProgressTrack status={stage} />
              </div>
            ) : (
              <>
                <span className="spinner" />
                {busy}
              </>
            )}
          </div>
        )}
        <footer className="site-footer">
          <span>
            <Icon name="shield" size={15} />
            나의 일상을, 나의 선택으로.
          </span>
          <span>Odyssey · Privacy before you post</span>
        </footer>
      </main>
      {reviewing && (
        <TextReview
          text={text.trim()}
          clues={clues.filter((c) => c.kind === "text")}
          onDecide={(yes) => void apply(yes)}
          onCancel={() => setReviewing(false)}
        />
      )}
      {zoom && <PhotoDialog url={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

function Home({ busy, onStart, onSample }: { busy: boolean; onStart: () => void; onSample: () => void }) {
  return (
    <>
      <section className="home-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="tiny-line" />
            SHARE THE MOMENT, KEEP YOUR PRIVACY
          </span>
          <h1>
            올리기 전에,
            <br />한 번 <span>확인해요.</span>
          </h1>
          <p>
            사진 속에 나도 모르게 담긴 개인정보,
            <br />
            지금 바로 점검하고 안전하게 공유해요.
          </p>
          <div className="hero-actions">
            <button className="button primary" disabled={busy} onClick={onStart}>
              바로 보호 편집하기
              <Icon name="arrow" size={19} />
            </button>
            <button className="text-button" disabled={busy} onClick={onSample}>
              예시로 먼저 둘러보기
              <Icon name="chevron" size={16} />
            </button>
          </div>
          <div className="hero-promise">
            <Icon name="shield" size={17} />
            <span>사진 최대 4장과 글을 함께 · 원하는 부분만 편집 · 간편한 공유</span>
          </div>
        </div>
        <div className="hero-visual">
          <div className="photo-backdrop" />
          <div className="hero-photo">
            <img src="/cafe.jpg" alt="일상의 순간을 담은 초록빛 카페 사진" />
            <span className="photo-label">
              <span />
              오늘의 작은 순간
            </span>
            <div className="hero-region">
              <span>위치 단서</span>
              <i />
              <i />
              <i />
              <i />
            </div>
            <span className="image-caption">좋은 날, 카페에서 ☕</span>
          </div>
          <div className="floating-protection">
            <span className="success-symbol">
              <Icon name="shield" size={24} />
            </span>
            <div>
              <strong>공유 전에, 한 번 더 확인</strong>
              <span>내가 보여주고 싶은 순간만.</span>
            </div>
            <Icon name="check" size={17} />
          </div>
          <span className="visual-spark spark-one">✳</span>
          <span className="visual-spark spark-two">+</span>
        </div>
      </section>
      <div className="home-options">
        <button className="card option-card" disabled={busy} onClick={onStart}>
          <span className="icon-tile">
            <Icon name="image" size={25} />
          </span>
          <div>
            <h2>새 게시물 보호</h2>
            <p>지금 올릴 사진을 분석하고 보호 편집해요.</p>
          </div>
          <Icon name="arrow" />
        </button>
        <button className="card option-card" disabled aria-disabled="true">
          <span className="icon-tile mint">
            <Icon name="clock" size={25} />
          </span>
          <div>
            <h2>
              이전 게시물 점검 <span className="soon-tag">준비 중</span>
            </h2>
            <p>올린 적 있는 사진도 다시 확인해요.</p>
          </div>
          <Icon name="arrow" />
        </button>
      </div>
    </>
  );
}

function PhotoDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="photo-dialog" onClose={onClose} aria-label="확대한 사진">
      <button className="icon-button" autoFocus aria-label="확대 닫기" onClick={() => dialog.current?.close()}>
        <Icon name="close" />
      </button>
      <img src={url} alt="확대한 사진" />
    </dialog>
  );
}
