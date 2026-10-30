import { useId, useRef, useState, type DragEvent } from "react";

export type Submission =
  | { kind: "image"; file: File; previewUrl: string }
  | { kind: "text"; text: string };

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CHARS = 5000;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

interface Props {
  busy: boolean;
  onSubmit: (s: Submission) => void;
}

export default function InputPanel({ busy, onSubmit }: Props) {
  const [mode, setMode] = useState<"image" | "text">("image");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textId = useId();
  const errorId = useId();

  function pick(f: File | undefined) {
    if (!f) return;
    if (!ACCEPT.includes(f.type)) return setError("jpg, png, webp 이미지만 올릴 수 있습니다.");
    if (f.size > MAX_BYTES) return setError("10MB 이하 사진만 올릴 수 있습니다.");
    setError(null);
    setFile(f);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  }

  function submit() {
    if (mode === "image") {
      if (!file) return setError("검사할 사진을 먼저 골라 주세요.");
      onSubmit({ kind: "image", file, previewUrl: URL.createObjectURL(file) });
    } else {
      const t = text.trim();
      if (!t) return setError("검사할 글을 입력해 주세요.");
      if (t.length > MAX_CHARS) return setError(`글은 ${MAX_CHARS.toLocaleString()}자까지 검사할 수 있습니다.`);
      onSubmit({ kind: "text", text: t });
    }
  }

  return (
    <section className="panel" aria-label="검사할 내용 올리기">
      <div className="switch" role="tablist" aria-label="검사할 종류">
        {(["image", "text"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className="switch__option"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === "image" ? "사진" : "글"}
          </button>
        ))}
      </div>

      {mode === "image" ? (
        <div
          className={`drop${dragging ? " drop--active" : ""}${file ? " drop--filled" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT.join(",")}
            className="visually-hidden"
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {file ? (
            <>
              <p className="drop__title">{file.name}</p>
              <p className="drop__hint">{(file.size / 1024 / 1024).toFixed(1)}MB</p>
              <button type="button" className="link" onClick={() => inputRef.current?.click()}>
                다른 사진 고르기
              </button>
            </>
          ) : (
            <>
              <p className="drop__title">사진을 여기에 끌어다 놓으세요</p>
              <p className="drop__hint">jpg, png, webp 파일을 10MB까지 올릴 수 있습니다.</p>
              <button type="button" className="button button--quiet" onClick={() => inputRef.current?.click()}>
                사진 고르기
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="field">
          <label htmlFor={textId} className="field__label">
            올릴 글
          </label>
          <textarea
            id={textId}
            rows={7}
            value={text}
            maxLength={MAX_CHARS}
            aria-describedby={error ? errorId : undefined}
            placeholder="예) 내일 3시에 망원동 ○○카페에서 봐요. 늦으면 010-1234-5678로 연락 주세요."
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
          />
          <p className="field__count">
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}자
          </p>
        </div>
      )}

      {error && (
        <p id={errorId} className="field__error" role="alert">
          {error}
        </p>
      )}

      <button type="button" className="button button--primary" disabled={busy} onClick={submit}>
        {busy ? "올리는 중…" : "개인정보 검사하기"}
      </button>
    </section>
  );
}
