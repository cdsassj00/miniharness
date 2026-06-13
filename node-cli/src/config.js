// 앱 설정 로드/저장.
// 설정은 ~/.cdsa_harness/config.json 에 저장한다(실행 폴더에 config.json 이 있으면 우선).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDERS = ["openai", "openrouter", "mock"];

export const SUGGESTED_MODELS = {
  openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"],
  openrouter: [
    "openai/gpt-4.1-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.5-flash",
  ],
  mock: ["mock-agent"],
};

export const APPROVAL_MODES = ["manual", "auto"];

const DEFAULTS = {
  provider: "mock",
  api_key: "",
  model: "mock-agent",
  workspace: "./workspace",
  approval_mode: "manual",
  allow_shell: false,
  max_steps: 8,
  temperature: 0.2,
};

export function configDir() {
  return path.join(os.homedir(), ".cdsa_harness");
}

export function configPath() {
  const local = path.join(process.cwd(), "config.json");
  if (fs.existsSync(local)) return local;
  return path.join(configDir(), "config.json");
}

export class Config {
  constructor(data = {}) {
    Object.assign(this, DEFAULTS);
    for (const key of Object.keys(DEFAULTS)) {
      if (data[key] !== undefined) this[key] = data[key];
    }
  }

  // CLI 도구이므로 작업 폴더 상대경로는 '현재 폴더' 기준으로 해석한다(직관적).
  workspacePath() {
    let p = this.workspace || "./workspace";
    if (!path.isAbsolute(p)) p = path.resolve(process.cwd(), p);
    return p;
  }

  isReady() {
    if (this.provider === "mock") return true;
    return Boolean((this.api_key || "").trim());
  }

  toJSON() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = this[key];
    return out;
  }
}

export function loadConfig() {
  const p = configPath();
  try {
    if (fs.existsSync(p)) {
      return new Config(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  } catch {
    // 손상된 설정은 무시하고 기본값
  }
  return new Config();
}

export function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg.toJSON(), null, 2), "utf8");
  return p;
}
