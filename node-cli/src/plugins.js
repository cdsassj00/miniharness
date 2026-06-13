// 플러그인 시스템 — OpenCode 스타일 확장성.
// `.cdsa/plugins/` (작업 폴더) 와 `~/.cdsa_harness/plugins/` (전역) 의 .js/.mjs 파일을
// 불러와 '새 도구'로 등록한다. 각 파일은 아래 형태의 객체를 default export 한다:
//
//   export default {
//     name: "word_count",
//     description: "텍스트 파일의 글자/줄 수를 센다",
//     parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
//     mutating: false,                  // true 면 실행 전 사용자 승인 필요
//     async handler(args, ctx) { ... }  // ctx = { workspace }
//   }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function pluginDirs(workspace) {
  return [
    path.join(os.homedir(), ".cdsa_harness", "plugins"),
    path.join(workspace, ".cdsa", "plugins"),
  ];
}

export async function loadPlugins(workspace) {
  const plugins = [];
  for (const dir of pluginDirs(workspace)) {
    let files = [];
    try {
      if (!fs.existsSync(dir)) continue;
      files = fs.readdirSync(dir).filter((f) => /\.(mjs|js)$/.test(f)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const mod = await import(pathToFileURL(full).href);
        const def = mod.default || mod.plugin || mod;
        if (!def || !def.name || typeof def.handler !== "function") {
          plugins.push({ error: `${f}: name/handler 가 없습니다` });
          continue;
        }
        plugins.push({
          name: def.name,
          description: def.description || "",
          parameters: def.parameters || { type: "object", properties: {} },
          mutating: Boolean(def.mutating),
          handler: def.handler,
          source: full,
        });
      } catch (e) {
        plugins.push({ error: `${f}: ${e.message}` });
      }
    }
  }
  return plugins;
}
