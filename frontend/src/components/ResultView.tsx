import { useState } from "react";
import type { Photo } from "../media";
import Icon from "./Icon";

export default function ResultView({
  photos,
  text,
  demo,
  notice,
  onRestart,
  onBack,
}: {
  photos: Photo[];
  text: string;
  demo: boolean;
  notice?: string;
  onRestart: () => void;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [sharing, setSharing] = useState(false);
  const files = photos.map((p) => p.file);
  async function share() {
    const data: ShareData = {
      ...(text ? { text } : {}),
      ...(files.length ? { files } : {}),
    };
    if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
      setMessage(
        "이 환경에서는 파일 공유를 지원하지 않아요. 사진을 다운로드하고 본문을 복사하거나, HTTPS로 연결한 iPhone Safari에서 시도해 주세요.",
      );
      return;
    }
    setSharing(true);
    try {
      await navigator.share(data);
      setMessage(
        "공유 대상에 전달했어요. X 글쓰기 화면에서 사진과 본문을 확인해 주세요.",
      );
    } catch (e) {
      setMessage(
        e instanceof DOMException && e.name === "AbortError"
          ? "공유를 취소했어요. 결과는 그대로 남아 있어요."
          : "공유하지 못했어요. 다운로드 후 다시 시도해 주세요.",
      );
    } finally {
      setSharing(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("본문을 복사했어요.");
    } catch {
      setMessage("복사 권한이 없어요. 아래 본문을 직접 선택해 복사해 주세요.");
    }
  }
  return (
    <section className="card share-card">
      <div className="success-symbol">
        <Icon name="check" size={29} />
      </div>
      <span className="eyebrow">READY TO SHARE</span>
      <h2>{demo ? "공유 흐름을 확인해 보세요" : "게시할 준비가 됐어요"}</h2>
      <p>
        {demo
          ? "예시 편집 결과입니다. 실제 개인정보 보호 결과가 아니에요."
          : "결과를 한 번 더 살펴보고, 원하는 곳에 공유하세요."}
      </p>
      {notice && (
        <div className="alert warning" role="note">
          <Icon name="info" />
          <span>{notice}</span>
        </div>
      )}
      {photos[index] && (
        <img
          className="share-photo"
          src={photos[index].url}
          alt={`공유할 결과 사진 ${index + 1}`}
        />
      )}
      {photos.length > 1 && (
        <div className="photo-dots">
          {photos.map((_, i) => (
            <button
              key={i}
              className={index === i ? "active" : ""}
              aria-label={`결과 사진 ${i + 1}`}
              aria-pressed={index === i}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
      {text && <p className="shared-text">{text}</p>}
      <div className="share-actions">
        <button
          className="button primary"
          onClick={share}
          disabled={sharing || (!files.length && !text)}
        >
          <Icon name="upload" />
          공유하기
        </button>
        {photos[index] && (
          <a
            className="button secondary"
            href={photos[index].url}
            download={photos[index].file.name}
          >
            <Icon name="download" />
            {photos.length > 1 ? `${index + 1}번 사진 저장` : "다운로드"}
          </a>
        )}
        <button className="button secondary" disabled={!text} onClick={copy}>
          <Icon name="copy" />
          본문 복사
        </button>
      </div>
      <div className="share-target">
        <span className="x-brand">𝕏</span>
        <div>
          <strong>X에 사진과 글을 함께</strong>
          <small>공유 시트에서 X를 선택해 주세요 · 사진 최대 4장</small>
        </div>
      </div>
      {message && (
        <p className="inline-notice" role="status">
          {message}
        </p>
      )}
      <div className="share-bottom">
        <button className="text-button" onClick={onBack}>
          <Icon name="back" size={16} />
          {notice ? "분석 결과" : "재검증 결과"}
        </button>
        <button className="text-button" onClick={onRestart}>
          새 게시물 보호하기
          <Icon name="plus" size={16} />
        </button>
      </div>
    </section>
  );
}
