import type { Clue, Photo } from "../media";
import { validBox } from "../media";

export default function PhotoView({
  photo,
  clues = [],
  selected = -1,
  onSelect,
}: {
  photo: Photo;
  clues?: Clue[];
  selected?: number;
  onSelect?: (clue: Clue) => void;
}) {
  const dot = photo.width / 32;
  return (
    <svg
      className="photo-view"
      viewBox={`0 0 ${photo.width} ${photo.height}`}
      role="group"
      aria-label="사진과 발견된 단서"
    >
      <image href={photo.url} width={photo.width} height={photo.height} />
      {clues.map((clue) => {
        const box = validBox(clue.bbox, photo.width, photo.height);
        if (!box) return null;
        const [x, y, x2, y2] = box;
        const color =
          clue.risk === "high"
            ? "#f26478"
            : clue.idx === 2
              ? "#efa310"
              : "#1688ff";
        return (
          <g
            key={clue.idx}
            role="button"
            tabIndex={0}
            aria-label={`${clue.idx + 1}. ${clue.title}`}
            aria-pressed={selected === clue.idx}
            onClick={() => onSelect?.(clue)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.(clue);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={x}
              y={y}
              width={x2 - x}
              height={y2 - y}
              fill={color}
              fillOpacity={selected === clue.idx ? 0.25 : 0.1}
              stroke={color}
              strokeWidth={photo.width / 230}
            />
            <circle
              cx={x}
              cy={y}
              r={dot / 2}
              fill={color}
              stroke="white"
              strokeWidth={photo.width / 450}
            />
            <text
              x={x}
              y={y}
              fill="white"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={dot * 0.58}
              fontWeight="700"
            >
              {clue.idx + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
