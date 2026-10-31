import { useEffect, useRef, useState } from "react";
import {
  createJob,
  getReport,
  getResult,
  transformJob,
  watchJob,
  type JobReport,
  type JobStatus,
} from "./api";
import {
  demoClues,
  readPhoto,
  renderDemo,
  validateFiles,
  type Clue,
  type EditAction,
  type Photo,
} from "./media";
import { typeLabel } from "./labels";
import Icon, { type IconName } from "./components/Icon";
import InputPanel from "./components/InputPanel";
import PhotoView from "./components/PhotoView";
import ProgressTrack from "./components/ProgressTrack";
import ResultView from "./components/ResultView";

const STEPS = ["홈", "업로드", "분석 결과", "보호 편집", "재검증", "공유"];
const ACTIONS: { value: EditAction; label: string; icon: IconName }[] = [
  { value: "mask", label: "가리기", icon: "eye" },
  { value: "blur", label: "흐리게", icon: "spark" },
  { value: "remove", label: "지우기", icon: "erase" },
  { value: "replace", label: "바꾸기", icon: "refresh" },
];
const messageOf = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "요청을 처리하지 못했어요. 다시 시도해 주세요.";

export default function App() {
  const [demo, setDemo] = useState(true);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(1);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState("");
  const [clues, setClues] = useState<Clue[]>([]);
  const [selected, setSelected] = useState(0);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [replacement, setReplacement] = useState("오늘의 카페");
  const [preview, setPreview] = useState<Photo[] | null>(null);
  const [output, setOutput] = useState<Photo[] | null>(null);
  const [outputText, setOutputText] = useState("");
  const [report, setReport] = useState<JobReport | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus>("QUEUED");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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

  async function loadPhotos(files: File[]): Promise<Photo[]> {
    const settled = await Promise.allSettled(files.map(readPhoto));
    const loaded = settled.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const failure = settled.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") {
      loaded.forEach((p) => URL.revokeObjectURL(p.url));
      throw failure.reason;
    }
    loaded.forEach((p) => objectUrls.current.add(p.url));
    return loaded;
  }

  function go(next: number) {
    setStep(next);
    setFurthest((old) => Math.max(old, next));
    setError("");
    setNotice("");
  }
  function invalidate() {
    setPreview(null);
    setOutput(null);
    setReport(null);
    setJobId(null);
    setClues([]);
    setFurthest(1);
  }
  function reset() {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
    invalidate();
    setPhotos([]);
    setText("");
    setOutputText("");
    setPhotoIndex(0);
    setSelected(0);
    go(0);
  }

  async function addFiles(files: File[]) {
    if (!files.length || busy) return;
    const issue = validateFiles(files, photos.length, demo ? 4 : 1);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy("사진을 준비하고 있어요");
    setError("");
    try {
      const added = await loadPhotos(files);
      setPhotos((p) => [...p, ...added]);
      invalidate();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy("");
    }
  }

  async function sample() {
    if (busy) return;
    setBusy("예시 사진을 준비하고 있어요");
    setError("");
    try {
      const response = await fetch("/cafe.jpg");
      if (!response.ok) throw new Error("예시 사진을 불러오지 못했어요.");
      const file = new File([await response.blob()], "cafe-example.jpg", {
        type: "image/jpeg",
      });
      const loaded = await loadPhotos([file]);
      invalidate();
      setDemo(true);
      setPhotos(loaded);
      setPhotoIndex(0);
      setText("좋은 날, 카페에서 ☕ 나만의 작은 휴식.");
      go(1);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy("");
    }
  }

  async function analyze() {
    if (busy) return;
    if (!photos.length && !text.trim()) return;
    invalidate();
    setSelected(0);
    setPhotoIndex(0);
    setError("");
    if (demo) {
      setClues(demoClues(photos));
      go(2);
      return;
    }
    setBusy("analyzing");
    setStatus("QUEUED");
    try {
      const job = await createJob({
        file: photos[0]?.file,
        text: text.trim() || undefined,
      });
      setJobId(job.job_id);
    } catch (e) {
      setBusy("");
      setError(messageOf(e));
    }
  }

  const watching = busy === "analyzing" || busy === "transforming";
  useEffect(() => {
    if (!jobId || !watching) return;
    let cancelled = false,
      finished = false;
    const stop = watchJob(jobId, async (state) => {
      if (cancelled || finished) return;
      setStatus(state.status);
      if (!["AWAITING_USER", "DONE", "FAILED"].includes(state.status)) return;
      finished = true;
      try {
        if (state.status === "FAILED")
          throw new Error(state.error ?? "작업이 실패했어요.");
        const nextReport = await getReport(jobId);
        if (cancelled) return;
        setReport(nextReport);
        if (state.status === "AWAITING_USER") {
          setClues(
            nextReport.findings.map((f, idx) => ({
              ...f,
              idx,
              imageIndex: 0,
              title: typeof f.title === "string" ? f.title : typeLabel(f.type),
              risk: f.risk_level === "high" || f.risk_level === "medium" || f.risk_level === "low" ? f.risk_level : undefined,
              description:
                typeof f.description === "string"
                  ? f.description
                  : "분석된 단서의 위치와 처리 방법을 확인해 주세요.",
              action: ["blur", "mask", "remove", "skip"].includes(
                f.action ?? "",
              )
                ? (f.action as EditAction)
                : "mask",
            })),
          );
          go(2);
        } else {
          const result = await getResult(jobId);
          const files: File[] = [];
          if (result.url) {
            const response = await fetch(result.url);
            if (!response.ok)
              throw new Error(
                "결과 사진을 가져오지 못했어요. URL 만료 또는 S3 접근 설정을 확인해 주세요.",
              );
            const blob = await response.blob();
            if (!blob.type.startsWith("image/"))
              throw new Error("서버가 이미지 파일을 반환하지 않았어요.");
            files.push(
              new File(
                [blob],
                `odyssey-result.${blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg"}`,
                { type: blob.type },
              ),
            );
          } else if (state.input_type !== "text")
            throw new Error(
              "처리된 사진이 없어요. 원본을 공유하지 않도록 작업을 중단했어요.",
            );
          const loaded = await loadPhotos(files);
          if (cancelled) return;
          setOutput(loaded);
          setOutputText(result.text ?? "");
          go(4);
        }
      } catch (e) {
        if (!cancelled) setError(messageOf(e));
      } finally {
        if (!cancelled) setBusy("");
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId, watching]);

  function chooseAction(action: EditAction) {
    if (busy) return;
    setClues((items) =>
      items.map((c, i) => (i === selected ? { ...c, action } : c)),
    );
    setPreview(null);
    setOutput(null);
    setFurthest(3);
  }

  async function makePreview() {
    if (busy) return;
    setBusy("미리보기를 만들고 있어요");
    setError("");
    try {
      setPreview(
        await loadPhotos(await renderDemo(photos, clues, replacement)),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy("");
    }
  }

  async function apply() {
    if (busy) return;
    if (demo) {
      if (preview === null) return;
      setOutput(preview);
      setOutputText(text);
      go(4);
    } else if (jobId) {
      setBusy("변환 요청을 보내고 있어요");
      setStatus("QUEUED");
      setError("");
      try {
        await transformJob(
          jobId,
          clues.map((c) => ({ idx: c.idx, action: c.action })),
          photos[0]?.file,
        );
        setBusy("transforming");
      } catch (e) {
        setBusy("");
        setError(messageOf(e));
      }
    }
  }

  const currentPhoto = photos[photoIndex];
  const chosen = clues[selected];
  const remaining = demo
    ? clues.filter((c) => c.action === "skip").length
    : (report?.findings.length ?? 0);
  const title = [
    "",
    "소중한 순간, 안심하고 올리세요",
    `보호가 필요한 단서 ${clues.length}개`,
    "필요한 부분만, 원하는 방식으로",
    "보호 효과를 확인해 보세요",
    "마지막 확인, 그리고 공유",
  ][step];

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <button
            className="brand"
            disabled={!!busy}
            onClick={() => go(0)}
            aria-label="Odyssey 홈"
          >
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
            <div className="mode-switch" aria-label="테스트 모드">
              {[true, false].map((value) => (
                <button
                  key={String(value)}
                  disabled={!!busy}
                  aria-pressed={demo === value}
                  onClick={() => {
                    if (demo !== value) {
                      reset();
                      setDemo(value);
                    }
                  }}
                >
                  {value ? "화면 데모" : "실제 API"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>
      <main className="page" aria-busy={!!busy}>
        {!demo && (
          <div className="alert" role="note">
            <Icon name="info" />
            <span>무료 AI 연결 테스트는 가짜 개인정보로 만든 자료만 사용해 주세요. 사진과 본문이 외부 AI로 전송돼요.</span>
          </div>
        )}
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
                {index < step ? (
                  <Icon name="check" size={15} />
                ) : (
                  String(index + 1).padStart(2, "0")
                )}
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
            {!demo && status === "DONE" && jobId && !output && !busy && (
              <button
                className="text-button"
                onClick={() => setBusy("transforming")}
              >
                결과 다시 불러오기
              </button>
            )}
            <button
              className="icon-button"
              aria-label="오류 알림 닫기"
              onClick={() => setError("")}
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        )}
        {notice && (
          <div className="alert" role="status">
            <Icon name="info" />
            <span>{notice}</span>
          </div>
        )}
        {step === 0 ? (
          <>
            <section className="home-hero">
              <div className="hero-copy">
                <span className="eyebrow">
                  <span className="tiny-line" />
                  SHARE THE MOMENT, KEEP YOUR PRIVACY
                </span>
                <h1>
                  소중한 순간은 그대로.
                  <br />내 정보는 <span>안전하게.</span>
                </h1>
                <p>
                  사진 한 장에 담긴 나도 모르는 개인정보.
                  <br />
                  올리기 전에 점검하고, 필요한 부분만 편집하세요.
                </p>
                <div className="hero-actions">
                  <button
                    className="button primary"
                    disabled={!!busy}
                    onClick={() => go(1)}
                  >
                    새 게시물 보호하기
                    <Icon name="arrow" size={19} />
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={sample}
                  >
                    예시로 먼저 둘러보기
                    <Icon name="chevron" size={16} />
                  </button>
                </div>
                <div className="hero-promise">
                  <Icon name="shield" size={17} />
                  <span>
                    사진과 글을 함께 · 원하는 부분만 편집 · 간편한 공유
                  </span>
                </div>
              </div>
              <div className="hero-visual">
                <div className="photo-backdrop" />
                <div className="hero-photo">
                  <img
                    src="/cafe.jpg"
                    alt="일상의 순간을 담은 초록빛 카페 사진"
                  />
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
              <button
                className="card option-card"
                disabled={!!busy}
                onClick={() => go(1)}
              >
                <span className="icon-tile">
                  <Icon name="image" size={25} />
                </span>
                <div>
                  <h2>새 게시물 보호</h2>
                  <p>지금 올릴 사진과 글을 함께 점검해요.</p>
                </div>
                <Icon name="arrow" />
              </button>
              <button
                className="card option-card"
                disabled={!!busy}
                onClick={() => {
                  go(1);
                  setNotice(
                    "예전에 올린 사진을 다시 선택해 주세요. 이전 게시물을 자동으로 불러오지는 않아요.",
                  );
                }}
              >
                <span className="icon-tile mint">
                  <Icon name="clock" size={25} />
                </span>
                <div>
                  <h2>이전 게시물 점검</h2>
                  <p>이미 올린 사진에도 놓친 정보가 있을까요?</p>
                </div>
                <Icon name="arrow" />
              </button>
            </div>
            <section className="how-it-works">
              <div>
                <span className="eyebrow">작은 확인이 만드는 안심</span>
                <h2>세 번의 확인으로, 더 편안한 공유</h2>
              </div>
              <div className="how-grid">
                {[
                  {
                    icon: "search" as const,
                    title: "숨어 있는 단서 찾기",
                    text: "간판, 주소, 반사된 배경까지 살펴봐요.",
                  },
                  {
                    icon: "edit" as const,
                    title: "필요한 만큼 보호하기",
                    text: "사진의 분위기는 살리고, 정보만 편집해요.",
                  },
                  {
                    icon: "upload" as const,
                    title: "다시 확인하고 공유하기",
                    text: "남은 단서를 확인하고 사진과 글을 넘겨요.",
                  },
                ].map((item, i) => (
                  <div className="how-item" key={item.title}>
                    <span className="how-number">0{i + 1}</span>
                    <Icon name={item.icon} size={22} />
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  STEP {String(step + 1).padStart(2, "0")} / {STEPS[step]}
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  {title}
                </h1>
                <p>
                  {step === 1
                    ? "사진에 나도 모르게 담긴 개인정보, 함께 살펴볼게요."
                    : demo
                      ? "예시 데이터를 사용하는 화면 데모입니다. 실제 AI 분석·보호 결과가 아니에요."
                      : "분석 결과를 확인하고, 원하는 처리 방법을 선택해 주세요."}
                </p>
              </div>
              <span className={`mode-badge ${demo ? "" : "live"}`}>
                <span />
                {demo ? "화면 데모" : "실제 API"}
              </span>
            </div>
            {step === 1 && (
              <InputPanel
                photos={photos}
                text={text}
                demo={demo}
                busy={!!busy}
                onFiles={addFiles}
                onRemove={(index) => {
                  setPhotos((p) => p.filter((_, i) => i !== index));
                  setPhotoIndex(0);
                  invalidate();
                }}
                onText={(value) => {
                  setText(value);
                  invalidate();
                }}
                onSample={sample}
                onSubmit={analyze}
              />
            )}
            {(step === 2 || step === 3) && (
              <div className="workspace-grid">
                <section className="card image-workspace">
                  <div className="image-toolbar">
                    <span>
                      <Icon name="image" size={16} />
                      {photos.length
                        ? `사진 ${photoIndex + 1} / ${photos.length}`
                        : "본문"}
                    </span>
                    <span>
                      {step === 3
                        ? "선택한 영역만 편집해요"
                        : "번호를 눌러 단서를 확인하세요"}
                    </span>
                  </div>
                  <div className="image-stage">
                    {currentPhoto ? (
                      <PhotoView
                        photo={currentPhoto}
                        clues={clues.filter((c) => c.imageIndex === photoIndex)}
                        selected={chosen?.idx}
                        onSelect={(clue) => setSelected(clues.indexOf(clue))}
                      />
                    ) : (
                      <p className="text-preview">{text}</p>
                    )}
                    {currentPhoto && (
                      <button
                        className="zoom-button"
                        aria-label="원본 사진 확대"
                        onClick={() => setZoom(currentPhoto.url)}
                      >
                        <Icon name="search" />
                      </button>
                    )}
                  </div>
                  {photos.length > 1 && (
                    <div className="filmstrip">
                      {photos.map((p, i) => (
                        <button
                          key={p.url}
                          className={i === photoIndex ? "active" : ""}
                          aria-label={`사진 ${i + 1} 보기`}
                          aria-pressed={i === photoIndex}
                          onClick={() => {
                            setPhotoIndex(i);
                            setSelected(
                              clues.findIndex((c) => c.imageIndex === i),
                            );
                          }}
                        >
                          <img src={p.url} alt="" />
                          <span>{i + 1}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="image-footnote">
                    <Icon name="info" size={16} />
                    {demo
                      ? "표시된 영역은 UI 확인을 위한 고정 예시예요."
                      : "위험 단서는 원본 사진의 좌표에 표시돼요."}
                  </div>
                </section>
                <aside className="card controls-card">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">
                        {step === 2 ? "분석 리포트" : "보호 편집"}
                      </span>
                      <h2>
                        {step === 2
                          ? "이 부분을 확인해 주세요"
                          : "어떻게 보호할까요?"}
                      </h2>
                    </div>
                    <span className="count-badge">{clues.length}</span>
                  </div>
                  <div className="clue-list">
                    {clues
                      .filter((c) => c.imageIndex === photoIndex)
                      .map((clue) => (
                        <button
                          key={clue.idx}
                          className={`clue-card ${chosen === clue ? "selected" : ""}`}
                          onClick={() => setSelected(clues.indexOf(clue))}
                          disabled={!!busy}
                          aria-pressed={chosen === clue}
                        >
                          <span
                            className={`clue-number ${clue.risk === "high" ? "pink" : clue.idx === 2 ? "amber" : ""}`}
                          >
                            {clue.idx + 1}
                          </span>
                          <span className="clue-copy">
                            <span className="clue-title">
                              {clue.title}
                              {clue.risk && (
                                <span className={`risk-tag ${clue.risk}`}>
                                  {clue.risk === "high"
                                    ? "높은 위험"
                                    : clue.risk === "low" ? "낮은 위험" : "중간 위험"}
                                </span>
                              )}
                            </span>
                            <span className="clue-description">
                              {clue.description}
                            </span>
                          </span>
                          <Icon name="chevron" size={14} />
                        </button>
                      ))}
                  </div>
                  {!clues.length && (
                    <div className="empty-state">
                      <Icon name="shield" size={32} />
                      <h3>
                        {demo
                          ? "본문 흐름을 확인해 보세요"
                          : "반환된 탐지 항목이 없어요"}
                      </h3>
                      <p>
                        {demo
                          ? "화면 데모는 본문을 분석하거나 자동으로 가리지 않아요. 실제 분석은 API 모드에서 확인해 주세요."
                          : "단서가 없다는 결과가 모든 개인정보의 안전을 보장하지는 않아요."}
                      </p>
                    </div>
                  )}
                  {step === 2 ? (
                    <div className="control-footer">
                      <div className="tip">
                        <Icon name="shield" size={20} />
                        <p>
                          내가 선택한 부분만 편집하고,
                          <br />
                          나머지 순간은 그대로 남겨요.
                        </p>
                      </div>
                      <button
                        className="button primary full"
                        disabled={!!busy}
                        onClick={() => go(3)}
                      >
                        추천 보호안 보기
                        <Icon name="arrow" />
                      </button>
                      <button
                        className="button ghost full"
                        onClick={() =>
                          setNotice(
                            "심층 분석은 아직 연결되지 않았어요. 현재 표시된 리포트로 보호 편집을 진행할 수 있어요.",
                          )
                        }
                      >
                        <Icon name="spark" size={17} />
                        심층 분석 안내
                      </button>
                    </div>
                  ) : (
                    <>
                      {chosen && (
                        <div className="editor">
                          <label className="field-label">
                            {chosen.title} 처리 방법
                          </label>
                          <div className="edit-actions">
                            {ACTIONS.map((action) => (
                              <button
                                key={action.value}
                                disabled={
                                  !!busy ||
                                  (!demo && action.value === "replace")
                                }
                                aria-pressed={chosen.action === action.value}
                                onClick={() => chooseAction(action.value)}
                              >
                                <Icon name={action.icon} size={23} />
                                <span>{action.label}</span>
                              </button>
                            ))}
                          </div>
                          <label className="skip-option">
                            <input
                              type="checkbox"
                              checked={chosen.action === "skip"}
                              disabled={!!busy}
                              onChange={(e) =>
                                chooseAction(e.target.checked ? "skip" : "mask")
                              }
                            />
                            이 단서는 그대로 두기
                          </label>
                          {chosen.action === "replace" && (
                            <div className="replacement-field">
                              <label
                                className="field-label"
                                htmlFor="replacement"
                              >
                                대신 표시할 문구 <span>(비우면 글자 없이)</span>
                              </label>
                              <input
                                id="replacement"
                                disabled={!!busy}
                                value={replacement}
                                maxLength={20}
                                onChange={(e) => {
                                  setReplacement(e.target.value);
                                  setPreview(null);
                                  setOutput(null);
                                  setFurthest(3);
                                }}
                              />
                              <small>{replacement.length} / 20</small>
                            </div>
                          )}
                          <p className="editor-note">
                            {demo
                              ? "지우기·바꾸기는 단색 합성 예시입니다. 자연스러운 생성 편집은 추후 연결해요."
                              : "사진 지우기는 단색 가림으로 처리해요. 본문은 해당 글자를 삭제하며, 사진 메타데이터는 편집 시 제거해요."}
                          </p>
                        </div>
                      )}
                      <div className="control-footer">
                        {demo && (
                          <button
                            className="button secondary full"
                            disabled={!!busy}
                            onClick={makePreview}
                          >
                            <Icon name="search" size={18} />
                            {preview
                              ? "미리보기 다시 만들기"
                              : "미리보기 만들기"}
                          </button>
                        )}
                        <button
                          className="button primary full"
                          disabled={
                            !!busy ||
                            (demo && preview === null) ||
                            (!demo && status === "DONE")
                          }
                          onClick={apply}
                        >
                          {demo ? "적용하고 재검증" : "변환하고 재검증"}
                          <Icon name="arrow" />
                        </button>
                      </div>
                    </>
                  )}
                </aside>
                {step === 3 && preview !== null && (
                  <section className="card preview-card">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">아직 적용 전</span>
                        <h2>이 결과를 적용할까요?</h2>
                      </div>
                      <span className="mode-badge">미리보기</span>
                    </div>
                    <div className="compare-grid">
                      {currentPhoto && preview[photoIndex] ? (
                        <>
                          <figure>
                            <img src={currentPhoto.url} alt="원본 사진" />
                            <figcaption>원본</figcaption>
                          </figure>
                          <figure>
                            <img
                              src={preview[photoIndex].url}
                              alt="편집 미리보기"
                            />
                            <figcaption>변경 결과 · 적용 전</figcaption>
                          </figure>
                        </>
                      ) : (
                        <p className="text-preview">
                          {text || "공유할 본문이 없어요."}
                        </p>
                      )}
                    </div>
                    <p className="editor-note">
                      설정을 바꾸고 미리보기를 다시 만들 수 있어요. 본문은
                      데모에서 변경되지 않아요.
                    </p>
                  </section>
                )}
              </div>
            )}
            {step === 4 && output !== null && (
              <section className="card verification-card">
                <div className="section-heading">
                  <span className="icon-tile mint">
                    <Icon name="shield" size={25} />
                  </span>
                  <div>
                    <h2>
                      {demo
                        ? "편집 결과를 확인했어요"
                        : "처리 결과가 도착했어요"}
                    </h2>
                    <p>
                      {demo
                        ? "실제 재검증 대신 선택한 편집의 적용 상태를 보여줘요."
                        : "재검증 리포트와 실제 결과를 함께 확인해 주세요."}
                    </p>
                  </div>
                </div>
                <div className="compare-grid">
                  {photos[photoIndex] && output[photoIndex] ? (
                    <>
                      <figure>
                        <img src={photos[photoIndex].url} alt="편집 전" />
                        <figcaption>편집 전</figcaption>
                      </figure>
                      <figure>
                        <img src={output[photoIndex].url} alt="편집 후" />
                        <figcaption>편집 후</figcaption>
                      </figure>
                    </>
                  ) : (
                    <>
                      <figure>
                        <p className="text-preview">{text}</p>
                        <figcaption>원래 글</figcaption>
                      </figure>
                      <figure>
                        <p className="text-preview">{outputText}</p>
                        <figcaption>결과 글</figcaption>
                      </figure>
                    </>
                  )}
                </div>
                {photos.length > 1 && (
                  <div className="photo-selector">
                    {photos.map((_, i) => (
                      <button
                        className={`button ${photoIndex === i ? "secondary" : "ghost"}`}
                        key={i}
                        onClick={() => setPhotoIndex(i)}
                      >
                        사진 {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                <div className="verification-list">
                  {demo ? (
                    clues.map((c) => (
                      <div
                        className="verification-row"
                        key={`${c.imageIndex}-${c.idx}`}
                      >
                        <span
                          className={`status-dot ${c.action === "skip" ? "warning" : ""}`}
                        >
                          <Icon
                            name={c.action === "skip" ? "info" : "check"}
                            size={16}
                          />
                        </span>
                        <div>
                          <strong>
                            {photos.length > 1
                              ? `사진 ${c.imageIndex + 1} · `
                              : ""}
                            {c.title}{" "}
                            {c.action === "skip" ? "유지" : "편집 적용"}
                          </strong>
                          <p>
                            {c.action === "skip"
                              ? "선택한 영역은 원본 그대로 남아 있어요."
                              : "예시 영역에 선택한 처리 방법을 적용했어요."}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <>
                      <div className="verification-row">
                        <Icon name="info" />
                        <div>
                          <strong>재검증에서 반환된 단서 {remaining}개</strong>
                          <p>
                            {report?.risk_after != null
                              ? `처리 후 위험도: ${Math.round(report.risk_after * 100)} / 100`
                              : "위험도 점수가 제공되지 않았어요."}
                          </p>
                        </div>
                      </div>
                      {report?.findings.map((f, i) => (
                        <div className="verification-row" key={i}>
                          <span className="status-dot warning">
                            <Icon name="info" size={16} />
                          </span>
                          <div><strong>{typeof f.title === "string" ? f.title : typeLabel(f.type)}</strong><p>{typeof f.description === "string" ? f.description : "남아 있는 단서를 확인해 주세요."}</p></div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <div className="residual-note">
                  <Icon name="info" size={19} />
                  <p>
                    {demo
                      ? "이 결과는 UI 테스트용이에요. 실제 공유 전에는 사진과 본문의 개인정보를 직접 확인해 주세요."
                      : "자동 분석에서 찾지 못한 정보가 남아 있을 수 있어요. 공유 전에 결과 사진과 글을 직접 확인해 주세요."}
                  </p>
                </div>
                <div className="bottom-actions">
                  <button
                    className="button secondary"
                    onClick={() => {
                      if (demo) {
                        go(3);
                        setPreview(null);
                      } else
                        setNotice(
                          "현재 API는 완료 후 추가 편집을 지원하지 않아요. 새 작업에서 결과 사진을 다시 업로드해 주세요.",
                        );
                    }}
                  >
                    추가 보호
                    <Icon name="edit" size={17} />
                  </button>
                  <button className="button primary" onClick={() => go(5)}>
                    잔여 위험 확인 후 계속
                    <Icon name="arrow" />
                  </button>
                </div>
              </section>
            )}
            {step === 5 && output !== null && (
              <ResultView
                photos={output}
                text={outputText}
                demo={demo}
                onRestart={reset}
                onBack={() => go(4)}
              />
            )}
          </>
        )}
        {!!busy && (
          <div className="busy-panel" role="status" aria-live="polite">
            {watching ? (
              <ProgressTrack status={status} />
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
      {zoom && <PhotoDialog url={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

function PhotoDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="photo-dialog"
      onClose={onClose}
      aria-label="확대한 사진"
    >
      <button
        className="icon-button"
        autoFocus
        aria-label="확대 닫기"
        onClick={() => dialog.current?.close()}
      >
        <Icon name="close" />
      </button>
      <img src={url} alt="확대한 원본 사진" />
    </dialog>
  );
}
