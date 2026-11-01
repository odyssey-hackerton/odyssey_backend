import assert from "node:assert/strict";
import { test } from "node:test";
import { createPost, fetchImage, transformPost, waitForPost } from "../src/api.ts";

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

test("background generation sends every region in one call and splits the patches back in order", async () => {
  const { regenerateBackgrounds, getGenerationStatus } = await import("../src/api.ts");
  const original = globalThis.fetch;
  let requests = 0;
  let fail = true;
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, "/api/images/regenerate");
    if (!init) return Response.json({ enabled: true });
    const form = init.body as FormData;
    assert.equal(await (form.get("file") as File).text(), "edited pixels");
    assert.deepEqual(JSON.parse(form.get("boxes") as string), [[10, 20, 30, 40], [50, 60, 70, 80]]);
    assert.equal(form.get("bbox"), null);
    if (fail) return Response.json({ detail: "배경을 생성하지 못했어요." }, { status: 502 });
    return Response.json({ patches: [btoa("first"), btoa("second")] });
  };
  try {
    const boxes: [number, number, number, number][] = [[10, 20, 30, 40], [50, 60, 70, 80]];
    await assert.rejects(regenerateBackgrounds(new Blob(["edited pixels"]), boxes), /생성하지 못/);
    fail = false;
    const blobs = await regenerateBackgrounds(new Blob(["edited pixels"]), boxes);
    assert.deepEqual(await Promise.all(blobs.map((b) => b.text())), ["first", "second"]);
    assert.ok(blobs.every((b) => b.type === "image/png"));
    assert.deepEqual(await getGenerationStatus(), { enabled: true });
    assert.equal(requests, 3);
  } finally { globalThis.fetch = original; }
});

test("share files contain the downloaded result bytes and matching filename, not a result URL", async () => {
  const original = globalThis.fetch;
  try {
    for (const [type, ext] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]) {
      globalThis.fetch = async (url) => {
        assert.equal(url, "/api/jobs/j1/image");
        return new Response("processed image", { headers: { "Content-Type": type } });
      };
      const file = await fetchImage("/api/jobs/j1/image", "odyssey-1");
      assert.equal(file.name, `odyssey-1.${ext}`);
      assert.equal(file.type, type);
      assert.equal(await file.text(), "processed image");
    }
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(fetchImage("/api/jobs/j1/image", "odyssey-1"), /가져오지/);
    globalThis.fetch = async () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } });
    await assert.rejects(fetchImage("/api/jobs/j1/image", "odyssey-1"), /사진 파일/);
  } finally {
    globalThis.fetch = original;
  }
});
