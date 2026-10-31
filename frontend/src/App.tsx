import { useEffect, useRef, useState } from "react";
import {
  createPost,
  getPostReport,
  waitForPost,
  type JobStatus,
} from "./api";
import { cluesFromFindings, cluesFromReport, maskText, type Clue } from "./flow";
import { photoFromBlob, readPhoto, renderPhoto, validateFiles, type Photo } from "./media";
import Analysis from "./components/Analysis";
import Editor from "./components/Editor";
import Icon from "./components/Icon";
import InputPanel from "./components/InputPanel";
import ProgressTrack from "./components/ProgressTrack";
import ResultView from "./components/ResultView";
import TextReview from "./components/TextReview";
import Verify from "./components/Verify";

// 서버 게시물 API(/api/posts)로 동작한다.
// 03: 게시물 등록 → AI ① 탐지 + ② 위험 분석 → 사용자 선택 대기
// 04: 브라우저에서 편집한 최종 픽셀을 새 게시물 분석으로 재검증한다.
// 06의 건너뛰기(03에서)는 서버를 거치지 않고 사진 파일 정보만 지운다.

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
  "AI가 ① 탐지와 ② 위험 분석을 마쳤어요. 아직 아무것도 바꾸지 않았어요.",
  "추천 보호가 적용된 모습이에요. 영역을 눌러 가리거나 지우거나 그대로 둘 수 있어요.",
  "편집한 결과를 AI가 다시 분석했어요.",
  "보호된 사진과 글로 더 안심하고 공유하세요.",
];

type Verification = { before: number | null; after: number | null; remaining: Clue[] };

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 처리하지 못했어요. 다시 시도해 주세요.";
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export default function App() {
  const [step, setStep] = useState(0);
  const [demo, setDemo] = useState(false);
  const [furthest, setFurthest] = useState(1);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState("");
  // shortcut: counts reset on reload; persist only if editing must survive reloads.
  const [generationAttempts, setGenerationAttempts] = useState<Record<number, number>>({});
  const [postId, setPostId] = useState<string | null>(null);
  const [clues, setClues] = useState<Clue[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [applyText, setApplyText] = useState(true);
  const [outputs, setOutputs] = useState<Photo[]>([]);
  const [outputText, setOutputText] = useState("");
  const [initialRisk, setInitialRisk] = useState<number | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [skippedEdit, setSkippedEdit] = useState(false);
  const [busy, setBusy] = useState("");
  const [stage, setStage] = useState<JobStatus | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const objectUrls = useRef(new Set<string>());
  const running = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(
    () => () => {
      running.current?.abort();
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
    running.current?.abort();
    setPostId(null);
    setDemo(false);
    setGenerationAttempts({});
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

  /** 진행 표시를 띄우고 서버 작업을 실행한다. 새 작업을 시작하면 이전 대기는 취소된다. */
  async function run(label: string, task: (signal: AbortSignal) => Promise<void>) {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setBusy(label);
    setStage(null);
    setError("");
    try {
      await task(controller.signal);
    } catch (e) {
      if (!isAbort(e)) setError(messageOf(e));
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy("");
        setStage(null);
      }
    }
  }

  /** 게시물이 사용자 선택 대기·완료가 될 때까지 기다린다. 실패면 오류. */
  async function settle(id: string, signal: AbortSignal) {
    const state = await waitForPost(id, (s) => setStage(s.status), signal);
    if (state.status === "FAILED") {
      const failed = state.items.find((i) => i.status === "FAILED");
      throw new Error(failed?.error ?? "AI 처리에 실패했어요. 다시 시도해 주세요.");
    }
    return state;
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

  // ---- 02 → 03 (추가 보호면 → 04): 게시물 등록 → ① 탐지 + ② 위험 분석 ----
  async function analyze(base = photos, baseText = text, next = 2, commit?: () => void) {
    const caption = baseText.trim();
    if (!base.length && !caption) return;
    await run("AI가 사진과 글에서 단서를 찾고 있어요", async (signal) => {
      const { post_id } = await createPost(
        base.map((p) => p.file),
        caption,
      );
      await settle(post_id, signal);
      const report = await getPostReport(post_id);
      if (signal.aborted) return;
      commit?.();
      setPostId(post_id);
      setClues(cluesFromReport(report));
      setInitialRisk(report.risk_before);
      go(next);
    });
  }

  // ---- 03 → 06: 건너뛰기. 보호 편집 없이 공유 단계로 ----
  async function skipToShare() {
    await run("공유할 파일을 준비하고 있어요", async () => {
      // 원본 그대로지만 PNG로 다시 그려 사진 파일 정보(EXIF)는 남기지 않는다.
      setOutputs(await renderAll(photos, []));
      setOutputText(text.trim());
      setSkippedEdit(true);
      go(5);
    });
  }

  // ---- 04 편집 ----
  function changeRegion(key: string, patch: Partial<Clue>) {
    setClues((all) => all.map((c) => c.key === key ? { ...c, ...patch } : c));
    setFurthest(3);
  }
  function resetPhoto(imageIndex: number) {
    setClues((all) => all.map((c) => c.imageIndex === imageIndex ? {
      ...c, bbox: c.originalBox ?? c.bbox, action: c.recommended,
      deleted: false, maskBox: undefined, generatedUrl: undefined,
    } : c));
    setFurthest(3);
  }
  function generatedRegion(key: string, blob: Blob) {
    const generatedUrl = URL.createObjectURL(blob);
    objectUrls.current.add(generatedUrl);
    changeRegion(key, { generatedUrl, action: "regenerate" });
  }
  function requestApply() {
    if (busy) return;
    if (clues.some((c) => c.kind === "text")) setReviewing(true);
    else void apply(false);
  }

  // ---- 04 → 05: ③ 변환 + ② 재검증 ----
  async function apply(useMaskedText: boolean) {
    setReviewing(false);
    setApplyText(useMaskedText);
    setSkippedEdit(false);
    if (demo) {
      await run("샘플 편집 결과를 준비하고 있어요", async () => {
        setOutputs(await renderAll(photos, clues));
        setOutputText(text);
        go(5);
      });
      return;
    }
    if (!postId) return;
    await run("보호를 적용하고 AI가 다시 확인하고 있어요", async (signal) => {
      const loaded = await renderAll(photos, clues);
      const caption = useMaskedText ? maskText(text.trim(), clues) : text.trim();
      const issue = validateFiles(loaded.map((p) => p.file), 0);
      if (issue) throw new Error(`편집 결과: ${issue}`);
      let remaining: Clue[] = [];
      let after: number | null = null;
      if (loaded.length || caption) {
        const { post_id } = await createPost(loaded.map((p) => p.file), caption);
        await settle(post_id, signal);
        const report = await getPostReport(post_id);
        remaining = cluesFromReport(report).filter((c) => c.kind !== "file");
        after = report.risk_before;
      }
      if (signal.aborted) return;
      setOutputs(loaded);
      setOutputText(caption);
      setVerification({ before: initialRisk, after, remaining });
      go(4);
    });
  }

  // ---- 05 → 04: 추가 보호. 편집된 결과를 새 게시물로 다시 분석한다 ----
  async function moreProtection() {
    const base = outputs;
    const baseText = outputText;
    await analyze(base, baseText, 3, () => {
      setPhotos(base);
      setText(baseText);
      setOutputs([]);
      setVerification(null);
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
      const photo = track(await readPhoto(file));
      const { width: w, height: h } = photo;
      invalidate();
      setDemo(true);
      setPhotos([photo]);
      setText("좋은 날, 카페에서 ☕");
      setClues(cluesFromFindings([
        { type: "store", category: "text", title: "카페 간판", description: "텍스트 편집을 체험하는 샘플 영역이에요.",
          bbox: [w * .23, h * .365, w * .51, h * .405], action: "mask" },
        { type: "object", category: "object", title: "자전거", description: "객체 편집을 체험하는 샘플 영역이에요.",
          bbox: [w * .78, h * .58, w * .94, h * .65], action: "mosaic" },
        { type: "architecture", category: "location", title: "건물 외관", description: "간접 위치 단서 편집을 체험하는 샘플 영역이에요.",
          bbox: [w * .81, h * .16, w * .99, h * .43], action: "mask" },
      ], 0, 0));
      go(3);
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
              disabled={index > furthest || !!busy || (demo && [1, 2, 4].includes(index))}
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
        {demo && step > 0 && (
          <p className="editor-warning" role="status">
            화면 데모 · 샘플 영역으로 편집을 체험해요. 실제 AI 탐지·재검증·이미지 생성은 실행하지 않아요.
          </p>
        )}
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
          <Home busy={!!busy} onStart={() => { if (demo) reset(); go(1); }} onSample={sample} />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  STEP {String(step + 1).padStart(2, "0")} / {STEPS[step]}
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  {demo && step === 5 ? "샘플 편집 결과 미리보기" : step === 2 ? `${TITLES[2]} ${clues.length}개` : TITLES[step]}
                </h1>
                <p>{demo ? "서버 연결 없이 세 유형의 편집 도구와 영역 조절을 체험해 보세요." : SUBTITLES[step]}</p>
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
                demo={demo}
                photos={photos}
                clues={clues}
                textClueCount={clues.filter((c) => c.kind === "text").length}
                busy={!!busy}
                generationAttempts={generationAttempts}
                onGenerationAttempt={(index) => setGenerationAttempts((all) => ({
                  ...all, [index]: (all[index] ?? 0) + 1,
                }))}
                onChange={changeRegion}
                onGenerated={generatedRegion}
                onBusy={(value) => setBusy(value ? "AI가 배경을 생성하고 있어요" : "")}
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
                remaining={verification.remaining}
                riskBefore={verification.before}
                riskAfter={verification.after}
                onMore={() => void moreProtection()}
                onContinue={() => go(5)}
              />
            )}
            {step === 5 && (
              <ResultView
                backLabel={demo ? "편집으로 돌아가기" : undefined}
                photos={outputs}
                text={outputText}
                notice={
                  demo ? "화면 데모 결과예요. AI 탐지와 재검증을 실행하지 않았어요." : skippedEdit
                    ? `보호 편집 없이 넘어왔어요. 찾은 단서 ${clues.length}개가 그대로 있어요. 사진 파일 정보만 지웠어요.`
                    : undefined
                }
                onRestart={reset}
                onBack={() => go(demo ? 3 : skippedEdit ? 2 : 4)}
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
