// 앱 설정 로드/저장.
// 설정은 ~/.cdsa_harness/config.json 에 저장한다(실행 폴더에 config.json 이 있으면 우선).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDERS = ["openai", "anthropic", "openrouter", "ollama", "mock"];

export const SUGGESTED_MODELS = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-sonnet-4-5"],
  // OpenRouter 는 반드시 'provider/model' 형식. (옛 anthropic/claude-3.5-sonnet 등은 404 가능)
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.7-sonnet",
    "google/gemini-2.0-flash-001",
  ],
  // 로컬/폐쇄망(Ollama). 도구 호출(tools) 지원 모델 권장. exaone 은 한국어 특화(LG).
  ollama: ["qwen2.5:7b", "llama3.1:8b", "exaone3.5:7.8b"],
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
  base_url: "", // OpenAI 호환 사내/폐쇄망 LLM 의 전체 엔드포인트 직접 지정(있으면 우선)
  model: "mock-agent",
  workspace: ".", // 기본 = 현재 폴더(cwd). Claude Code/OpenCode 와 동일 — 별도 폴더를 만들지 않는다.
  approval_mode: "manual",
  allow_shell: false,
  max_steps: 8,
  temperature: 0.2,
  max_tokens: 1024,
  teach_mode: true,
  stream: true, // 모델 응답을 실시간(토큰 단위)으로 출력
  import_foreign_skills: true, // .claude/commands 등 외부 포맷 스킬도 읽기(프로젝트+전역)
  skill_dirs: [], // 스킬을 추가로 읽어올 폴더(절대/상대 경로)
  no_color: false, // 색상 끄기(흑백)
  update_check: true, // 시작 시 새 버전 확인(하루 1회, 실패 시 조용히 무시)
  plugins: [], // 추가로 불러올 npm 플러그인 패키지 이름(이름 규칙과 무관하게 강제 로드)
  mcpServers: {}, // MCP 서버 설정 (Claude Code/Cursor 와 동일한 형식)
  permissions: {}, // 도구별 권한: { "run_shell": "allow"|"ask"|"deny", ... } (OpenCode 방식)
  auto_compact_tokens: 12000, // 추정 토큰이 이 값을 넘으면 대화 자동 압축(0=끔)
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
    let p = this.workspace || ".";
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
    if (this.provider === "ollama") return true; // 로컬 LLM — API 키 불필요
    return Boolean(this.resolvedKey());
  }

  toJSON() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key === "workspace") continue; // 실행 폴더가 곧 워크스페이스 — 저장하지 않는다
      out[key] = this[key];
    }
    return out;
  }
}

export function loadConfig() {
  const p = configPath();
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      // workspace 는 '실행한 폴더'가 진리 — 파일에 저장된 값(옛 버전 잔재)은 무시한다.
      delete data.workspace;
      return new Config(data);
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
