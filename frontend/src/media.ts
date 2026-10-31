import type { Finding } from "./api";
import type { Clue } from "./flow";

export const MAX_PHOTOS = 4;
export const MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export type Photo = { file: File; url: string; width: number; height: number };

export function validateFiles(
  files: Pick<File, "type" | "size">[],
  currentCount: number,
  limit = MAX_PHOTOS,
): string | null {
  if (files.length + currentCount > limit)
    return `사진은 최대 ${limit}장까지 추가할 수 있어요.`;
  if (files.some((f) => !IMAGE_TYPES.includes(f.type)))
    return "JPG, PNG, WebP 사진을 선택해 주세요.";
  if (files.some((f) => f.size > MAX_BYTES))
    return "사진 한 장의 크기는 10MB 이하여야 해요.";
  return null;
}

export function imageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("사진을 읽지 못했어요. 파일을 다시 선택해 주세요."));
    img.src = url;
  });
}

export async function readPhoto(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file);
  try {
    const img = await imageElement(url);
    return { file, url, width: img.naturalWidth, height: img.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function validBox(
  bbox: Finding["bbox"],
  width: number,
  height: number,
): [number, number, number, number] | null {
  if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)))
    return null;
  const [x1, y1, x2, y2] = bbox;
  const box: [number, number, number, number] = [
    Math.max(0, x1),
    Math.max(0, y1),
    Math.min(width, x2),
    Math.min(height, y2),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

// shortcut: 데모는 고정된 예시 영역(예시 카페 사진 기준 비율)을 사용한다. 실제 탐지는 API 모드로 확인한다.
const DEMO_REGIONS = [
  {
    type: "landmark",
    title: "간판 · 위치 단서",
    description: "가게 이름과 주변 상권을 통해 위치를 추정할 수 있어요.",
    risk: "medium" as const,
    box: [0.22, 0.355, 0.52, 0.415],
    action: "blur" as const,
  },
  {
    type: "tracking_number",
    title: "송장 · 주소 노출",
    description: "택배 송장에 적힌 정보로 주소가 노출될 수 있어요.",
    risk: "high" as const,
    box: [0.35, 0.535, 0.46, 0.585],
    action: "mask" as const,
  },
  {
    type: "reflection",
    title: "반사된 배경",
    description: "유리창에 비친 건물, 차량, 인물이 위치나 생활 패턴을 드러낼 수 있어요.",
    risk: "medium" as const,
    box: [0.17, 0.43, 0.31, 0.54],
    action: "blur" as const,
  },
];

export function demoClues(photos: Photo[]): Clue[] {
  return photos.flatMap((p, imageIndex) =>
    DEMO_REGIONS.map((r, idx) => ({
      key: `${imageIndex}:${idx}`,
      jobIndex: imageIndex,
      idx,
      imageIndex,
      kind: "image" as const,
      type: r.type,
      title: r.title,
      description: r.description,
      risk: r.risk,
      bbox: [
        r.box[0] * p.width,
        r.box[1] * p.height,
        r.box[2] * p.width,
        r.box[3] * p.height,
      ] as [number, number, number, number],
      recommended: r.action,
      action: r.action,
    })),
  );
}

/** 워커의 단색 가림 색 (stages/transform.py 의 (20, 33, 56)) */
const MASK_COLOR = "rgb(20, 33, 56)";

/**
 * 선택한 처리 방법을 브라우저에서 그려 미리보기를 만든다. 워커 결과와 같은 모양이 되게 한다.
 * - blur(가리기): 영역을 작게 줄였다 키워 흐리게 (ctx.filter 가 없는 Safari 구버전도 동작)
 * - mask / remove(지우기): 워커와 같은 단색. 자연스러운 지우기는 인페인팅 연결 후 바뀐다.
 * 결과는 PNG 로 다시 그려 사진 파일 정보(EXIF)가 남지 않는다.
 */
export async function renderPhoto(photo: Photo, clues: Clue[]): Promise<Blob> {
  const img = await imageElement(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.width;
  canvas.height = photo.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서 이미지 편집을 사용할 수 없어요.");
  ctx.drawImage(img, 0, 0);
  for (const clue of clues) {
    if (clue.kind !== "image" || clue.action === "skip") continue;
    const box = validBox(clue.bbox, photo.width, photo.height);
    if (!box) continue;
    const [x, y] = [Math.floor(box[0]), Math.floor(box[1])];
    const w = Math.ceil(box[2]) - x;
    const h = Math.ceil(box[3]) - y;
    if (clue.action === "blur") {
      const scale = Math.max(4, Math.min(w, h) / 6);
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(w / scale));
      small.height = Math.max(1, Math.round(h / scale));
      const sctx = small.getContext("2d")!;
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(x, y, w, h);
    }
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("이미지 저장에 실패했어요."))),
      "image/png",
    ),
  );
}

/** 미리보기 Blob 을 화면·공유용 Photo 로 */
export async function photoFromBlob(blob: Blob, name: string): Promise<Photo> {
  return readPhoto(new File([blob], name, { type: blob.type || "image/png" }));
}
