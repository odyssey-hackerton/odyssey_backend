/** 텍스트제거를 선택할 때만 OpenCV/WASM을 로드한다. */
export async function inpaintRegion(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const { width, height } = ctx.canvas;
  if (w === width && h === height) throw new Error("주변 배경이 필요해요. 텍스트제거 영역을 줄여 주세요.");
  const cv = await (await import("@techstark/opencv-js")).default;
  const left = Math.max(0, x - 24), top = Math.max(0, y - 24);
  const cw = Math.min(width, x + w + 24) - left, ch = Math.min(height, y + h + 24) - top;
  const crop = document.createElement("canvas");
  // shortcut: 큰 영역은 512px로 처리한다. 복잡한 배경의 정밀 제거가 필요하면 글자별 마스크를 도입한다.
  const scale = Math.min(1, 512 / Math.max(cw, ch));
  crop.width = Math.max(1, Math.round(cw * scale));
  crop.height = Math.max(1, Math.round(ch * scale));
  const cropCtx = crop.getContext("2d");
  if (!cropCtx) throw new Error("이 브라우저에서 텍스트제거를 사용할 수 없어요.");
  cropCtx.drawImage(ctx.canvas, left, top, cw, ch, 0, 0, crop.width, crop.height);
  const src = cv.matFromImageData(cropCtx.getImageData(0, 0, crop.width, crop.height));
  const rgb = new cv.Mat(), result = new cv.Mat();
  const mask = cv.Mat.zeros(crop.height, crop.width, cv.CV_8UC1);
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const sx = crop.width / cw, sy = crop.height / ch;
    cv.rectangle(mask,
      new cv.Point(Math.floor((x - left) * sx), Math.floor((y - top) * sy)),
      new cv.Point(Math.ceil((x + w - left) * sx) - 1, Math.ceil((y + h - top) * sy) - 1),
      new cv.Scalar(255), cv.FILLED);
    cv.inpaint(rgb, mask, result, 3, cv.INPAINT_TELEA);
    cv.imshow(crop, result);
    // 바깥의 원본 픽셀은 보존하고 선택 영역만 합성한다.
    ctx.drawImage(crop, (x - left) * sx, (y - top) * sy, w * sx, h * sy, x, y, w, h);
  } finally {
    src.delete(); rgb.delete(); result.delete(); mask.delete();
  }
}
