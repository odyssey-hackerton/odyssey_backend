// 백엔드 게시물 API (/api/posts). Swagger: /docs
//
// 흐름: createPost → waitForPost(AWAITING_USER) → getPostReport → transformPost
//       → waitForPost(DONE) → getPostResult + getPostReport(재검증에서 남은 단서)

export type JobStatus =
  | "QUEUED"
  | "DETECTING"
  | "ANALYZING"
  | "AWAITING_USER"
  | "TRANSFORMING"
  | "VERIFYING"
  | "DONE"
  | "FAILED";

export interface Finding {
  type: string;
  source?: string;
  bbox?: [number, number, number, number];
  score?: number;
  action?: string;
  [extra: string]: unknown;
}

export interface PostItemStatus {
  position: number;
  job_id: string;
  input_type: "image" | "text" | "image_text";
  status: JobStatus;
  iteration: number;
  message: string | null;
  error: string | null;
}

export interface PostStatus {
  post_id: string;
  status: JobStatus;
  items: PostItemStatus[];
}

export interface PostReportItem {
  position: number;
  job_id: string;
  input_type: "image" | "text" | "image_text";
  status: JobStatus;
  risk_detected: boolean | null;
  risk_before: number | null;
  risk_after: number | null;
  iterations: number;
  findings: Finding[];
  details: Record<string, unknown>;
}

export interface PostReport {
  post_id: string;
  status: JobStatus;
  risk_before: number | null;
  risk_after: number | null;
  items: PostReportItem[];
}

export interface PostResult {
  post_id: string;
  text: string | null;
  items: { position: number; job_id: string; image_url: string | null }[];
}

export type Choice = { position: number; idx: number; action: string };

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("서버에 연결하지 못했어요. 네트워크(VPN) 연결을 확인해 주세요.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : null;
    throw new ApiError(detail ?? errorMessage(res.status));
  }
  return res.json() as Promise<T>;
}

function errorMessage(status: number): string {
  if (status === 413) return "파일이 너무 커요. 한 장에 10MB 이하로 올려 주세요.";
  if (status === 415) return "JPG, PNG, WebP 사진만 올릴 수 있어요.";
  if (status === 503) return "서버가 작업을 받을 수 없는 상태예요. 잠시 후 다시 시도해 주세요.";
  return `요청을 처리하지 못했어요 (${status}).`;
}

/** 사진(최대 4장)과 글로 게시물을 만든다. 사진 순서가 position 이 된다. */
export function createPost(files: File[], text: string): Promise<{ post_id: string }> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  if (text) form.append("text", text);
  return request("/api/posts", { method: "POST", body: form });
}

export const getPost = (id: string) => request<PostStatus>(`/api/posts/${id}`);
export const getPostReport = (id: string) => request<PostReport>(`/api/posts/${id}/report`);
export const getPostResult = (id: string) => request<PostResult>(`/api/posts/${id}/result`);

export const getGenerationStatus = () =>
  request<{ enabled: boolean }>("/api/images/regenerate");

/**
 * 보호 전처리가 끝난 사진과 여러 영역을 보내, AI 한 번 호출로 영역마다 새 배경을 받는다.
 * 게시물/분석 작업과 독립적이다. 결과는 영역 순서와 같다.
 */
export async function regenerateBackgrounds(
  image: Blob,
  boxes: [number, number, number, number][],
): Promise<Blob[]> {
  const form = new FormData();
  form.append("file", image, "edited.png");
  form.append("boxes", JSON.stringify(boxes));
  let response: Response;
  try {
    response = await fetch("/api/images/regenerate", { method: "POST", body: form });
  } catch {
    throw new ApiError("생성 응답을 받지 못했어요. 호출 횟수를 확인한 뒤 다시 시도해 주세요.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(typeof body?.detail === "string" ? body.detail : errorMessage(response.status));
  }
  const body = await response.json().catch(() => null);
  const patches: unknown = body?.patches;
  if (!Array.isArray(patches) || patches.length !== boxes.length || !patches.every((p) => typeof p === "string"))
    throw new ApiError("생성된 이미지 형식이 올바르지 않아요.");
  return patches.map((p: string) => {
    const bytes = Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: "image/png" });
  });
}

/** 고른 처리 방법과, 처음 올린 원본 사진들(같은 순서)을 다시 보낸다. */
export function transformPost(id: string, choices: Choice[], files: File[]) {
  const form = new FormData();
  form.append("choices", JSON.stringify(choices));
  files.forEach((f) => form.append("files", f));
  return request<{ post_id: string }>(`/api/posts/${id}/transform`, {
    method: "POST",
    body: form,
  });
}

const SETTLED: JobStatus[] = ["DONE", "FAILED", "AWAITING_USER"];

/**
 * 게시물 진행 상황을 받는다. SSE를 먼저 쓰고, 끊기면(프록시가 막는 경우 등) 1초 간격 조회로 바꾼다.
 * 반환된 함수를 호출하면 구독을 멈춘다.
 */
export function watchPost(id: string, onState: (s: PostStatus) => void): () => void {
  let stopped = false;
  let timer: number | undefined;
  const source = new EventSource(`/api/posts/${id}/events`);

  const handle = (s: PostStatus) => {
    if (stopped) return;
    onState(s);
    if (SETTLED.includes(s.status)) stop();
  };
  const poll = async () => {
    if (stopped) return;
    try {
      handle(await getPost(id));
    } catch {
      // 일시적인 오류는 다음 조회에서 다시 시도
    }
    if (!stopped) timer = window.setTimeout(poll, 1000);
  };
  for (const name of ["progress", "awaiting_user", "done"])
    source.addEventListener(name, (e) => handle(JSON.parse((e as MessageEvent).data)));
  const fallback = () => {
    source.close();
    if (!stopped && timer === undefined) void poll();
  };
  source.addEventListener("timeout", fallback);
  source.onerror = fallback;

  function stop() {
    stopped = true;
    source.close();
    if (timer !== undefined) window.clearTimeout(timer);
  }
  return stop;
}

/** 사용자 선택 대기·완료·실패 중 하나가 될 때까지 기다린다. */
export function waitForPost(
  id: string,
  onState: (s: PostStatus) => void,
  signal?: AbortSignal,
): Promise<PostStatus> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const abort = () => {
      stop();
      reject(new DOMException("aborted", "AbortError"));
    };
    const stop = watchPost(id, (state) => {
      onState(state);
      if (SETTLED.includes(state.status)) {
        signal?.removeEventListener("abort", abort);
        resolve(state);
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** 결과 사진을 같은 서버 주소에서 파일로 받는다 (공유·다운로드용). */
export async function fetchImage(url: string, name: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError("결과 사진을 가져오지 못했어요. 네트워크를 확인해 주세요.");
  }
  if (!res.ok) throw new ApiError("결과 사진을 가져오지 못했어요.");
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new ApiError("서버가 사진 파일을 돌려주지 않았어요.");
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  return new File([blob], `${name}.${ext}`, { type: blob.type });
}
