import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { resizeBox, type Box, type Clue } from "../flow";
import { validBox, type Photo } from "../media";

const COLORS = { high: "#f26478", medium: "#efa310", low: "#1688ff" } as const;
export const clueColor = (clue: Clue) => COLORS[clue.risk ?? "low"];
type Point = [number, number];
type Drag = { key: string; box: Box; start: Point; pointerId: number; corner?: number; previousMask?: Box };
type Selection = { key: string; box: Box; cursor: Point; anchor?: Point };

function maskBetween(box: Box, a: Point, b: Point): Box | undefined {
  if (Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1) return;
  const w = box[2] - box[0], h = box[3] - box[1];
  return [(Math.min(a[0], b[0]) - box[0]) / w, (Math.min(a[1], b[1]) - box[1]) / h,
    (Math.max(a[0], b[0]) - box[0]) / w, (Math.max(a[1], b[1]) - box[1]) / h];
}

export default function PhotoView({
  photo, src, clues = [], labelOf, selected, onSelect, showBoxes = true,
  onBoxChange, onDelete, onMaskChange,
}: {
  photo: Photo;
  src?: string;
  clues?: Clue[];
  labelOf: (clue: Clue) => string;
  selected?: string;
  onSelect?: (clue: Clue) => void;
  showBoxes?: boolean;
  onBoxChange?: (key: string, box: Box) => void;
  onDelete?: (key: string) => void;
  onMaskChange?: (key: string, box: Box | undefined) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [keyboard, setKeyboard] = useState<Selection>();
  const dot = Math.max(photo.width, photo.height) / 30;
  function point(e: PointerEvent): Point | undefined {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return [p.x, p.y];
  }
  function start(e: PointerEvent, clue: Clue, box: Box, corner?: number) {
    if (e.button !== 0 || drag.current || (corner == null ? !onMaskChange : !onBoxChange)) return;
    const p = point(e);
    if (!p) return;
    e.preventDefault(); e.stopPropagation(); setKeyboard(undefined);
    drag.current = { key: clue.key, box, start: p, pointerId: e.pointerId, corner, previousMask: clue.maskBox };
    svg.current?.setPointerCapture(e.pointerId);
  }
  function update(e: PointerEvent) {
    const d = drag.current, p = point(e);
    if (!d || !p || d.pointerId !== e.pointerId) return;
    if (d.corner != null) {
      onBoxChange?.(d.key, resizeBox(d.box, p[0] - d.start[0], p[1] - d.start[1], photo.width, photo.height, d.corner));
    } else {
      const clamp = (v: Point): Point => [Math.max(d.box[0], Math.min(d.box[2], v[0])), Math.max(d.box[1], Math.min(d.box[3], v[1]))];
      const mask = maskBetween(d.box, clamp(d.start), clamp(p));
      if (mask) onMaskChange?.(d.key, mask);
    }
  }
  function finish(e?: PointerEvent, cancel = false) {
    const d = drag.current;
    if (!d || (e && d.pointerId !== e.pointerId)) return;
    if (cancel) {
      if (d.corner != null) onBoxChange?.(d.key, d.box);
      else onMaskChange?.(d.key, d.previousMask);
    } else if (e) update(e);
    drag.current = null;
    if (svg.current?.hasPointerCapture(d.pointerId)) svg.current.releasePointerCapture(d.pointerId);
  }
  function selectWithKeyboard(e: KeyboardEvent, clue: Clue, box: Box) {
    if (clue.action !== "partialMask" || !onMaskChange || selected !== clue.key) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(clue); }
      return;
    }
    const draft = keyboard?.key === clue.key && keyboard.box.every((n, i) => n === box[i]) ? keyboard : undefined;
    const step = e.shiftKey ? 10 : 1;
    const directions: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!draft) setKeyboard({ key: clue.key, box, cursor: [box[0], box[1]] });
      else if (!draft.anchor) setKeyboard({ ...draft, anchor: draft.cursor });
      else {
        const mask = maskBetween(box, draft.anchor, draft.cursor);
        if (mask) { onMaskChange(clue.key, mask); setKeyboard(undefined); }
      }
    } else if (draft && directions[e.key]) {
      e.preventDefault();
      const [dx, dy] = directions[e.key];
      setKeyboard({ ...draft, cursor: [Math.max(box[0], Math.min(box[2], draft.cursor[0] + dx)), Math.max(box[1], Math.min(box[3], draft.cursor[1] + dy))] });
    }
  }
  return (
    <svg ref={svg} className="photo-view" viewBox={`0 0 ${photo.width} ${photo.height}`}
      role="group" aria-label="사진과 발견된 단서" onPointerMove={update}
      onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)} onLostPointerCapture={(e) => finish(e, true)}
      onKeyDown={(e) => { if (e.key === "Escape") { finish(undefined, true); setKeyboard(undefined); } }}>
      <image href={src ?? photo.url} width={photo.width} height={photo.height} />
      {showBoxes && clues.filter((c) => !c.deleted).map((clue) => {
        const box = validBox(clue.bbox, photo.width, photo.height);
        if (!box) return null;
        const [x, y, x2, y2] = box;
        const color = clueColor(clue), active = selected === clue.key, label = labelOf(clue);
        const masking = active && clue.action === "partialMask" && !!onMaskChange;
        const corners: Point[] = [[x, y], [x2, y], [x2, y2], [x, y2]];
        return <g key={clue.key}>
          <g role="button" tabIndex={0} aria-label={`${label}. ${clue.title}`} aria-pressed={active}
            aria-describedby={masking ? "partial-mask-keyboard" : undefined}
            onClick={() => { onSelect?.(clue); if (!active) setKeyboard(undefined); }}
            onKeyDown={(e) => selectWithKeyboard(e, clue, box)}
            onPointerDown={(e) => { if (masking) start(e, clue, box); }}
            style={{ cursor: masking ? "crosshair" : onSelect ? "pointer" : "default", touchAction: masking ? "none" : "auto" }}>
            <rect x={x} y={y} width={x2 - x} height={y2 - y} fill={color}
              fillOpacity={active ? 0.12 : 0.06} stroke={color} strokeWidth={dot / (active ? 6 : 9)} rx={dot / 8} />
            <g transform={`translate(${active && onBoxChange ? Math.min(photo.width - dot / 2, x + dot * .8) : x} ${active && onBoxChange ? Math.max(dot / 2, y - dot * .8) : y})`} pointerEvents="none">
              <circle r={dot / 2} fill={color} stroke="white" strokeWidth={dot / 14} />
              <text fill="white" textAnchor="middle" dominantBaseline="central" fontSize={dot * 0.55} fontWeight="700">{label}</text>
            </g>
          </g>
          {active && onBoxChange && corners.map(([cx, cy], corner) => (
            <g key={corner} className="resize-handle" role="button" tabIndex={0}
              aria-label={`${label} 영역 ${["왼쪽 위", "오른쪽 위", "오른쪽 아래", "왼쪽 아래"][corner]} 크기 조절`}
              transform={`translate(${cx} ${cy})`} style={{ cursor: corner % 2 ? "nesw-resize" : "nwse-resize" }}
              onPointerDown={(e) => start(e, clue, box, corner)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 10 : 1;
                const directions: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                if (directions[e.key]) { e.preventDefault(); setKeyboard(undefined); onBoxChange(clue.key, resizeBox(box, ...directions[e.key], photo.width, photo.height, corner)); }
              }}>
              <rect x={-dot * .6} y={-dot * .6} width={dot * 1.2} height={dot * 1.2} fill="transparent" />
              <rect x={-dot * .2} y={-dot * .2} width={dot * .4} height={dot * .4} fill="white" stroke={color} strokeWidth={dot / 12} pointerEvents="none" />
            </g>
          ))}
          {active && onDelete && <g role="button" tabIndex={0} className="delete-box" aria-label={`${label} 영역 삭제`}
            transform={`translate(${Math.min(photo.width - dot * .6, x2 + dot * .8)} ${Math.max(dot * .6, y - dot * .8)})`}
            style={{ cursor: "pointer" }} onClick={() => { setKeyboard(undefined); onDelete(clue.key); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setKeyboard(undefined); onDelete(clue.key); } }}>
            <circle r={dot * .55} fill="white" stroke={color} strokeWidth={dot / 12} />
            <path d={`M ${-dot * .2} ${-dot * .2} L ${dot * .2} ${dot * .2} M ${dot * .2} ${-dot * .2} L ${-dot * .2} ${dot * .2}`}
              stroke={color} strokeWidth={dot / 10} strokeLinecap="round" pointerEvents="none" />
          </g>}
        </g>;
      })}
      {showBoxes && keyboard && keyboard.key === selected && clues.some((c) => c.key === selected && c.action === "partialMask" && !c.deleted) && <g pointerEvents="none" stroke="#1688ff" strokeWidth={dot / 10}>
        {keyboard.anchor && <rect x={Math.min(keyboard.anchor[0], keyboard.cursor[0])} y={Math.min(keyboard.anchor[1], keyboard.cursor[1])}
          width={Math.abs(keyboard.anchor[0] - keyboard.cursor[0])} height={Math.abs(keyboard.anchor[1] - keyboard.cursor[1])} fill="#1688ff" fillOpacity=".2" />}
        <path d={`M ${keyboard.cursor[0] - dot / 2} ${keyboard.cursor[1]} h ${dot} M ${keyboard.cursor[0]} ${keyboard.cursor[1] - dot / 2} v ${dot}`} />
      </g>}
    </svg>
  );
}
