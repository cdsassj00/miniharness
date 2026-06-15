// 단일 실행파일(.exe / 바이너리) 빌더 — Node 없이 실행되는 cdsa-harness 를 만든다.
// 흐름: 내장 리소스 생성 → esbuild 로 한 파일 번들 → Node SEA blob → node 바이너리에 주입.
// 현재 OS 용 바이너리를 dist/ 에 만든다(크로스플랫폼은 GitHub Actions 매트릭스에서).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exeName = isWin ? "cdsa-harness.exe" : "cdsa-harness";
const exePath = path.join(dist, exeName);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1) 내장 스킬/플러그인/버전 생성(임베드)
run(process.execPath, ["scripts/gen-builtins.mjs"]);

// 2) esbuild 로 단일 CJS 번들
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: [path.join(root, "bin", "cdsa-harness.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: path.join(dist, "bundle.cjs"),
  logLevel: "warning",
});

// 3) SEA blob 생성
const seaConfig = {
  main: path.join(dist, "bundle.cjs"),
  output: path.join(dist, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(dist, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ["--experimental-sea-config", path.join(dist, "sea-config.json")]);

// 4) node 바이너리 복사 후 blob 주입(postject JS API — npx 스폰 없이 크로스플랫폼 안정)
fs.copyFileSync(process.execPath, exePath);
if (!isWin) fs.chmodSync(exePath, 0o755);

const { inject } = await import("postject");
await inject(exePath, "NODE_SEA_BLOB", fs.readFileSync(path.join(dist, "sea-prep.blob")), {
  sentinelFuse: FUSE,
  machoSegmentName: isMac ? "NODE_SEA" : undefined,
});

console.log(`\n✅ 단일 실행파일 생성: ${exePath}`);
console.log(`   실행 예: ${isWin ? "dist\\cdsa-harness.exe" : "./dist/cdsa-harness"} --help`);
