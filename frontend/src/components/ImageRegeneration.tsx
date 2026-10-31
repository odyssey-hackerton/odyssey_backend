import { useRef, useState } from "react";
import { regenerateBackground } from "../api";
import type { Box } from "../flow";

export default function ImageRegeneration({
  prepareImage,
  bbox,
  attempts,
  disabled,
  demo,
  onAttempt,
  onGenerated,
  onBusy,
}: {
  prepareImage: () => Promise<Blob>;
  bbox: Box;
  attempts: number;
  disabled: boolean;
  demo: boolean;
  onAttempt: () => void;
  onGenerated: (blob: Blob) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);

  async function generate() {
    if (demo || disabled || attempts >= 3 || lock.current) return;
    lock.current = true;
    setGenerating(true);
    onBusy(true);
    setError("");
    try {
      const input = await prepareImage();
      onAttempt();
      onGenerated(await regenerateBackground(input, bbox));
    } catch (e) {
      setError(e instanceof Error ? e.message : "이미지 생성에 실패했어요.");
    } finally {
      lock.current = false;
      setGenerating(false);
      onBusy(false);
    }
  }

  return (
    <section className="generation-panel" aria-label="이미지 재생성">
      <strong>이미지 재생성</strong>
      <p>보호 처리를 마친 사진으로 선택 영역의 배경을 새로 만들어요.</p>
      <button
        className="button primary"
        disabled={demo || disabled || attempts >= 3 || generating}
        onClick={() => void generate()}
      >
        {generating ? "생성 중…" : attempts ? "다시 생성" : "이미지 생성"} · {attempts} / 3
      </button>
      <small>
        {demo
          ? "데모에서는 이미지 재생성을 사용할 수 없어요."
          : "사진별 최초 1회 + 재생성 2회 · 실패한 호출도 포함돼요."}
      </small>
      {error && <p className="editor-warning" role="alert">{error}</p>}
    </section>
  );
}
