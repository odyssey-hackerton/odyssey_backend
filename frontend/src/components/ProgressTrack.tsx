type Stage = "DETECTING" | "ANALYZING" | "TRANSFORMING" | "VERIFYING";

// 워커 파이프라인 순서 그대로: ① 탐지 → ② 위험 분석 → ③ 보호 처리 → ② 재검증
const STEPS: { status: Stage; label: string; detail: string }[] = [
  { status: "DETECTING", label: "탐지", detail: "글자, 사물, 사진 파일 정보에서 단서를 찾는 중" },
  { status: "ANALYZING", label: "위험 분석", detail: "찾은 단서로 무엇을 알아낼 수 있는지 따지는 중" },
  { status: "TRANSFORMING", label: "보호 처리", detail: "위험한 부분을 흐리게 하거나 가리는 중" },
  { status: "VERIFYING", label: "재검증", detail: "가린 결과에서 다시 찾아지는지 확인하는 중" },
];

export default function ProgressTrack({ status }: { status: string }) {
  const current = STEPS.findIndex((s) => s.status === status);
  const active = current === -1 ? null : STEPS[current];

  return (
    <section className="panel progress" aria-live="polite" aria-label="처리 진행 상황">
      <ol className="steps">
        {STEPS.map((s, i) => {
          const state = current === -1 ? "todo" : i < current ? "done" : i === current ? "now" : "todo";
          return (
            <li key={s.status} className={`steps__item steps__item--${state}`}>
              <span className="steps__dot" aria-hidden="true">
                {i + 1}
              </span>
              <span className="steps__label">{s.label}</span>
              {state === "now" && <span className="visually-hidden">(진행 중)</span>}
            </li>
          );
        })}
      </ol>
      <p className="progress__detail">{active ? active.detail : "검사 순서를 기다리는 중"}</p>
    </section>
  );
}
