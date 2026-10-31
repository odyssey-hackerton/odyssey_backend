import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, transformJob, watchJob } from "../src/api.ts";

test("image and caption travel together and transform choices use the existing API", async () => {
  const original = globalThis.fetch;
  const calls: { path: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return Response.json({ job_id: "test" });
  };
  try {
    await createJob({
      file: new File(["image"], "image.png", { type: "image/png" }),
      text: "caption",
    });
    const body = calls[0].init!.body as FormData;
    assert.equal(body.get("text"), "caption");
    assert.equal((body.get("file") as File).name, "image.png");
    const originalFile = new File(["original"], "image.png", { type: "image/png" });
    await transformJob("test", [{ idx: 0, action: "mask" }], originalFile);
    assert.equal(calls[1].path, "/api/jobs/test/transform");
    const edit = calls[1].init!.body as FormData;
    assert.deepEqual(JSON.parse(edit.get("choices") as string), [{ idx: 0, action: "mask" }]);
    assert.equal(await (edit.get("file") as File).text(), "original");
    await transformJob("text-only", []);
    assert.equal((calls[2].init!.body as FormData).has("file"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("SSE pauses at awaiting_user instead of hanging before the edit screen", () => {
  const original = globalThis.EventSource;
  let stream: FakeSource;
  class FakeSource {
    events = new Map<string, (event: { data: string }) => void>();
    closed = false;
    constructor() {
      stream = this;
    }
    addEventListener(
      name: string,
      listener: (event: { data: string }) => void,
    ) {
      this.events.set(name, listener);
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  try {
    const statuses: string[] = [];
    const stop = watchJob("test", (state) => statuses.push(state.status));
    stream!.events.get("awaiting_user")!({
      data: JSON.stringify({ status: "AWAITING_USER" }),
    });
    assert.deepEqual(statuses, ["AWAITING_USER"]);
    assert.equal(stream!.closed, true);
    stop();
  } finally {
    globalThis.EventSource = original;
  }
});
