import type { Clue } from "../flow";
import type { Photo } from "../media";
import { validBox } from "../media";

const COLORS = { high: "#f26478", medium: "#efa310", low: "#1688ff" } as const;
export const clueColor = (clue: Clue) => COLORS[clue.risk ?? "low"];

/**
 * 사진 위에 단서 영역을 그린다. src 를 주면 그 이미지(편집 미리보기)를 배경으로 쓴다.
 * 좌표는 언제나 원본 사진 픽셀 기준이다.
 */
export default function PhotoView({
  photo,
  src,
  clues = [],
  labelOf,
  selected,
  onSelect,
  showBoxes = true,
}: {
  photo: Photo;
  src?: string;
  clues?: Clue[];
  labelOf: (clue: Clue) => string;
  selected?: string;
  onSelect?: (clue: Clue) => void;
  showBoxes?: boolean;
}) {
  const dot = Math.max(photo.width, photo.height) / 30;
  return (
    <svg
      className="photo-view"
      viewBox={`0 0 ${photo.width} ${photo.height}`}
      role="group"
      aria-label="사진과 발견된 단서"
    >
      <image href={src ?? photo.url} width={photo.width} height={photo.height} />
      {showBoxes &&
        clues.map((clue) => {
          const box = validBox(clue.bbox, photo.width, photo.height);
          if (!box) return null;
          const [x, y, x2, y2] = box;
          const color = clueColor(clue);
          const active = selected === clue.key;
          const label = labelOf(clue);
          return (
            <g
              key={clue.key}
              role="button"
              tabIndex={0}
              aria-label={`${label}. ${clue.title}`}
              aria-pressed={active}
              onClick={() => onSelect?.(clue)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(clue);
                }
              }}
              style={{ cursor: onSelect ? "pointer" : "default" }}
            >
              <rect
                x={x}
                y={y}
                width={x2 - x}
                height={y2 - y}
                fill={color}
                fillOpacity={active ? 0.22 : 0.06}
                stroke={color}
                strokeWidth={dot / (active ? 6 : 9)}
                rx={dot / 8}
              />
              <circle
                cx={x}
                cy={y}
                r={dot / 2}
                fill={color}
                stroke="white"
                strokeWidth={dot / 14}
              />
              <text
                x={x}
                y={y}
                fill="white"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={dot * 0.55}
                fontWeight="700"
              >
                {label}
              </text>
            </g>
          );
        })}
    </svg>
  );
}
