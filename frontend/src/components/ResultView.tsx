import { useState } from "react";
import type { Finding, JobReport, JobResult } from "../api";
import { actionLabel, sourceLabel, typeLabel } from "../labels";
import type { Submission } from "./InputPanel";

interface Props {
  submission: Submission;
  result: JobResult;
  report: JobReport;
  onRestart: () => void;
}

export default function ResultView({ submission, result, report, onRestart }: Props) {
  const findings = report.findings;
  const count = findings.length;
  const headline = report.risk_detected
    ? `개인정보 단서 ${count}건을 찾아 가렸습니다`
    : submission.kind === "image"
      ? "드러난 개인정보가 없습니다. 사진 파일 정보만 지웠습니다"
      : "드러난 개인정보가 없습니다";

  return (
    <section className="result" aria-label="검사 결과">
      <h2 className="result__headline">{headline}</h2>

      <RiskMeter before={report.risk_before} after={report.risk_after} />

      {submission.kind === "image" ? (
        <div className="compare">
          <figure className="compare__item">
            <figcaption>원본에서 찾은 곳</figcaption>
            <MarkedImage src={submission.previewUrl} findings={findings} />
          </figure>
          <figure className="compare__item">
            <figcaption>보호된 사진</figcaption>
            {result.url ? (
              <img className="compare__image" src={result.url} alt="개인정보를 가린 사진" />
            ) : (
              <p className="compare__missing">결과 사진을 불러오지 못했습니다.</p>
            )}
          </figure>
        </div>
      ) : (
        <div className="compare">
          <figure className="compare__item">
            <figcaption>원래 글</figcaption>
            <p className="compare__text">{submission.text}</p>
          </figure>
          <figure className="compare__item">
            <figcaption>가린 글</figcaption>
            <p className="compare__text">
              <MaskedText text={result.text ?? ""} />
            </p>
          </figure>
        </div>
      )}

      {count > 0 && <FindingList findings={findings} />}

      <div className="result__actions">
        {submission.kind === "image" && result.url && (
          <a className="button button--primary" href={result.url} target="_blank" rel="noreferrer">
            보호된 사진 열기
          </a>
        )}
        {submission.kind === "text" && result.text && <CopyButton text={result.text} />}
        <button type="button" className="button" onClick={onRestart}>
          다른 것 검사하기
        </button>
      </div>
      {submission.kind === "image" && result.expires_in && (
        <p className="result__note">보호된 사진 주소는 {Math.round(result.expires_in / 60)}분 동안만 열립니다.</p>
      )}
    </section>
  );
}

function RiskMeter({ before, after }: { before: number | null; after: number | null }) {
  if (before === null || after === null) return null;
  const pct = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 100);
  return (
    <div className="risk" role="group" aria-label="노출 위험도">
      <div className="risk__row">
        <span className="risk__label">처리 전 위험도</span>
        <span className="risk__bar">
          <span className="risk__fill risk__fill--before" style={{ width: `${pct(before)}%` }} />
        </span>
        <span className="risk__value">{pct(before)}</span>
      </div>
      <div className="risk__row">
        <span className="risk__label">처리 후 위험도</span>
        <span className="risk__bar">
          <span className="risk__fill risk__fill--after" style={{ width: `${pct(after)}%` }} />
        </span>
        <span className="risk__value">{pct(after)}</span>
      </div>
    </div>
  );
}

/** 원본 사진 위에 탐지 영역을 형광펜처럼 표시한다. bbox는 원본 픽셀 좌표라 비율로 바꿔 그린다. */
function MarkedImage({ src, findings }: { src: string; findings: Finding[] }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const boxed = findings
    .map((f, i) => ({ f, n: i + 1 }))
    .filter(({ f }) => Array.isArray(f.bbox) && f.bbox.length === 4);

  return (
    <div className="marked">
      <img
        className="compare__image"
        src={src}
        alt="올린 원본 사진"
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      {size &&
        boxed.map(({ f, n }) => {
          const [x1, y1, x2, y2] = f.bbox!;
          return (
            <span
              key={n}
              className="marked__box"
              style={{
                left: `${(x1 / size.w) * 100}%`,
                top: `${(y1 / size.h) * 100}%`,
                width: `${((x2 - x1) / size.w) * 100}%`,
                height: `${((y2 - y1) / size.h) * 100}%`,
              }}
              aria-hidden="true"
            >
              <span className="marked__tag">{n}</span>
            </span>
          );
        })}
    </div>
  );
}

// 가려진 조각: [이메일] 같은 대괄호 표기, 또는 ***가 들어간 단어
const MASKED = /(\[[^\]\n]{1,20}\]|[^\s]*\*{2,}[^\s]*)/g;

/** 가린 글에서 바뀐 부분을 형광펜으로 표시한다. */
function MaskedText({ text }: { text: string }) {
  const parts = text.split(MASKED);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ol className="findings" aria-label="찾은 개인정보 단서">
      {findings.map((f, i) => (
        <li key={i} className="findings__item">
          <span className="findings__num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="findings__type">{typeLabel(f.type)}</span>
          <span className="findings__meta">
            {[sourceLabel(f.source) && `${sourceLabel(f.source)}에서 찾음`, actionLabel(f.action)]
              .filter(Boolean)
              .join(", ")}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button--primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // HTTP 페이지에서는 클립보드 쓰기가 막힐 수 있다
          window.prompt("아래 글을 복사하세요", text);
        }
      }}
    >
      {copied ? "복사했습니다" : "가린 글 복사하기"}
    </button>
  );
}
