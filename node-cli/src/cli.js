// CDSA Harness TUI 본체 — 터미널 REPL.
// 핵심 차별점: '교육 모드' — 실제 API 를 붙여도 에이전트 내부에서 벌어지는 일
// (컨텍스트 구성 → API 요청 → 모델 판단 → 토큰/지연 → 도구 실행 → 결과 되먹임)을 단계별로 드러낸다.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { renderBanner } from "./banner.js";
import {
  ENV_KEYS,
  PROVIDERS,
  SUGGESTED_MODELS,
  configPath,
  loadConfig,
  saveConfig,
} from "./config.js";
import { execFileSync } from "node:child_process";

import { AgentLoop, Step } from "./loop.js";
import { LLMClient } from "./llm.js";
import { connectMcpServers } from "./mcp.js";
import { discoverNpmExtensions, loadPlugins } from "./plugins.js";
import { SessionLog, sessionsDir } from "./session.js";
import { loadSkills, renderSkill } from "./skills.js";
import { Toolbox } from "./tools.js";
import { c, panel, renderDiff } from "./ui.js";

const VERSION = "0.2.0";

const STEP_STYLE = {
  [Step.USER_INPUT]: ["🧑", "cyan"],
  [Step.BUILD_CONTEXT]: ["🧱", "grey"],
  [Step.MODEL_CALL]: ["🧠", "magenta"],
  [Step.MODEL_REPLY]: ["🤖", "green"],
  [Step.TOOL_DECISION]: ["🤔", "yellow"],
  [Step.APPROVAL]: ["🔐", "yellow"],
  [Step.TOOL_RUN]: ["🔧", "blue"],
  [Step.TOOL_RESULT]: ["📄", "grey"],
  [Step.FEEDBACK]: ["↩️", "grey"],
  [Step.DONE]: ["✅", "green"],
  [Step.ERROR]: ["❌", "red"],
};

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + " …" : s;
}

// cfg.teach_mode 를 실행 중 토글할 수 있으므로 closure 로 cfg 를 잡아둔다.
function makePrinter(cfg) {
  return (ev) => {
    if (cfg.teach_mode) return printTeach(ev);
    return printCompact(ev);
  };
}

// ---- 교육(teach) 렌더: 내부 과정을 패널로 펼쳐 보여준다 ----
function printTeach(ev) {
  const d = ev.data || {};
  switch (ev.step) {
    case Step.USER_INPUT:
      console.log(`${c.cyan("🧑 ①")} ${c.bold("사용자 입력")}  ${c.grey(clip(ev.detail, 200))}`);
      return;

    case Step.BUILD_CONTEXT:
      console.log(`${c.grey("🧱")} ${c.dim(ev.detail)}`);
      return;

    case Step.MODEL_CALL: {
      const lines = [];
      lines.push(`${c.grey("provider/model")}  ${c.bold(`${d.provider} · ${d.model}`)}`);
      lines.push(c.grey(`모델에 보내는 메시지 ${d.messages?.length || 0}개 · 추정 ${d.estTokens} 토큰 · ${d.totalChars}자`));
      for (const m of d.messages || []) {
        const roleColor = m.role === "system" ? c.magenta : m.role === "user" ? c.cyan : m.role === "assistant" ? c.green : c.yellow;
        lines.push(`  ${roleColor(m.role.padEnd(9))} ${c.grey(`${m.chars}자${m.extra || ""}`)}`);
      }
      lines.push(c.grey(`제공 도구(${d.tools?.length || 0}): ${(d.tools || []).join(", ")}`));
      console.log(panel(lines, { title: `🧠 ② LLM 호출 — 반복 ${d.iteration}`, color: "magenta" }));
      if (d.systemPrompt) {
        console.log(panel(clip(d.systemPrompt, 600).split("\n"), {
          title: "📜 시스템 프롬프트 (규칙+폴더가 여기 주입됨)",
          color: "grey",
        }));
      }
      return;
    }

    case Step.MODEL_REPLY: {
      const lines = [];
      if (ev.detail && ev.detail !== "(텍스트 없음)") lines.push(...clip(ev.detail, 1200).split("\n"));
      for (const tc of d.toolCalls || []) {
        lines.push(c.yellow(`↳ 도구 호출 요청: ${c.bold(tc.name)}(${clip(JSON.stringify(tc.args), 200)})`));
      }
      const meta = [];
      if (d.latencyMs != null) meta.push(`응답 ${d.latencyMs}ms`);
      if (d.usage) meta.push(`토큰 입력 ${d.usage.input ?? "?"}/출력 ${d.usage.output ?? "?"}/합계 ${d.usage.total ?? "?"}`);
      if (d.request?.bodyBytes) meta.push(`요청 ${d.request.bodyBytes}B`);
      if (meta.length) lines.push(c.grey("─ " + meta.join(" · ")));
      else lines.push(c.dim("(mock: 토큰/지연 측정 없음)"));
      console.log(panel(lines.length ? lines : ["(빈 응답)"], { title: "🤖 ③ 모델 응답 (원본 판단)", color: "green" }));
      return;
    }

    case Step.TOOL_DECISION:
      console.log(`${c.yellow("🤔 ④")} ${c.bold("도구 판단")}  ${c.grey(clip(ev.detail, 200))}`);
      return;

    case Step.TOOL_RUN:
      console.log(`${c.blue("🔧 ⑤")} ${c.bold(ev.title)}  ${c.grey(clip(ev.detail, 200))}`);
      return;

    case Step.TOOL_RESULT:
      console.log(panel(clip(ev.detail, 1500).split("\n"), { title: `📄 ${ev.title}`, color: "grey" }));
      return;

    case Step.FEEDBACK:
      console.log(`${c.grey("↩️  ⑥ 결과 되먹임")}  ${c.dim(clip(ev.detail, 200))}`);
      console.log(c.dim("   └ 도구 결과가 컨텍스트에 더해진 채로 ②부터 다시 — 이 반복이 'Agent Loop' 입니다."));
      return;

    case Step.APPROVAL:
      if (ev.title.includes("자동 승인")) console.log(`${c.yellow("🔓")} ${c.dim(ev.title)}`);
      return;

    case Step.DONE:
      console.log(panel((ev.detail || "완료").split("\n"), { title: "✅ 완료", color: "green" }));
      return;

    case Step.ERROR:
      console.log(panel((ev.detail || "").split("\n"), { title: `❌ ${ev.title}`, color: "red" }));
      return;
  }
}

// ---- 간결(compact) 렌더: 한 줄 위주 ----
function printCompact(ev) {
  const [icon, color] = STEP_STYLE[ev.step] || ["•", "cyan"];
  const paint = c[color] || ((x) => x);
  if (ev.step === Step.APPROVAL && !ev.title.includes("자동 승인")) return;
  if (ev.step === Step.MODEL_REPLY) {
    if (ev.detail && ev.detail !== "(텍스트 없음)") console.log(panel(ev.detail.split("\n"), { title: "🤖 모델", color: "green" }));
    return;
  }
  if (ev.step === Step.DONE) return console.log(panel((ev.detail || "완료").split("\n"), { title: "✅ 완료", color: "green" }));
  if (ev.step === Step.ERROR) return console.log(panel((ev.detail || "").split("\n"), { title: `❌ ${ev.title}`, color: "red" }));
  if (ev.step === Step.FEEDBACK) return;
  let detail = clip((ev.detail || "").trim().replace(/\s+/g, " "), 110);
  let line = `${paint(icon)} ${paint(c.bold(ev.title))}`;
  if (detail && ev.step !== Step.USER_INPUT) line += `  ${c.grey(detail)}`;
  console.log(line);
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

function makeClient(cfg) {
  return new LLMClient({
    provider: cfg.provider,
    apiKey: cfg.resolvedKey(),
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.max_tokens,
  });
}

function printIntro(cfg) {
  console.log(renderBanner());
  console.log(c.dim("AI 에이전트의 내부 동작을 단계별로 드러내는 교육용 하네스"));
  console.log();
  const keySource = cfg.provider === "mock" ? "-" : cfg.api_key ? "config.json" : ENV_KEYS[cfg.provider] && process.env[ENV_KEYS[cfg.provider]] ? `환경변수 ${ENV_KEYS[cfg.provider]}` : c.red("없음");
  const rows = [
    ["버전", `v${VERSION}`],
    ["provider", cfg.provider],
    ["model", cfg.model],
    ["API 키", keySource],
    ["교육 모드", cfg.teach_mode ? c.green("ON (과정 펼쳐보기)") : "OFF"],
    ["작업 폴더", cfg.workspacePath()],
    ["승인 모드", cfg.approval_mode],
    ["셸 실행", cfg.allow_shell ? "허용" : "차단"],
  ];
  const lines = rows.map(([k, v]) => `${c.grey(k.padEnd(9))}  ${c.bold(v)}`);
  console.log(panel(lines, { title: "⚙️  CDSA Harness 설정", color: "cyan" }));
  console.log(
    c.dim("명령: ") +
      `${c.cyan("/setup")} 연결 · ${c.cyan("/teach")} 교육모드 · ${c.cyan("/context")} 컨텍스트 · ${c.cyan("/help")} 도움말 · ${c.cyan("/quit")} 종료\n`
  );
}

function printHelp() {
  console.log(
    panel(
      [
        c.bold("사용법"),
        `시키고 싶은 일을 한국어로 입력하세요. 예) ${c.cyan("notes.txt 맨 아래에 할 일 3개 추가해줘")}`,
        "",
        c.bold("슬래시 명령"),
        `  ${c.cyan("/setup")}    제공자·API 키·모델 연결(대화형)`,
        `  ${c.cyan("/provider")} <openai|anthropic|openrouter|mock> 제공자 변경`,
        `  ${c.cyan("/model")} <이름>   모델 변경`,
        `  ${c.cyan("/teach")}    교육 모드 켜기/끄기(내부 과정 펼쳐보기)`,
        `  ${c.cyan("/context")}  지금 모델에 보내는 컨텍스트 들여다보기`,
        `  ${c.cyan("/skills")}   스킬 목록(.cdsa/skills 의 /명령들)`,
        `  ${c.cyan("/plugins")}  플러그인 목록(파일·npm 추가 도구)`,
        `  ${c.cyan("/mcp")}      연결된 MCP 서버/도구(다른 에이전트와 공용)`,
        `  ${c.cyan("/reset")}    대화/컨텍스트 초기화`,
        `  ${c.cyan("/config")}   현재 설정값`,
        `  ${c.cyan("/quit")}     종료 (Ctrl+D)`,
        "",
        c.bold("교육 모드에서 보이는 단계"),
        "  ① 입력 → ② LLM 호출(컨텍스트·도구) → ③ 모델 응답(토큰·지연) →",
        "  ④ 도구 판단 → ⑤ 실행/승인 → ⑥ 결과 되먹임 → (반복)",
      ],
      { title: "도움말", color: "cyan" }
    )
  );
}

// 대화형 연결 설정. 키는 환경변수가 있으면 그걸 우선 안내(파일 저장 안 함).
async function runSetup(rl, cfg) {
  console.log(panel(
    [
      "어떤 AI 에 연결할까요? 번호를 입력하세요.",
      `  ${c.bold("1")}) openai      (GPT, 키: ${ENV_KEYS.openai})`,
      `  ${c.bold("2")}) anthropic   (Claude, 키: ${ENV_KEYS.anthropic})`,
      `  ${c.bold("3")}) openrouter  (여러 모델 중계, 키: ${ENV_KEYS.openrouter})`,
      `  ${c.bold("4")}) mock        (키 없이 연습)`,
    ],
    { title: "🔌 연결 설정 (/setup)", color: "cyan" }
  ));
  const pick = (await rl.question(c.cyan("제공자 번호 [1-4]: "))).trim();
  const provider = { "1": "openai", "2": "anthropic", "3": "openrouter", "4": "mock" }[pick];
  if (!provider) {
    console.log(c.yellow("취소했습니다."));
    return false;
  }
  cfg.provider = provider;

  if (provider === "mock") {
    cfg.model = "mock-agent";
  } else {
    const envName = ENV_KEYS[provider];
    const envVal = (process.env[envName] || "").trim();
    if (envVal) {
      const useEnv = (await rl.question(c.cyan(`환경변수 ${envName} 에서 키를 찾았어요. 사용할까요? [Y/n] `))).trim().toLowerCase();
      if (useEnv === "" || useEnv === "y" || useEnv === "yes") {
        cfg.api_key = ""; // 환경변수 사용 → 파일엔 저장 안 함
      } else {
        const k = (await rl.question(c.cyan("API 키 붙여넣기(입력이 보일 수 있음): "))).trim();
        cfg.api_key = k;
      }
    } else {
      console.log(c.dim(`(또는 종료 후 환경변수 ${envName} 에 키를 넣어두면 파일에 저장하지 않아도 됩니다)`));
      const k = (await rl.question(c.cyan("API 키 붙여넣기(입력이 보일 수 있음): "))).trim();
      cfg.api_key = k;
    }
    const sugg = SUGGESTED_MODELS[provider] || [];
    const def = sugg[0] || "";
    const m = (await rl.question(c.cyan(`모델 [${def}] (추천: ${sugg.join(", ")}): `))).trim();
    cfg.model = m || def;
  }

  const saved = saveConfig(cfg);
  console.log(c.green(`설정을 저장했습니다 → ${saved}`));
  if (!cfg.isReady()) console.log(c.yellow("⚠️ 아직 키가 없어 호출이 실패할 수 있어요. 환경변수나 /setup 으로 키를 넣어주세요."));
  return true;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--setup") out.setup = true;
    else if (a === "--no-teach") out.noTeach = true;
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
      "CDSA Harness — AI 에이전트 내부를 드러내는 교육용 하네스 (터미널)\n\n" +
        "사용법: cdsa-harness [옵션]\n" +
        "       cdsa-harness add <npm-패키지>   플러그인 설치(이후 자동 로드)\n" +
        "  --provider <openai|anthropic|openrouter|mock>\n" +
        "  --model <모델명>\n" +
        "  --workspace <폴더경로>\n" +
        "  --setup                대화형 연결 설정 실행\n" +
        "  --no-teach             교육 모드 끄고 간결하게\n" +
        "  --auto                 승인 자동(approval_mode=auto)\n" +
        "  -h, --help             도움말\n\n" +
        "API 키는 환경변수로도 인식됩니다: OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY\n"
    );
    return 0;
  }

  // `cdsa-harness add <패키지>` — 플러그인을 npm 으로 설치(이후 자동 로드).
  if (args._[0] === "add" || args._[0] === "install") {
    const pkgs = args._.slice(1);
    if (!pkgs.length) {
      console.log("사용법: cdsa-harness add <npm-패키지...>   예) cdsa-harness add cdsa-harness-plugin-git");
      return 1;
    }
    console.log(c.cyan(`npm install ${pkgs.join(" ")} ...`));
    try {
      execFileSync("npm", ["install", ...pkgs], { stdio: "inherit", cwd: process.cwd() });
      console.log(c.green("설치 완료. 다음 실행부터 플러그인이 자동으로 로드됩니다 (/plugins 로 확인)."));
      return 0;
    } catch (e) {
      console.log(c.red(`설치 실패: ${e.message}`));
      return 1;
    }
  }

  const cfg = loadConfig();
  if (args.provider) cfg.provider = args.provider;
  if (args.model) cfg.model = args.model;
  if (args.workspace) cfg.workspace = args.workspace;
  if (args.auto) cfg.approval_mode = "auto";
  if (args.noTeach) cfg.teach_mode = false;

  const rl = readline.createInterface({ input: stdin, output: stdout });

  if (args.setup) {
    await runSetup(rl, cfg);
  } else if (!cfg.isReady() && cfg.provider !== "mock") {
    console.log(c.yellow(`provider=${cfg.provider} 인데 API 키가 없습니다. 연결 설정을 시작합니다.\n`));
    await runSetup(rl, cfg);
  }

  printIntro(cfg);

  // 플러그인(추가 도구)·스킬(프롬프트 템플릿)을 불러온다:
  //   ① 파일: .cdsa/plugins · .cdsa/skills (작업폴더/홈)
  //   ② npm 패키지: cdsa-harness-plugin-* 자동 발견 + config.plugins 강제 로드
  const filePlugins = await loadPlugins(cfg.workspacePath());
  const npm = await discoverNpmExtensions(process.cwd(), cfg.plugins || []);
  // ③ MCP 서버(다른 에이전트와 공용 표준)의 도구도 플러그인처럼 등록
  let mcp = { tools: [], servers: [], errors: [], closeAll: () => {} };
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    process.stdout.write(c.dim("MCP 서버 연결 중...\r"));
    mcp = await connectMcpServers(cfg.mcpServers);
  }
  const plugins = [
    ...filePlugins,
    ...npm.plugins,
    ...mcp.tools,
    ...npm.errors.map((e) => ({ error: e })),
    ...mcp.errors.map((e) => ({ error: `MCP ${e}` })),
  ];
  const skills = {};
  for (const s of npm.skills) skills[s.name] = { name: s.name, description: s.description || "", body: s.body, source: "(npm)" };
  Object.assign(skills, loadSkills(cfg.workspacePath())); // 로컬 파일 스킬이 우선
  const toolbox = new Toolbox(cfg.workspacePath(), cfg.allow_shell, plugins);
  if (toolbox.plugins.length || Object.keys(skills).length || toolbox.pluginErrors.length || mcp.servers.length) {
    const bits = [];
    if (toolbox.plugins.length) bits.push(c.green(`도구 +${toolbox.plugins.length}개`));
    if (mcp.servers.length) bits.push(c.green(`MCP ${mcp.servers.length}개`) + c.grey(` (${mcp.servers.map((s) => s.name).join(", ")})`));
    if (Object.keys(skills).length) bits.push(c.green(`스킬 ${Object.keys(skills).length}개`));
    if (toolbox.pluginErrors.length) bits.push(c.red(`오류 ${toolbox.pluginErrors.length}개`));
    console.log("🔌 " + bits.join(" · ") + c.dim("  (/plugins /skills /mcp 로 상세)") + "\n");
  }

  const session = SessionLog.create();
  const loop = new AgentLoop({
    config: cfg,
    client: makeClient(cfg),
    toolbox,
    onEvent: makePrinter(cfg),
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
      break;
    }
    if (!user) continue;
    const low = user.toLowerCase();

    if (["/quit", "/exit", "quit", "exit", ":q"].includes(low)) break;
    if (low === "/help") { printHelp(); continue; }
    if (low === "/reset") { loop.reset(); console.log(c.green("컨텍스트를 초기화했습니다.")); continue; }
    if (low === "/config") { printIntro(cfg); console.log(c.dim(`config.json: ${configPath()}`)); continue; }
    if (low === "/sessions") { console.log(c.dim(`세션 로그: ${sessionsDir()}`)); continue; }
    if (low === "/teach") {
      cfg.teach_mode = !cfg.teach_mode;
      console.log(c.green(`교육 모드 ${cfg.teach_mode ? "ON" : "OFF"}.`));
      continue;
    }
    if (low === "/setup" || low === "/login") {
      await runSetup(rl, cfg);
      loop.client = makeClient(cfg);
      loop.reset();
      continue;
    }
    if (low.startsWith("/provider")) {
      const p = user.split(/\s+/)[1];
      if (!PROVIDERS.includes(p)) { console.log(c.yellow(`provider 는 ${PROVIDERS.join("/")} 중 하나.`)); continue; }
      cfg.provider = p;
      if (SUGGESTED_MODELS[p]?.length) cfg.model = SUGGESTED_MODELS[p][0];
      loop.client = makeClient(cfg);
      loop.reset();
      console.log(c.green(`provider=${p}, model=${cfg.model} (키: ${cfg.isReady() ? "OK" : c.red("없음 — /setup")})`));
      continue;
    }
    if (low.startsWith("/model")) {
      const m = user.split(/\s+/).slice(1).join(" ").trim();
      if (!m) { console.log(c.dim(`현재 모델: ${cfg.model} · 추천: ${(SUGGESTED_MODELS[cfg.provider] || []).join(", ")}`)); continue; }
      cfg.model = m;
      loop.client = makeClient(cfg);
      console.log(c.green(`model=${m}`));
      continue;
    }
    if (low === "/context") {
      const ctx = loop.contextSummary();
      const lines = [c.grey(`메시지 ${ctx.rows.length}개 · 추정 ${ctx.estTokens} 토큰 · ${ctx.totalChars}자`)];
      for (const m of ctx.rows) lines.push(`  ${c.bold(m.role.padEnd(9))} ${c.grey(`${m.chars}자${m.extra || ""}`)}`);
      console.log(panel(lines, { title: "🧩 현재 컨텍스트(다음 호출에 전송됨)", color: "magenta" }));
      console.log(panel(clip(ctx.systemPrompt, 800).split("\n"), { title: "📜 시스템 프롬프트", color: "grey" }));
      continue;
    }
    if (low === "/plugins") {
      const lines = [];
      if (!toolbox.plugins.length) lines.push(c.dim("등록된 플러그인이 없습니다."));
      for (const p of toolbox.plugins) {
        const src = p.source && p.source.includes("/") ? "📄 " + p.source.split("/").slice(-1)[0] : "📦 " + (p.source || "npm");
        lines.push(`${c.bold(p.name)}${p.mutating ? c.yellow(" (승인필요)") : ""}  ${c.grey(p.description || "")} ${c.dim(src)}`);
      }
      for (const e of toolbox.pluginErrors) lines.push(c.red("✖ " + e));
      lines.push(c.dim("추가: npm 패키지 'cdsa-harness-plugin-*' 설치 → 자동 로드 (cdsa-harness add <pkg>)"));
      lines.push(c.dim("또는: <작업폴더>/.cdsa/plugins/ 에 .js/.mjs 파일"));
      console.log(panel(lines, { title: "🔌 플러그인 (모델이 쓸 수 있는 추가 도구)", color: "blue" }));
      continue;
    }
    if (low === "/mcp") {
      const lines = [];
      if (!mcp.servers.length) lines.push(c.dim("연결된 MCP 서버가 없습니다."));
      for (const s of mcp.servers) lines.push(`${c.bold(s.name)}  ${c.grey(`도구 ${s.count}개`)}`);
      for (const t of mcp.tools) lines.push(`  ${c.cyan(t.name)}  ${c.grey(clip(t.description, 60))}`);
      for (const e of mcp.errors) lines.push(c.red("✖ " + e));
      lines.push(c.dim('설정: config.json 의 "mcpServers" (Claude Code/Cursor 와 동일 형식)'));
      console.log(panel(lines, { title: "🔗 MCP 서버 (다른 에이전트와 공용)", color: "blue" }));
      continue;
    }
    if (low === "/skills") {
      const names = Object.keys(skills);
      const lines = names.length ? names.map((n) => `${c.cyan("/" + n)}  ${c.grey(skills[n].description || "")}`) : [c.dim("등록된 스킬이 없습니다.")];
      lines.push(c.dim("위치: <작업폴더>/.cdsa/skills/ 또는 ~/.cdsa_harness/skills/ (.md). 본문의 $ARGUMENTS 치환."));
      console.log(panel(lines, { title: "🎯 스킬 (프롬프트 템플릿, /이름 으로 실행)", color: "cyan" }));
      continue;
    }

    // 위 내장 명령에 안 걸린 '/...' → 스킬이면 실행, 아니면 안내.
    if (user.startsWith("/")) {
      const name = low.slice(1).split(/\s+/)[0];
      if (skills[name]) {
        const argStr = user.split(/\s+/).slice(1).join(" ");
        console.log(c.dim(`(스킬 '/${name}' 실행)`));
        rule();
        try {
          await loop.run(renderSkill(skills[name], argStr));
        } catch (e) {
          console.log(c.red(`실행 오류: ${e?.message || e}`));
        }
        rule();
      } else {
        console.log(c.yellow(`알 수 없는 명령/스킬: /${name} — ${c.cyan("/help")}, ${c.cyan("/skills")} 참고`));
      }
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
  mcp.closeAll();
  console.log(c.dim("\n종료합니다. 안녕히 가세요!"));
  return 0;
}
