// 백엔드 API (odyssey_backend README의 "API" 표와 같은 계약)

export type JobStatus =
  | "QUEUED"
  | "DETECTING"
  | "ANALYZING"
  | "AWAITING_USER"
  | "TRANSFORMING"
  | "VERIFYING"
  | "DONE"
  | "FAILED";

export interface JobState {
  job_id: string;
  input_type: "image" | "text" | "image_text";
  status: JobStatus;
  iteration: number;
  message: string | null;
  error: string | null;
}

export interface JobResult {
  type: "image" | "text" | "image_text";
  url: string | null;
  expires_in: number | null;
  text: string | null;
}

export interface Finding {
  type: string;
  source?: string;
  bbox?: [number, number, number, number];
  score?: number;
  action?: string;
  [extra: string]: unknown;
}

export interface JobReport {
  job_id: string;
  risk_detected: boolean | null;
  risk_before: number | null;
  risk_after: number | null;
  iterations: number;
  findings: Finding[];
  details: Record<string, unknown>;
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(
      "서버에 연결하지 못했습니다. 네트워크(VPN) 연결을 확인하세요.",
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : null;
    throw new ApiError(detail ?? errorMessage(res.status));
  }
  return res.json() as Promise<T>;
}

function errorMessage(status: number): string {
  if (status === 413) return "파일이 너무 큽니다. 10MB 이하로 올려 주세요.";
  if (status === 415) return "jpg, png, webp 이미지만 올릴 수 있습니다.";
  if (status === 503)
    return "서버가 작업을 받을 수 없는 상태입니다. 잠시 후 다시 시도하세요.";
  return `요청을 처리하지 못했습니다 (${status}).`;
}

export function createJob(input: {
  file?: File;
  text?: string;
}): Promise<{ job_id: string }> {
  const form = new FormData();
  if (input.file) form.append("file", input.file);
  if (input.text) form.append("text", input.text);
  return request("/api/jobs", { method: "POST", body: form });
}

export const getJob = (id: string) => request<JobState>(`/api/jobs/${id}`);
export const getResult = (id: string) =>
  request<JobResult>(`/api/jobs/${id}/result`);
export const getReport = (id: string) =>
  request<JobReport>(`/api/jobs/${id}/report`);
export const transformJob = (
  id: string,
  choices: { idx: number; action: string }[],
  file?: File,
) => {
  const form = new FormData();
  form.append("choices", JSON.stringify(choices));
  if (file) form.append("file", file);
  return request<{ job_id: string }>(`/api/jobs/${id}/transform`, {
    method: "POST",
    body: form,
  });
};

const FINAL: JobStatus[] = ["DONE", "FAILED", "AWAITING_USER"];

/**
 * 진행 상황을 받는다. SSE를 먼저 쓰고, 끊기면(프록시가 막는 경우 등) 1초 간격 조회로 바꾼다.
 * 반환된 함수를 호출하면 구독을 멈춘다.
 */
export function watchJob(
  id: string,
  onState: (s: JobState) => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;
  const source = new EventSource(`/api/jobs/${id}/events`);

  const handle = (s: JobState) => {
    if (stopped) return;
    onState(s);
    if (FINAL.includes(s.status)) stop();
  };

  const poll = async () => {
    if (stopped) return;
    try {
      handle(await getJob(id));
    } catch {
      // 일시적인 오류는 다음 조회에서 다시 시도
    }
    if (!stopped) timer = window.setTimeout(poll, 1000);
  };

  source.addEventListener("progress", (e) =>
    handle(JSON.parse((e as MessageEvent).data)),
  );
  source.addEventListener("done", (e) =>
    handle(JSON.parse((e as MessageEvent).data)),
  );
  source.addEventListener("awaiting_user", (e) =>
    handle(JSON.parse((e as MessageEvent).data)),
  );
  source.addEventListener("timeout", () => {
    source.close();
    if (!stopped && timer === undefined) poll();
  });
  source.onerror = () => {
    source.close();
    if (!stopped && timer === undefined) poll();
  };

  function stop() {
    stopped = true;
    source.close();
    if (timer !== undefined) window.clearTimeout(timer);
  }
  return stop;
}

const SETTLED: JobStatus[] = ["DONE", "FAILED", "AWAITING_USER"];

/** 작업이 사용자 선택 대기·완료·실패 중 하나가 될 때까지 기다린다. 진행 상태는 onState 로 받는다. */
export function waitForJob(
  id: string,
  onState: (s: JobState) => void,
  signal?: AbortSignal,
): Promise<JobState> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const stop = watchJob(id, (state) => {
      onState(state);
      if (SETTLED.includes(state.status)) {
        signal?.removeEventListener("abort", abort);
        resolve(state);
      }
    });
    const abort = () => {
      stop();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** 결과 presigned URL 에서 이미지를 받아 공유·다운로드할 수 있는 File 로 만든다. */
export async function fetchResultFile(url: string, name: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError(
      "결과 사진을 가져오지 못했어요. S3 접근(CORS) 설정을 확인해 주세요.",
    );
  }
  if (!res.ok)
    throw new ApiError("결과 사진을 가져오지 못했어요. 링크가 만료됐을 수 있어요.");
  const blob = await res.blob();
  if (!blob.type.startsWith("image/"))
    throw new ApiError("서버가 이미지 파일을 돌려주지 않았어요.");
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  return new File([blob], `${name}.${ext}`, { type: blob.type });
}
