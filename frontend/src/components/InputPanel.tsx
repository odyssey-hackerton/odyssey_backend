import { useRef, useState } from "react";
import type { Photo } from "../media";
import Icon from "./Icon";

interface Props {
  photos: Photo[];
  text: string;
  demo: boolean;
  busy: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (index: number) => void;
  onText: (text: string) => void;
  onSample: () => void;
  onSubmit: () => void;
}

export default function InputPanel({
  photos,
  text,
  demo,
  busy,
  onFiles,
  onRemove,
  onText,
  onSample,
  onSubmit,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div className="upload-layout">
      <section className="card upload-card">
        <div className="section-heading">
          <span className="icon-tile">
            <Icon name="image" />
          </span>
          <div>
            <h2>사진을 추가해 주세요</h2>
            <p>사진과 함께 올릴 글을 한 번에 확인해요.</p>
          </div>
        </div>
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple={demo}
          aria-label="사진 파일 선택"
          disabled={busy}
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          className={`dropzone ${dragging ? "dragging" : ""}`}
          disabled={busy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) onFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <span className="upload-symbol">
            <Icon name="upload" size={30} />
          </span>
          <strong>
            사진을 끌어다 놓거나 <span>파일 선택</span>
          </strong>
          <small>JPG, PNG, WebP · 한 장당 10MB · 최대 {demo ? 4 : 1}장</small>
        </button>
        {photos.length > 0 && (
          <div className="upload-thumbs">
            {photos.map((photo, i) => (
              <div className="upload-thumb" key={photo.url}>
                <img src={photo.url} alt={`선택한 사진 ${i + 1}`} />
                <span>{String(i + 1).padStart(2, "0")}</span>
                <button
                  className="remove-photo"
                  aria-label={`사진 ${i + 1} 삭제`}
                  disabled={busy}
                  onClick={() => onRemove(i)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
            {photos.length < (demo ? 4 : 1) && (
              <button
                className="add-photo"
                aria-label="사진 추가"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <Icon name="plus" />
              </button>
            )}
          </div>
        )}
        <label className="field-label" htmlFor="post-text">
          함께 올릴 글 <span>(선택)</span>
        </label>
        <div className="textarea-wrap">
          <textarea
            id="post-text"
            placeholder="오늘의 순간을 기록해 보세요. 사진 없이 글만 확인할 수도 있어요."
            rows={4}
            maxLength={5000}
            value={text}
            disabled={busy}
            onChange={(e) => onText(e.target.value)}
          />
          <small>{text.length.toLocaleString()} / 5,000</small>
        </div>
        <button
          className="button primary full"
          disabled={busy || (!photos.length && !text.trim())}
          onClick={onSubmit}
        >
          <Icon name="search" />
          노출 단서 찾기
          <Icon name="arrow" />
        </button>
      </section>
      <aside className="upload-aside">
        <div className="card sample-card">
          <span className="eyebrow">먼저 경험해 보세요</span>
          <h3>사진이 없어도 괜찮아요.</h3>
          <p>
            준비된 카페 사진으로
            <br />
            보호 편집 흐름을 확인해 보세요.
          </p>
          <img src="/cafe.jpg" alt="나무와 화분이 있는 카페의 외관" />
          <button
            className="button secondary full"
            disabled={busy}
            onClick={onSample}
          >
            데모 예시 사진 사용하기
            <Icon name="arrow" size={16} />
          </button>
        </div>
        <div className="privacy-note">
          <Icon name="lock" size={18} />
          <p>
            {demo
              ? "화면 데모에서는 사진과 글을 서버에 보내지 않아요. 새로고침하면 작업이 사라져요."
              : "분석 후 서버 원본을 삭제하고, 편집할 때 이 화면의 사진을 다시 전송해요. 새로고침하면 사진을 다시 선택해야 해요."}
          </p>
        </div>
      </aside>
    </div>
  );
}
