import { useEffect, useState } from "react";
import {
  ApiError,
  createJob,
  getReport,
  getResult,
  watchJob,
  type JobReport,
  type JobResult,
  type JobState,
} from "./api";
import InputPanel, { type Submission } from "./components/InputPanel";
import ProgressTrack from "./components/ProgressTrack";
import ResultView from "./components/ResultView";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; submission: Submission }
  | { kind: "running"; submission: Submission; jobId: string; state: JobState | null }
  | {
      kind: "done";
      submission: Submission;
      state: JobState;
      result: JobResult;
      report: JobReport;
    }
  | { kind: "failed"; submission: Submission | null; message: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function submit(submission: Submission) {
    setPhase({ kind: "uploading", submission });
    try {
      const { job_id } = await createJob(
        submission.kind === "image" ? { file: submission.file } : { text: submission.text },
      );
      setPhase({ kind: "running", submission, jobId: job_id, state: null });
    } catch (e) {
      setPhase({ kind: "failed", submission, message: errorText(e) });
    }
  }

  // 작업이 끝날 때까지 진행 상황을 받고, 끝나면 결과와 리포트를 가져온다.
  const runningJobId = phase.kind === "running" ? phase.jobId : null;
  useEffect(() => {
    if (!runningJobId) return;
    const stop = watchJob(runningJobId, async (state) => {
      setPhase((p) => (p.kind === "running" && p.jobId === runningJobId ? { ...p, state } : p));
      if (state.status === "FAILED") {
        setPhase((p) =>
          p.kind === "running"
            ? { kind: "failed", submission: p.submission, message: state.error ?? "처리 중 오류가 났습니다." }
            : p,
        );
      }
      if (state.status === "DONE") {
        try {
          const [result, report] = await Promise.all([
            getResult(runningJobId),
            getReport(runningJobId),
          ]);
          setPhase((p) =>
            p.kind === "running" && p.jobId === runningJobId
              ? { kind: "done", submission: p.submission, state, result, report }
              : p,
          );
        } catch (e) {
          setPhase((p) =>
            p.kind === "running" ? { kind: "failed", submission: p.submission, message: errorText(e) } : p,
          );
        }
      }
    });
    return stop;
  }, [runningJobId]);

  // 처음으로 돌아갈 때 원본 미리보기용 주소를 정리한다.
  const reset = () => {
    if (phase.kind !== "idle" && phase.submission?.kind === "image") {
      URL.revokeObjectURL(phase.submission.previewUrl);
    }
    setPhase({ kind: "idle" });
  };
  const busy = phase.kind === "uploading" || phase.kind === "running";

  return (
    <div className="page">
      <header className="masthead">
        <p className="brand">Odyssey</p>
        <h1>올리기 전에, 무엇이 드러나는지 먼저 확인하세요</h1>
        <p className="lede">
          사진 속 주소와 번호판, 촬영 위치, 글 속 연락처처럼 나를 찾을 수 있는 단서를 찾아서
          가린 버전을 만듭니다.
        </p>
      </header>

      <main>
        {(phase.kind === "idle" || phase.kind === "uploading") && (
          <InputPanel busy={phase.kind === "uploading"} onSubmit={submit} />
        )}

        {busy && phase.kind === "running" && <ProgressTrack status={phase.state?.status ?? "QUEUED"} />}

        {phase.kind === "done" && (
          <ResultView
            submission={phase.submission}
            result={phase.result}
            report={phase.report}
            onRestart={reset}
          />
        )}

        {phase.kind === "failed" && (
          <section className="notice notice--error" role="alert">
            <h2>검사하지 못했습니다</h2>
            <p>{phase.message}</p>
            <button type="button" className="button" onClick={reset}>
              처음부터 다시 하기
            </button>
          </section>
        )}
      </main>

      <footer className="footnote">
        <p>올린 원본은 처리 후 하루 안에 자동으로 삭제됩니다.</p>
      </footer>
    </div>
  );
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "알 수 없는 오류가 났습니다. 잠시 후 다시 시도하세요.";
}
