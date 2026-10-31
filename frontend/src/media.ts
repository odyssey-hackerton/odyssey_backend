import type { Clue } from "./flow";

export const MAX_PHOTOS = 4;
export const MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export type Photo = { file: File; url: string; width: number; height: number };

/** 클릭 핸들러에서 준비된 파일을 바로 전달해야 Safari의 사용자 활성화가 유지된다. */
export async function sharePhotos(files: File[], text: string): Promise<void> {
  if (files.length > MAX_PHOTOS)
    throw new Error(`사진은 최대 ${MAX_PHOTOS}장까지 공유할 수 있어요.`);
  if (!files.length && !text.trim()) throw new Error("공유할 사진이나 본문이 없어요.");
  // files만 검사해야 파일 공유를 모르는 브라우저가 text만 보고 통과하지 않는다.
  if (!navigator.share || (files.length && !navigator.canShare?.({ files })))
    throw new Error(
      "이 환경에서는 공유를 지원하지 않아요. 사진을 다운로드하고 본문을 복사하거나, HTTPS로 연결한 iPhone Safari에서 시도해 주세요.",
    );
  await navigator.share({
    ...(text ? { text } : {}),
    ...(files.length ? { files } : {}),
  });
}

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
  bbox: Clue["bbox"],
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
