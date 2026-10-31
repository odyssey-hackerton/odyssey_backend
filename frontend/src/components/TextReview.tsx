import { useEffect, useRef } from "react";
import { maskText, type Clue } from "../flow";
import { HighlightedText } from "./Analysis";
import Icon from "./Icon";

/**
 * 04에서 적용을 누른 뒤, 글에 단서가 있으면 원래 글과 에이전트가 고친 글을 나란히 보여 준다.
 * 사용자는 글을 직접 고치지 않고 적용할지 말지만 고른다.
 */
export default function TextReview({
  text,
  clues,
  onDecide,
  onCancel,
}: {
  text: string;
  clues: Clue[];
  onDecide: (apply: boolean) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const masked = maskText(text, clues);
  const parts = masked.split("[가림]");

  return (
    <dialog
      ref={dialog}
      className="text-dialog"
      aria-labelledby="text-review-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="text-dialog-head">
        <div>
          <span className="eyebrow">글 확인</span>
          <h2 id="text-review-title">글도 이렇게 고칠까요?</h2>
          <p>
            글에서 단서 {clues.length}개를 찾았어요.{" "}
            {clues.map((c) => c.title).join(", ")} 부분이 문제가 될 수 있어서 이렇게 고치려고
            해요.
          </p>
        </div>
        <button className="icon-button" aria-label="닫고 편집으로 돌아가기" onClick={onCancel}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="text-compare">
        <figure>
          <figcaption>원래 글</figcaption>
          <HighlightedText text={text} clues={clues} compact />
        </figure>
        <Icon name="arrow" size={20} />
        <figure className="after">
          <figcaption>에이전트가 고친 글</figcaption>
          <p className="caption-text">
            {parts.map((p, i) => (
              <span key={i}>
                {p}
                {i < parts.length - 1 && <mark className="masked">[가림]</mark>}
              </span>
            ))}
          </p>
        </figure>
      </div>
      <div className="text-dialog-actions">
        <button className="button secondary" onClick={() => onDecide(false)}>
          원래 글 그대로
        </button>
        <button className="button primary" onClick={() => onDecide(true)}>
          고친 글로 적용
          <Icon name="arrow" />
        </button>
      </div>
    </dialog>
  );
}
