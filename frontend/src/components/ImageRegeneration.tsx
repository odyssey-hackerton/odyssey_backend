import { useEffect, useRef, useState } from "react";
import { getGenerationStatus, regenerateBackgrounds, type Generated } from "../api";
import type { Box } from "../flow";
import Icon from "./Icon";

export default function ImageRegeneration({ prepareImage, boxes, labels, attempts, disabled, demo, onAttempt, onGenerated, onBusy }: {
  prepareImage: () => Promise<Blob>;
  labels: string[];
  boxes: Box[];
  attempts: number;
  disabled: boolean;
  demo: boolean;
  onAttempt: () => void;
  onGenerated: (results: Generated[]) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!demo) void getGenerationStatus()
      .then((status) => { if (!cancelled) setEnabled(status.enabled); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, [demo]);

  async function generate() {
    if (demo || disabled || !enabled || attempts >= 3 || lock.current) return;
    lock.current = true;
    setGenerating(true); onBusy(true); setError("");
    try {
      const input = await prepareImage();
      onAttempt();
      onGenerated(await regenerateBackgrounds(input, boxes));
    } catch (e) {
      setError(e instanceof Error ? e.message : "이미지 생성에 실패했어요.");
    } finally {
      lock.current = false;
      setGenerating(false); onBusy(false);
    }
  }

  return (
    <section className="generation-panel" aria-label="이미지 재생성">
      <div className="generation-head">
        <div>
          <strong>이미지 재생성 · 영역 {boxes.length}개 한 번에</strong>
          <p>AI가 이 사진의 보호 영역{labels.some(Boolean) && ` ${labels.join(", ")}`}의 배경을 한 번에 새로 그려 추천해요.</p>
        </div>
        <button className="button primary" disabled={demo || disabled || !enabled || attempts >= 3 || generating}
          onClick={() => void generate()}>
          {generating ? "생성 중…" : attempts ? "다시 생성" : "이미지 생성"} · {attempts} / 3
        </button>
      </div>
      <p className="generation-note">
        <Icon name="info" size={15} />
        추천은 처음 AI가 보호 처리한 사진으로 만들어요. 직접 바꾼 편집(보호 방법, 영역 크기 등)은 추천에 들어가지 않아요. 지운 영역과 "그대로 두기" 영역은 새로 그리지 않아요.
      </p>
      <small>{demo ? "데모에서는 이미지 재생성을 사용할 수 없어요." : !enabled
        ? "현재 이미지 생성에 연결할 수 없어요."
        : "사진마다 최대 3번 (처음 1번 + 다시 생성 2번) · 실패한 시도도 횟수에 들어가요."}</small>
      {error && <p className="editor-warning" role="alert">{error}</p>}
    </section>
  );
}
