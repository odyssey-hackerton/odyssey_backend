import type { Finding } from "./api";

export const MAX_PHOTOS = 4;
export const MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export type Photo = { file: File; url: string; width: number; height: number };
export type EditAction = "blur" | "mask" | "remove" | "replace" | "skip";
export type Clue = Finding & {
  imageIndex: number;
  idx: number;
  title: string;
  description: string;
  risk?: "high" | "medium" | "low";
  action: EditAction;
};

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

// shortcut: 데모는 고정된 예시 영역을 사용하며, 실제 탐지는 API 모드로 확인한다.
export function demoClues(photos: Photo[]): Clue[] {
  return photos.flatMap((p, imageIndex) =>
    [
      {
        type: "landmark",
        title: "간판 · 위치 단서",
        description:
          "가게 이름과 주변 모습으로 방문한 장소를 추측할 수 있어요.",
        risk: "medium" as const,
        box: [0.22, 0.355, 0.52, 0.415],
      },
      {
        type: "address",
        title: "상호 · 상세 정보",
        description: "출입문에 적힌 주소와 연락처가 위치 단서가 될 수 있어요.",
        risk: "high" as const,
        box: [0.35, 0.535, 0.46, 0.585],
      },
      {
        type: "reflection",
        title: "반사된 배경",
        description: "유리창에 비친 주변 풍경도 확인해 주세요.",
        risk: "medium" as const,
        box: [0.17, 0.43, 0.31, 0.54],
      },
    ].map((c, idx) => ({
      ...c,
      imageIndex,
      idx,
      bbox: [
        c.box[0] * p.width,
        c.box[1] * p.height,
        c.box[2] * p.width,
        c.box[3] * p.height,
      ] as [number, number, number, number],
      action: (idx === 2 ? "skip" : "mask") as EditAction,
    })),
  );
}

export async function renderDemo(
  photos: Photo[],
  clues: Clue[],
  replacement: string,
): Promise<File[]> {
  return Promise.all(
    photos.map(async (photo, imageIndex) => {
      const img = await imageElement(photo.url);
      const canvas = document.createElement("canvas");
      canvas.width = photo.width;
      canvas.height = photo.height;
      const ctx = canvas.getContext("2d");
      if (!ctx)
        throw new Error("이 브라우저에서 이미지 편집을 사용할 수 없어요.");
      ctx.drawImage(img, 0, 0);
      for (const clue of clues.filter(
        (c) => c.imageIndex === imageIndex && c.action !== "skip",
      )) {
        const box = validBox(clue.bbox, photo.width, photo.height);
        if (!box) continue;
        const [x, y, x2, y2] = box;
        const w = x2 - x,
          h = y2 - y;
        // 데모의 지우기·바꾸기는 단색 합성이다. 생성형 복원은 워커 연동 후 제공한다.
        ctx.fillStyle = clue.action === "mask" ? "#142138" : "#c8d6d0";
        if (clue.action === "blur") {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.filter = "blur(18px)";
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        } else {
          ctx.fillRect(x, y, w, h);
          if (clue.action === "replace" && replacement) {
            ctx.fillStyle = "#234b59";
            ctx.font = `bold ${Math.min(h * 0.42, w / Math.max(replacement.length, 1))}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(replacement, x + w / 2, y + h / 2, w * 0.9);
          }
        }
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("이미지 저장에 실패했어요.")),
          "image/png",
        ),
      );
      return new File([blob], `odyssey-${imageIndex + 1}.png`, {
        type: "image/png",
      });
    }),
  );
}
