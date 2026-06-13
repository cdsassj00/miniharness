// CDSA Harness TUI 본체 — 터미널 REPL.
// Python 의 ui/tui 와 동일한 흐름을 Node 내장 모듈만으로 구현.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { renderBanner } from "./banner.js";
import { Config, configPath, loadConfig, saveConfig } from "./config.js";
import { AgentLoop, Step, STEP_LABELS } from "./loop.js";
import { LLMClient } from "./llm.js";
import { SessionLog, sessionsDir } from "./session.js";
import { Toolbox } from "./tools.js";
import { c, panel, renderDiff } from "./ui.js";

const VERSION = "0.1.0";

const STEP_STYLE = {
  [Step.USER_INPUT]: ["🧑", "cyan"],
  [Step.BUILD_CONTEXT]: ["🧱", "grey"],
  [Step.MODEL_CALL]: ["🧠", "magenta"],
  [Step.MODEL_REPLY]: ["🤖", "green"],
  [Step.TOOL_DECISION]: ["🤔", "yellow"],
  [Step.APPROVAL]: ["🔐", "yellow"],
  [Step.TOOL_RUN]: ["🔧", "blue"],
  [Step.TOOL_RESULT]: ["📄", "grey"],
  [Step.DONE]: ["✅", "green"],
  [Step.ERROR]: ["❌", "red"],
};

function makePrinter() {
  return (ev) => {
    const [icon, color] = STEP_STYLE[ev.step] || ["•", "cyan"];
    const paint = c[color] || ((x) => x);

    // 승인 단계 UI 는 approvalCallback 이 직접 그린다(자동 승인 안내만 출력)
    if (ev.step === Step.APPROVAL && !ev.title.includes("자동 승인")) return;

    if (ev.step === Step.MODEL_REPLY) {
      if (ev.detail && ev.detail !== "(텍스트 없음)") {
        console.log(panel(ev.detail.split("\n"), { title: "🤖 모델", color: "green" }));
      }
      return;
    }
    if (ev.step === Step.DONE) {
      console.log(panel((ev.detail || "완료").split("\n"), { title: "✅ 완료", color: "green" }));
      return;
    }
    if (ev.step === Step.ERROR) {
      console.log(panel((ev.detail || "").split("\n"), { title: `❌ ${ev.title}`, color: "red" }));
      return;
    }

    let detail = (ev.detail || "").trim().replace(/\s+/g, " ");
    if (detail.length > 110) detail = detail.slice(0, 110) + " …";
    let line = `${paint(icon)} ${paint(c.bold(ev.title))}`;
    if (detail && ev.step !== Step.USER_INPUT) line += `  ${c.grey(detail)}`;
    console.log(line);
  };
}

function makeApproval(rl) {
  return async (req) => {
    if (req.toolName === "write_file") {
      console.log(panel(renderDiff(req.diff || "(변경 미리보기 없음)"), {
        title: `🔐 파일 수정 제안 — ${req.path}`,
        color: "yellow",
      }));
    } else if (req.toolName === "run_shell") {
      console.log(panel([req.command], { title: "🔐 셸 실행 제안", color: "red" }));
    } else {
      console.log(panel([JSON.stringify(req.args)], { title: `🔐 ${req.toolLabel}`, color: "yellow" }));
    }
    let ans = "";
    try {
      ans = (await rl.question(c.yellow("이 작업을 승인하시겠습니까? [y/N] "))).trim().toLowerCase();
    } catch {
      ans = "";
    }
    const approved = ans === "y" || ans === "yes";
    return { approved, reason: approved ? "" : "사용자가 거부했습니다." };
  };
}

function printIntro(cfg) {
  console.log(renderBanner());
  console.log(c.dim("좁은 의미의 하네스를 터미널에서 체험하는 미니 AI 에이전트 런타임"));
  console.log();
  const rows = [
    ["버전", `v${VERSION}`],
    ["provider", cfg.provider],
    ["model", cfg.model],
    ["작업 폴더", cfg.workspacePath()],
    ["승인 모드", cfg.approval_mode],
    ["셸 실행", cfg.allow_shell ? "허용" : "차단"],
  ];
  const lines = rows.map(([k, v]) => `${c.grey(k)}   ${c.bold(v)}`);
  console.log(panel(lines, { title: "⚙️  CDSA Harness 설정", color: "cyan" }));
  console.log(
    c.dim("명령: ") +
      `${c.cyan("/help")} 도움말 · ${c.cyan("/reset")} 새 대화 · ${c.cyan("/config")} 설정값 · ${c.cyan("/quit")} 종료\n`
  );
}

function printHelp() {
  console.log(
    panel(
      [
        c.bold("사용법"),
        `그냥 시키고 싶은 일을 입력하면 됩니다. 예) ${c.cyan("notes.txt 맨 아래에 할 일 3개 추가해줘")}`,
        "",
        c.bold("슬래시 명령"),
        `  ${c.cyan("/help")}     이 도움말`,
        `  ${c.cyan("/reset")}    대화/컨텍스트 초기화(새 세션)`,
        `  ${c.cyan("/config")}   현재 설정값과 config.json 경로`,
        `  ${c.cyan("/sessions")} 세션 로그 폴더 경로`,
        `  ${c.cyan("/quit")}     종료 (Ctrl+D 도 가능)`,
        "",
        c.bold("하네스 흐름 (각 단계가 색으로 표시됩니다)"),
        "  입력 → 컨텍스트 구성 → LLM 호출 → 도구 판단 → 승인 → 실행 → 결과 반영 → 반복",
      ],
      { title: "도움말", color: "cyan" }
    )
  );
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--workspace") out.workspace = argv[++i];
    else out._.push(a);
  }
  return out;
}

export async function main(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "CDSA Harness — 미니 AI 에이전트 하네스 (터미널)\n\n" +
        "사용법: cdsa-harness [옵션]\n" +
        "  --provider <openai|openrouter|mock>\n" +
        "  --model <모델명>\n" +
        "  --workspace <폴더경로>\n" +
        "  --auto                 승인 자동(approval_mode=auto)\n" +
        "  -h, --help             도움말\n"
    );
    return 0;
  }

  const cfg = loadConfig();
  if (args.provider) cfg.provider = args.provider;
  if (args.model) cfg.model = args.model;
  if (args.workspace) cfg.workspace = args.workspace;
  if (args.auto) cfg.approval_mode = "auto";

  if (!cfg.isReady()) {
    console.log(
      c.yellow("API Key 가 없어 mock 모드로 실행합니다. ") +
        `실제 LLM 을 쓰려면 ${configPath()} 에 provider/api_key 를 설정하세요.\n`
    );
    cfg.provider = "mock";
    cfg.model = "mock-agent";
  }

  printIntro(cfg);

  const client = new LLMClient({
    provider: cfg.provider,
    apiKey: cfg.api_key,
    model: cfg.model,
    temperature: cfg.temperature,
  });
  const toolbox = new Toolbox(cfg.workspacePath(), cfg.allow_shell);
  const session = SessionLog.create();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const loop = new AgentLoop({
    config: cfg,
    client,
    toolbox,
    onEvent: makePrinter(),
    approvalCallback: makeApproval(rl),
    session,
  });
  loop.reset();

  const rule = () => console.log(c.grey("─".repeat(Math.min(80, stdout.columns || 80))));

  while (true) {
    let user;
    try {
      user = (await rl.question(c.bold(c.cyan("› ")))).trim();
    } catch {
      break; // Ctrl+D / 스트림 종료
    }
    if (!user) continue;
    const low = user.toLowerCase();
    if (["/quit", "/exit", "quit", "exit", ":q"].includes(low)) break;
    if (low === "/help") {
      printHelp();
      continue;
    }
    if (low === "/reset") {
      loop.reset();
      console.log(c.green("컨텍스트를 초기화했습니다(새 세션)."));
      continue;
    }
    if (low === "/config") {
      printIntro(cfg);
      console.log(c.dim(`config.json: ${configPath()}`));
      continue;
    }
    if (low === "/sessions") {
      console.log(c.dim(`세션 로그 폴더: ${sessionsDir()}`));
      continue;
    }

    rule();
    try {
      await loop.run(user);
    } catch (e) {
      console.log(c.red(`실행 오류: ${e?.message || e}`));
    }
    rule();
  }

  rl.close();
  session.close();
  console.log(c.dim("\n종료합니다. 안녕히 가세요!"));
  return 0;
}
