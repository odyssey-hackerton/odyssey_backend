import assert from "node:assert/strict";
import { test } from "node:test";
import { createPost, transformPost, waitForPost } from "../src/api.ts";

test("photos and caption go up as one post; transform resends originals in order", async () => {
  const original = globalThis.fetch;
  const calls: { path: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return Response.json({ post_id: "p1" });
  };
  try {
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.png", { type: "image/png" });
    await createPost([a, b], "caption");
    const body = calls[0].init!.body as FormData;
    assert.equal(calls[0].path, "/api/posts");
    assert.deepEqual(
      body.getAll("files").map((f) => (f as File).name),
      ["a.png", "b.png"],
    );
    assert.equal(body.get("text"), "caption");

    await transformPost("p1", [{ position: 1, idx: 0, action: "blur" }], [a, b]);
    const edit = calls[1].init!.body as FormData;
    assert.equal(calls[1].path, "/api/posts/p1/transform");
    assert.deepEqual(JSON.parse(edit.get("choices") as string), [{ position: 1, idx: 0, action: "blur" }]);
    assert.equal(edit.getAll("files").length, 2);

    await createPost([], "text only");
    assert.equal((calls[2].init!.body as FormData).has("files"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("waiting stops at awaiting_user so the user can choose", async () => {
  const original = globalThis.EventSource;
  let stream: FakeSource;
  class FakeSource {
    events = new Map<string, (event: { data: string }) => void>();
    closed = false;
    onerror: (() => void) | null = null;
    constructor() {
      stream = this;
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.events.set(name, listener);
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  try {
    const seen: string[] = [];
    const waiting = waitForPost("p1", (s) => seen.push(s.status));
    stream!.events.get("progress")!({ data: JSON.stringify({ status: "DETECTING", items: [] }) });
    stream!.events.get("awaiting_user")!({ data: JSON.stringify({ status: "AWAITING_USER", items: [] }) });
    const final = await waiting;
    assert.equal(final.status, "AWAITING_USER");
    assert.deepEqual(seen, ["DETECTING", "AWAITING_USER"]);
    assert.equal(stream!.closed, true);
  } finally {
    globalThis.EventSource = original;
  }
});

test("background generation sends edited pixels and geometry, and surfaces provider errors", async () => {
  const { regenerateBackground, getGenerationStatus } = await import("../src/api.ts");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, "/api/images/regenerate");
    if (!init) return Response.json({ enabled: true });
    const form = init.body as FormData;
    assert.equal(await (form.get("file") as File).text(), "edited pixels");
    assert.deepEqual(JSON.parse(form.get("bbox") as string), [10, 20, 30, 40]);
    return Response.json({ detail: "배경을 생성하지 못했어요." }, { status: 502 });
  };
  try {
    await assert.rejects(regenerateBackground(new Blob(["edited pixels"]), [10, 20, 30, 40]), /생성하지 못/);
    assert.deepEqual(await getGenerationStatus(), { enabled: true });
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});
