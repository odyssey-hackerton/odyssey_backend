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

const MASK_COLOR = "rgb(20, 33, 56)";

/** Two sliding-window passes, including browsers without Canvas filter support. */
export function blurPixels(data: Uint8ClampedArray, width: number, height: number, radius: number) {
  const temp = new Uint8ClampedArray(data.length);
  const r = Math.max(1, Math.round(radius));
  for (const horizontal of [true, false]) {
    const source = horizontal ? data : temp, target = horizontal ? temp : data;
    const length = horizontal ? width : height, lines = horizontal ? height : width;
    for (let line = 0; line < lines; line++) {
      const index = (n: number) => (horizontal ? line * width + n : n * width + line) * 4;
      const sums = [0, 0, 0, 0];
      for (let k = -r; k <= r; k++) {
        const i = index(Math.max(0, Math.min(length - 1, k)));
        for (let c = 0; c < 4; c++) sums[c] += source[i + c];
      }
      for (let n = 0; n < length; n++) {
        const i = index(n);
        const old = index(Math.max(0, n - r));
        const next = index(Math.min(length - 1, n + r + 1));
        for (let c = 0; c < 4; c++) {
          target[i + c] = sums[c] / (2 * r + 1);
          sums[c] += source[next + c] - source[old + c];
        }
      }
    }
  }
}

/** Preview and export use the same pixels; PNG export removes EXIF. */
export async function renderPhoto(photo: Photo, clues: Clue[]): Promise<Blob> {
  const img = await imageElement(photo.url);
  const canvas = document.createElement("canvas");
  canvas.width = photo.width;
  canvas.height = photo.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서 이미지 편집을 사용할 수 없어요.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, photo.width, photo.height);
  // Reconstructed pixels go first so they cannot overwrite opaque protections.
  const restorative = (c: Clue) => ["remove", "regenerate"].includes(c.action);
  const ordered = [...clues].sort((a, b) => Number(restorative(b)) - Number(restorative(a)));
  for (const clue of ordered) {
    if (clue.kind !== "image" || clue.deleted || clue.action === "skip") continue;
    let box = validBox(clue.bbox, photo.width, photo.height);
    if (!box) continue;
    if (clue.action === "partialMask") {
      const part = validBox(clue.maskBox, 1, 1);
      if (!part) throw new Error("부분마스킹할 범위를 사진에서 지정해 주세요.");
      const [x, y, x2, y2] = box;
      box = [x + (x2 - x) * part[0], y + (y2 - y) * part[1],
        x + (x2 - x) * part[2], y + (y2 - y) * part[3]];
    }
    const x = Math.floor(box[0]), y = Math.floor(box[1]);
    const w = Math.ceil(box[2]) - x, h = Math.ceil(box[3]) - y;
    const strength = 16;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (clue.action === "regenerate") {
      if (!clue.generatedUrl) throw new Error("이미지를 먼저 생성하거나 다른 편집 방식을 선택해 주세요.");
      ctx.drawImage(await imageElement(clue.generatedUrl), x, y, w, h);
    } else if (clue.action === "remove") {
      const { inpaintRegion } = await import("./inpaint");
      await inpaintRegion(ctx, x, y, w, h);
    } else if (clue.action === "blur" || clue.action === "mosaic") {
      const small = document.createElement("canvas");
      const scale = clue.action === "mosaic" ? strength : Math.max(1, Math.max(w, h) / 768);
      small.width = Math.max(1, Math.ceil(w / scale));
      small.height = Math.max(1, Math.ceil(h / scale));
      const sctx = small.getContext("2d");
      if (!sctx) throw new Error("이미지 편집을 사용할 수 없어요.");
      sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
      if (clue.action === "blur") {
        const pixels = sctx.getImageData(0, 0, small.width, small.height);
        blurPixels(pixels.data, small.width, small.height, strength / scale);
        sctx.putImageData(pixels, 0, 0);
      }
      ctx.imageSmoothingEnabled = clue.action !== "mosaic";
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
    } else {
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
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
