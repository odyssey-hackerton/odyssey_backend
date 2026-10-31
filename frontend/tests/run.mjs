import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

// Vite에 포함된 esbuild로 테스트를 변환하여 Node 20에서도 TypeScript를 검사한다.
const directory = await mkdtemp(join(tmpdir(), "odyssey-tests-"));
try {
  await build({
    entryPoints: ["tests/api.test.ts", "tests/media.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: directory,
    outExtension: { ".js": ".mjs" },
  });
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      join(directory, "api.test.mjs"),
      join(directory, "media.test.mjs"),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
