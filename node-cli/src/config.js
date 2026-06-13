// 앱 설정 로드/저장.
// 설정은 ~/.cdsa_harness/config.json 에 저장한다(실행 폴더에 config.json 이 있으면 우선).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDERS = ["openai", "anthropic", "openrouter", "mock"];

export const SUGGESTED_MODELS = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-sonnet-4-5"],
  // OpenRouter 는 반드시 'provider/model' 형식. (옛 anthropic/claude-3.5-sonnet 등은 404 가능)
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.7-sonnet",
    "google/gemini-2.0-flash-001",
  ],
  mock: ["mock-agent"],
};

// provider 별로 자동 감지하는 환경변수(파일에 키를 저장하지 않아도 됨)
export const ENV_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
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
  max_tokens: 1024,
  teach_mode: true,
  stream: true, // 모델 응답을 실시간(토큰 단위)으로 출력
  plugins: [], // 추가로 불러올 npm 플러그인 패키지 이름(이름 규칙과 무관하게 강제 로드)
  mcpServers: {}, // MCP 서버 설정 (Claude Code/Cursor 와 동일한 형식)
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

  // 파일에 저장된 키가 없으면 환경변수에서 찾는다.
  resolvedKey() {
    const direct = (this.api_key || "").trim();
    if (direct) return direct;
    const envName = ENV_KEYS[this.provider];
    return envName ? (process.env[envName] || "").trim() : "";
  }

  isReady() {
    if (this.provider === "mock") return true;
    return Boolean(this.resolvedKey());
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
