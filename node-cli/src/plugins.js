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
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 패키지에 동봉된 기본(내장) 플러그인 폴더 — 설치하면 누구에게나 딸려온다.
function builtinPluginsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../<pkg>/src
  return path.resolve(here, "..", "plugins"); // .../<pkg>/plugins
}

export function pluginDirs(workspace) {
  return [
    builtinPluginsDir(), // 내장 기본(가장 먼저)
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

// ---------------------------------------------------------------------------
// npm 패키지로 설치한 플러그인 자동 발견.
//   - 이름이 `cdsa-harness-plugin-*` (또는 `@scope/cdsa-harness-plugin-*`)
//   - 또는 package.json 에 keywords: ["cdsa-harness-plugin"] / "cdsaHarness" 필드
//   인 패키지를 node_modules 에서 찾아 불러온다.
// 패키지는 다음 중 하나를 default export:
//   · 플러그인 def 객체  · def 배열  · { tools:[...], skills:[{name,description,body}] }
// ---------------------------------------------------------------------------
function isPluginPackage(pkgJson, name) {
  if (/^(@[^/]+\/)?cdsa-harness-plugin-/.test(name)) return true;
  if (pkgJson && pkgJson.cdsaHarness) return true;
  const kw = (pkgJson && pkgJson.keywords) || [];
  return Array.isArray(kw) && kw.includes("cdsa-harness-plugin");
}

async function importPackage(nmDir, name) {
  const req = createRequire(path.join(nmDir, "__cdsa_resolve__.js"));
  const entry = req.resolve(name);
  return import(pathToFileURL(entry).href);
}

function normalizeModule(mod, source) {
  const out = { plugins: [], skills: [] };
  const def = (mod && (mod.default ?? mod)) || null;
  if (!def) return out;
  let tools = [];
  let skills = [];
  if (Array.isArray(def)) tools = def;
  else if (def.tools || def.skills) {
    tools = def.tools || [];
    skills = def.skills || [];
  } else if (def.name && typeof def.handler === "function") tools = [def];
  for (const t of tools) {
    if (t && t.name && typeof t.handler === "function") {
      out.plugins.push({
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
        mutating: Boolean(t.mutating),
        handler: t.handler,
        source,
      });
    }
  }
  for (const s of skills) if (s && s.name && s.body) out.skills.push(s);
  return out;
}

// 한 node_modules 디렉터리를 훑어 플러그인 패키지를 모은다.
export async function scanNodeModules(nmDir) {
  const result = { plugins: [], skills: [], errors: [] };
  let entries = [];
  try {
    if (!fs.existsSync(nmDir)) return result;
    entries = fs.readdirSync(nmDir);
  } catch {
    return result;
  }
  const names = [];
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      try {
        for (const sub of fs.readdirSync(path.join(nmDir, e))) names.push(`${e}/${sub}`);
      } catch {
        /* ignore */
      }
    } else names.push(e);
  }
  for (const name of names) {
    let pkgJson = {};
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(nmDir, name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!isPluginPackage(pkgJson, name)) continue;
    try {
      const mod = await importPackage(nmDir, name);
      const norm = normalizeModule(mod, name);
      result.plugins.push(...norm.plugins);
      result.skills.push(...norm.skills);
    } catch (e) {
      result.errors.push(`${name}: ${e.message}`);
    }
  }
  return result;
}

// cwd 의 node_modules + cdsa-harness 자신의 node_modules(전역 설치 시 형제 패키지) 를 훑고,
// config.plugins 에 적힌 패키지는 이름 규칙과 무관하게 강제로 불러온다.
export async function discoverNpmExtensions(cwd, explicitNames = []) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const nmDirs = [];
  const add = (d) => {
    const r = path.resolve(d);
    if (!nmDirs.includes(r)) nmDirs.push(r);
  };
  add(path.join(cwd, "node_modules"));
  add(path.resolve(here, "..", "..")); // .../node_modules/cdsa-harness/src → .../node_modules

  const merged = { plugins: [], skills: [], errors: [] };
  for (const nm of nmDirs) {
    const r = await scanNodeModules(nm);
    merged.plugins.push(...r.plugins);
    merged.skills.push(...r.skills);
    merged.errors.push(...r.errors);
  }
  for (const name of explicitNames) {
    if (merged.plugins.some((p) => p.source === name)) continue;
    let loaded = false;
    for (const nm of nmDirs) {
      try {
        const norm = normalizeModule(await importPackage(nm, name), name);
        if (norm.plugins.length || norm.skills.length) {
          merged.plugins.push(...norm.plugins);
          merged.skills.push(...norm.skills);
          loaded = true;
          break;
        }
      } catch {
        /* try next dir */
      }
    }
    if (!loaded) merged.errors.push(`${name}: 불러올 수 없음(설치되어 있나요? npm i ${name})`);
  }
  // 이름 중복 제거(먼저 발견된 것 우선)
  const byName = new Map();
  for (const p of merged.plugins) if (!byName.has(p.name)) byName.set(p.name, p);
  merged.plugins = [...byName.values()];
  return merged;
}
