// CDSA Harness TUI 본체 — 터미널 REPL.
// 핵심 차별점: '교육 모드' — 실제 API 를 붙여도 에이전트 내부에서 벌어지는 일
// (컨텍스트 구성 → API 요청 → 모델 판단 → 토큰/지연 → 도구 실행 → 결과 되먹임)을 단계별로 드러낸다.
import fs from "node:fs";
import readline from "node:readline/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";

import { renderBanner } from "./banner.js";
import { VERSION } from "./builtins.js";
import {
  ENV_KEYS,
  PROVIDERS,
  SUGGESTED_MODELS,
  configDir,
  configPath,
  loadConfig,
  saveConfig,
} from "./config.js";
import { execFileSync, execSync } from "node:child_process";

import { AgentLoop, Step } from "./loop.js";
import { LLMClient } from "./llm.js";
import { connectMcpServers } from "./mcp.js";
import { discoverNpmExtensions, loadPlugins } from "./plugins.js";
import { SessionLog, sessionsDir } from "./session.js";
import { loadSkills, renderSkill } from "./skills.js";
import { Toolbox } from "./tools.js";
import { c, panel, renderDiff, renderMarkdown, setColor } from "./ui.js";
import { makeCompleter } from "./completion.js";

// VERSION 은 src/builtins.js(생성물)에서 가져온다 — npm/exe 양쪽에서 동일.

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
// stream.active 는 onToken 과 공유하는 스트리밍 상태.
function makePrinter(cfg, stream) {
  return (ev) => {
    if (cfg.teach_mode) return printTeach(ev, stream);
    return printCompact(ev, stream);
  };
}

function replyMetaLine(d) {
  const meta = [];
  if (d.latencyMs != null) meta.push(`응답 ${d.latencyMs}ms`);
  if (d.usage) meta.push(`토큰 입력 ${d.usage.input ?? "?"}/출력 ${d.usage.output ?? "?"}/합계 ${d.usage.total ?? "?"}`);
  if (d.request?.bodyBytes) meta.push(`요청 ${d.request.bodyBytes}B`);
  return meta.length ? meta.join(" · ") : "";
}

// ---- 교육(teach) 렌더: 내부 과정을 패널로 펼쳐 보여준다 ----
function printTeach(ev, stream) {
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
      console.log(panel(lines, { title: `${d.sub ? "┆ " : ""}🧠 ② LLM 호출 — 반복 ${d.iteration}`, color: "magenta" }));
      if (d.systemPrompt && !d.sub) {
        console.log(panel(clip(d.systemPrompt, 600).split("\n"), {
          title: "📜 시스템 프롬프트 (규칙+폴더가 여기 주입됨)",
          color: "grey",
        }));
      }
      return;
    }

    case Step.MODEL_REPLY: {
      // 스트리밍으로 이미 본문이 출력된 경우: 줄바꿈 후 메타/도구호출만 덧붙인다.
      if (d.streamed) {
        if (stream && stream.active) {
          process.stdout.write("\n");
          stream.active = false;
        }
        for (const tc of d.toolCalls || []) {
          console.log(c.yellow(`  ↳ 도구 호출 요청: ${c.bold(tc.name)}(${clip(JSON.stringify(tc.args), 200)})`));
        }
        const meta = replyMetaLine(d);
        if (meta) console.log(c.grey("  ─ " + meta));
        return;
      }
      const lines = [];
      if (ev.detail && ev.detail !== "(텍스트 없음)") lines.push(...renderMarkdown(clip(ev.detail, 1200)));
      for (const tc of d.toolCalls || []) {
        lines.push(c.yellow(`↳ 도구 호출 요청: ${c.bold(tc.name)}(${clip(JSON.stringify(tc.args), 200)})`));
      }
      const meta = replyMetaLine(d);
      if (meta) lines.push(c.grey("─ " + meta));
      else lines.push(c.dim("(mock: 토큰/지연 측정 없음)"));
      console.log(panel(lines.length ? lines : ["(빈 응답)"], { title: `${d.sub ? "┆ " : ""}🤖 ③ 모델 응답 (원본 판단)`, color: "green" }));
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
      if (d.sub) { console.log(c.grey("┆ ") + c.green("✅ 서브에이전트 완료")); return; }
      console.log(panel(renderMarkdown(ev.detail || "완료"), { title: "✅ 완료", color: "green" }));
      return;

    case Step.ERROR:
      console.log(panel((ev.detail || "").split("\n"), { title: `❌ ${ev.title}`, color: "red" }));
      return;
  }
}

// ---- 간결(compact) 렌더: 한 줄 위주 ----
function printCompact(ev, stream) {
  const [icon, color] = STEP_STYLE[ev.step] || ["•", "cyan"];
  const paint = c[color] || ((x) => x);
  if (ev.step === Step.APPROVAL && !ev.title.includes("자동 승인")) return;
  if (ev.step === Step.MODEL_REPLY) {
    const d = ev.data || {};
    if (d.streamed) {
      if (stream && stream.active) { process.stdout.write("\n"); stream.active = false; }
      for (const tc of d.toolCalls || []) console.log(c.yellow(`  ↳ ${tc.name}(${clip(JSON.stringify(tc.args), 120)})`));
      return;
    }
    if (ev.detail && ev.detail !== "(텍스트 없음)") console.log(panel(renderMarkdown(ev.detail), { title: `${d.sub ? "┆ " : ""}🤖 모델`, color: "green" }));
    return;
  }
  if (ev.step === Step.DONE) {
    if (ev.data && ev.data.sub) return console.log(c.grey("┆ ") + c.green("✅ 서브에이전트 완료"));
    return console.log(panel(renderMarkdown(ev.detail || "완료"), { title: "✅ 완료", color: "green" }));
  }
  if (ev.step === Step.ERROR) return console.log(panel((ev.detail || "").split("\n"), { title: `❌ ${ev.title}`, color: "red" }));
  if (ev.step === Step.FEEDBACK) return;
  let detail = clip((ev.detail || "").trim().replace(/\s+/g, " "), 110);
  let line = `${paint(icon)} ${paint(c.bold(ev.title))}`;
  if (detail && ev.step !== Step.USER_INPUT) line += `  ${c.grey(detail)}`;
  console.log(line);
}

function makeApproval(ask, cfg) {
  let streak = 0; // 연속 승인 횟수 — 신뢰가 쌓이면 자동 수락을 제안한다
  let hinted = false;
  return async (req) => {
    if (req.toolName === "write_file" || req.toolName === "edit_file") {
      const label = req.toolName === "edit_file" ? "부분 수정 제안" : "파일 쓰기 제안";
      console.log(panel(renderDiff(req.diff || "(변경 미리보기 없음)"), {
        title: `🔐 ${label} — ${req.path}`,
        color: "yellow",
      }));
    } else if (req.toolName === "run_shell") {
      console.log(panel([req.command], { title: "🔐 셸 실행 제안", color: "red" }));
    } else {
      console.log(panel([JSON.stringify(req.args)], { title: `🔐 ${req.toolLabel}`, color: "yellow" }));
    }
    const raw = await ask(c.yellow("승인할까요? ") + c.green("[y=승인") + c.yellow(" / n=거부 / ") + c.cyan("a=승인+이후 자동수락]") + " ");
    const ans = (raw || "").trim().toLowerCase();
    if (ans === "a" || ans === "always") {
      cfg.approval_mode = "auto";
      console.log(c.green("✅ 승인 + 자동 수락 ON — 이후엔 묻지 않아요. (해제: /auto)"));
      return { approved: true, reason: "" };
    }
    const approved = ans === "y" || ans === "yes";
    if (!approved) {
      console.log(c.yellow("→ 거부로 처리했어요.") + c.dim("  (엔터는 거부예요 — 승인은 y, 항상 승인은 a 또는 /auto)"));
    }
    streak = approved ? streak + 1 : 0;
    if (approved && streak >= 3 && !hinted && cfg.approval_mode === "manual") {
      hinted = true;
      console.log(c.dim("💡 계속 승인 중이시네요 — 신뢰가 쌓였다면 ") + c.cyan("/auto") + c.dim(" 로 자동 수락을 켤 수 있어요."));
    }
    return { approved, reason: approved ? "" : "사용자가 거부했습니다." };
  };
}

function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// 시작 시 새 버전 확인(하루 1회, 네트워크 실패는 조용히 무시 → 폐쇄망 안전).
async function maybeCheckUpdate(cfg) {
  if (cfg.update_check === false) return null;
  const stamp = path.join(configDir(), ".update_check");
  try {
    if (Date.now() - Number(fs.readFileSync(stamp, "utf8")) < 24 * 3600 * 1000) return null;
  } catch {
    /* 첫 확인 */
  }
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(stamp, String(Date.now())); // 결과와 무관하게 하루 1회로 제한
  } catch {
    /* ignore */
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("https://registry.npmjs.org/cdsa-harness/latest", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const latest = (await res.json()).version;
    return latest && isNewer(latest, VERSION) ? latest : null;
  } catch {
    return null;
  }
}

// 작업 폴더 기준으로 플러그인·스킬·도구상자를 구성한다(시작 시 + /workspace 변경 시).
async function buildExtensions(cfg, mcp) {
  const filePlugins = await loadPlugins(cfg.workspacePath());
  const npm = await discoverNpmExtensions(process.cwd(), cfg.plugins || []);
  const plugins = [
    ...filePlugins,
    ...npm.plugins,
    ...mcp.tools,
    ...npm.errors.map((e) => ({ error: e })),
    ...mcp.errors.map((e) => ({ error: `MCP ${e}` })),
  ];
  const skills = {};
  for (const s of npm.skills) skills[s.name] = { name: s.name, description: s.description || "", hint: s.hint || "", body: s.body, source: "(npm)" };
  Object.assign(
    skills,
    loadSkills(cfg.workspacePath(), { importForeign: cfg.import_foreign_skills, extraDirs: cfg.skill_dirs || [] })
  ); // 로컬 파일 스킬이 우선
  const toolbox = new Toolbox(cfg.workspacePath(), cfg.allow_shell, plugins);
  return { toolbox, skills };
}

async function fetchJson(url, headers = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 제공자별 '쓸 수 있는 모델' 목록. 가능하면 실시간(live), 실패 시 추천 목록으로 폴백.
async function fetchProviderModels(cfg, query = "") {
  const q = query.trim().toLowerCase();
  const key = cfg.resolvedKey();
  try {
    if (cfg.provider === "openrouter") {
      const r = await fetchJson("https://openrouter.ai/api/v1/models");
      let ids = (r.data || []).map((m) => m.id).sort();
      if (q) ids = ids.filter((id) => id.toLowerCase().includes(q));
      return { list: ids, live: true };
    }
    if (cfg.provider === "ollama") {
      const host = (cfg.base_url || "http://localhost:11434/v1/chat/completions").replace(/\/v1\/.*$/, "");
      const r = await fetchJson(`${host}/api/tags`, {}, 2500);
      let ids = (r.models || []).map((m) => m.name);
      if (q) ids = ids.filter((id) => id.toLowerCase().includes(q));
      return { list: ids, live: true };
    }
    if (cfg.provider === "openai" && key) {
      const r = await fetchJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
      let ids = (r.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort();
      if (q) ids = ids.filter((id) => id.toLowerCase().includes(q));
      return { list: ids, live: true };
    }
    if (cfg.provider === "anthropic" && key) {
      const r = await fetchJson("https://api.anthropic.com/v1/models", { "x-api-key": key, "anthropic-version": "2023-06-01" });
      let ids = (r.data || []).map((m) => m.id);
      if (q) ids = ids.filter((id) => id.toLowerCase().includes(q));
      return { list: ids, live: true };
    }
  } catch { /* 폴백으로 */ }
  let list = SUGGESTED_MODELS[cfg.provider] || [];
  if (q) list = list.filter((m) => m.toLowerCase().includes(q));
  return { list, live: false };
}

// 번호로 고르는 모델 선택 UI. 선택하면 모델명, 취소하면 null 반환.
async function pickModel(ask, cfg, query = "") {
  process.stdout.write(c.dim("모델 목록을 불러오는 중…\r"));
  const { list, live } = await fetchProviderModels(cfg, query);
  if (!list.length) {
    console.log(c.yellow(`'${query}' 에 맞는 모델이 없습니다.`) + c.dim("  예: /models claude · /models gpt"));
    return null;
  }
  const shown = list.slice(0, 15);
  const lines = shown.map((m, i) => {
    const cur = m === cfg.model ? c.green(" ← 현재") : "";
    return `  ${c.bold(String(i + 1).padStart(2))}) ${m}${cur}`;
  });
  if (list.length > shown.length) lines.push(c.dim(`  … 외 ${list.length - shown.length}개 — '/models <검색어>' 로 좁히세요`));
  lines.push(c.dim(live ? "  (실시간 목록)" : "  (추천 목록 — 키 연결 시 실시간 조회)"));
  console.log(panel(lines, { title: `🤖 모델 선택 — ${cfg.provider}`, color: "cyan" }));
  const a = await ask(c.cyan("번호 또는 모델명 입력 (엔터=취소): "));
  if (a === null || !a.trim()) return null;
  const s = a.trim();
  const n = parseInt(s, 10);
  if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1];
  return s; // 직접 입력한 이름 허용
}

function makeClient(cfg) {
  return new LLMClient({
    provider: cfg.provider,
    apiKey: cfg.resolvedKey(),
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.max_tokens,
    baseUrl: cfg.base_url,
  });
}

function printIntro(cfg) {
  console.log(renderBanner());
  console.log(c.dim("AI 에이전트의 내부 동작을 단계별로 드러내는 교육용 하네스") + "  " + c.cyan("· made by CDSA"));
  console.log();
  const keySource =
    cfg.provider === "mock" ? "-"
    : cfg.provider === "ollama" ? "불필요(로컬)"
    : cfg.api_key ? "config.json"
    : ENV_KEYS[cfg.provider] && process.env[ENV_KEYS[cfg.provider]] ? `환경변수 ${ENV_KEYS[cfg.provider]}` : c.red("없음");
  const rows = [
    ["버전", `v${VERSION}`],
    ["provider", cfg.provider],
    ["model", cfg.model],
    ...(cfg.base_url ? [["엔드포인트", cfg.base_url]] : []),
    ["API 키", keySource],
    ["교육 모드", cfg.teach_mode ? c.green("ON (과정 펼쳐보기)") : "OFF"],
    ["스트리밍", cfg.stream ? c.green("ON (실시간)") : "OFF"],
    ["작업 폴더", cfg.workspacePath()],
    ["승인 모드", cfg.approval_mode],
    ["셸 실행", cfg.allow_shell ? "허용" : "차단"],
  ];
  const lines = rows.map(([k, v]) => `${c.grey(k.padEnd(9))}  ${c.bold(v)}`);
  console.log(panel(lines, { title: "⚙️  CDSA Harness 설정", color: "cyan" }));
  console.log(
    c.bold(c.cyan("👉 처음이세요?  /guide ")) + c.dim("· '/' 만 치면 명령 팔레트 · ") + c.cyan("Tab") + c.dim(" 키로 /명령·@파일 자동완성")
  );
  console.log(
    c.dim("명령: ") +
      `${c.cyan("/setup")} 연결 · ${c.cyan("/skills")} 명령목록 · ${c.cyan("/teach")} 교육모드 · ${c.cyan("/help")} 도움말 · ${c.cyan("/quit")} 종료\n`
  );
}

function printGuide() {
  console.log(
    panel(
      [
        c.bold("CDSA Harness 에 오신 걸 환영해요!") + c.dim("  AI 에게 일을 시키고, 그 과정을 눈으로 보는 도구예요."),
        "",
        c.bold("🚀 3단계면 끝"),
        `  ${c.cyan("1) AI 연결")}   ${c.bold("/setup")} 입력 → OpenAI·Claude·OpenRouter 중 선택 + 키 입력`,
        `              ${c.dim("키가 없어도 OK — 자동 '연습(mock)' 모드로 흐름을 체험할 수 있어요.")}`,
        `  ${c.cyan("2) 시키기")}    하고 싶은 일을 ${c.bold("한국어로 그냥 입력")}`,
        `              예) ${c.green("notes.txt 에 오늘 할 일 3개 추가해줘")}`,
        `  ${c.cyan("3) 승인")}      파일을 고칠 땐 ${c.bold("바뀔 내용(diff)")} 을 먼저 보여줘요 → ${c.green("y")} 누르면 적용`,
        "",
        c.bold("💡 알아두면 좋은 명령"),
        `  ${c.cyan("/skills")}    쓸 수 있는 명령 목록(민원분류·요약 등)`,
        `  ${c.cyan("/workspace")} 작업할 폴더 보기/바꾸기  (${c.dim("/workspace . = 지금 폴더")})`,
        `  ${c.cyan("/teach")}     AI 내부 동작 펼쳐보기 켜기/끄기`,
        `  ${c.cyan("/about")}     이 도구 정보 · ${c.cyan("/help")} 전체 도움말 · ${c.cyan("/quit")} 종료`,
        "",
        c.bold("🇰🇷 공공 업무 예시 (바로 써보기)"),
        `  ${c.green("/minwon")} (민원 내용 붙여넣기)   → 분류·담당부서·처리방향`,
        `  ${c.green("/gongmun")} 도서관 행사 안내       → 공문 기안 초안`,
        `  ${c.green("/privacy")} report.txt            → 개인정보 점검`,
        `  ${c.green("/hwpx")} 보고서.hwpx              → 한컴 문서 요약`,
        "",
        c.dim("막히면 언제든 /help 를 입력하세요. 즐겁게 써보세요! 😊"),
      ],
      { title: "📖 빠른 시작 가이드 (/guide)", color: "cyan" }
    )
  );
}

// 인터랙티브 튜토리얼 — 엔터로 한 페이지씩 진행(첫 실행 시 자동 제안).
async function runTutorial(ask) {
  const pages = [
    [
      "👋 환영합니다! CDSA Harness 가 처음이라면 이 튜토리얼이 딱이에요.",
      "",
      "이 도구는 'AI 에이전트'예요. 일을 시키면 AI 가 스스로 파일을 보고·읽고·고치며 일합니다.",
      "그 모든 과정을 화면에 단계별로 보여줘서, 보면서 배울 수 있어요.",
    ],
    [
      c.bold("1단계. AI 연결"),
      "",
      `${c.cyan("/setup")} 을 입력하면 OpenAI·Claude·OpenRouter 중 고르고 API 키를 넣어요.`,
      "키가 없어도 괜찮아요 — 자동 '연습(mock)' 모드로 흐름을 그대로 체험할 수 있어요.",
    ],
    [
      c.bold("2단계. 그냥 시키기"),
      "",
      "하고 싶은 일을 한국어로 입력하면 됩니다. 예를 들면:",
      `  ${c.green("notes.txt 에 오늘 할 일 3개 추가해줘")}`,
      `  ${c.green("이 폴더에 어떤 파일이 있는지 알려줘")}`,
    ],
    [
      c.bold("3단계. 승인 [y/N]"),
      "",
      "AI 가 파일을 고치려 하면, 바뀔 내용(diff)을 먼저 보여줍니다.",
      `${c.green("y")} 를 누르면 적용, ${c.red("n")} 이면 취소. → 위험한 일은 항상 사람이 확인해요(안전장치).`,
    ],
    [
      c.bold("알아두면 좋은 명령"),
      `  ${c.cyan("/guide")} 빠른 요약 · ${c.cyan("/skills")} 명령 목록 · ${c.cyan("/workspace")} 작업 폴더`,
      `  ${c.cyan("/teach")} 내부 펼쳐보기 · ${c.cyan("/help")} 전체 · ${c.cyan("/quit")} 종료`,
      "",
      c.bold("🇰🇷 공공 업무도 바로"),
      `  ${c.green("/minwon")} 민원분류 · ${c.green("/gongmun")} 공문 · ${c.green("/privacy")} 개인정보점검 · ${c.green("/hwpx")} 한컴요약`,
      "",
      c.dim("이제 끝! 직접 한번 시켜보세요. 막히면 /guide 또는 /help 를 입력하면 돼요 😊"),
    ],
  ];
  for (let i = 0; i < pages.length; i++) {
    console.log(panel(pages[i], { title: `📊 튜토리얼  (${i + 1}/${pages.length})`, color: "cyan" }));
    if (i < pages.length - 1) {
      const a = await ask(c.dim("  [엔터] 다음 · [q] 그만 "));
      if (a === null || a.trim().toLowerCase() === "q") {
        console.log(c.dim("튜토리얼을 건너뜁니다. 언제든 /tutorial 로 다시 볼 수 있어요."));
        return;
      }
    }
  }
}

function printHelp() {
  console.log(
    panel(
      [
        c.bold("사용법"),
        `시키고 싶은 일을 한국어로 입력하세요. 예) ${c.cyan("notes.txt 맨 아래에 할 일 3개 추가해줘")}`,
        `${c.cyan("@파일명")} 을 쓰면 그 파일 내용이 자동 첨부됩니다. 예) ${c.cyan("@memo.txt 이거 요약해줘")}`,
        "",
        c.bold("대화"),
        `  ${c.cyan("/new")}(=/clear)  새 대화 · ${c.cyan("/compact")} 대화를 모델이 요약해 압축 · ${c.cyan("/resume")} 지난 대화 이어가기`,
        `  ${c.cyan("/undo")}  마지막 파일 변경 되돌리기 · ${c.cyan("/context")} 모델에 보내는 컨텍스트 보기`,
        "",
        c.bold("프로젝트"),
        `  ${c.cyan("/init")}  모델이 폴더를 파악해 AGENT.md(프로젝트 규칙) 생성 · ${c.cyan("/memory")} 규칙 파일 보기`,
        `  ${c.cyan("/workspace")} <폴더>  작업 폴더 보기/변경 ('.' = 현재 폴더)`,
        "",
        c.bold("모델·설정"),
        `  ${c.cyan("/setup")} 연결 마법사 · ${c.cyan("/model")} <이름> 변경 · ${c.cyan("/models")} 목록(ollama 는 설치분) · ${c.cyan("/provider")} 전환`,
        `  ${c.cyan("/auto")} 자동 수락 토글 · ${c.cyan("/status")}(=/cost) 상태·누적 토큰 · ${c.cyan("/update")} 자기 업데이트`,
        `  ${c.cyan("/teach")} 내부과정 펼치기 · ${c.cyan("/stream")} 실시간 출력 · ${c.cyan("/color")} 색상`,
        "",
        c.bold("확장"),
        `  ${c.cyan("/skills")} 스킬 목록 · ${c.cyan("/plugins")} 플러그인 · ${c.cyan("/mcp")} MCP 서버`,
        "",
        c.bold("기타"),
        `  ${c.cyan("/guide")} 빠른 시작 · ${c.cyan("/tutorial")} 튜토리얼 · ${c.cyan("/about")} 정보 · ${c.cyan("/quit")} 종료(Ctrl+D)`,
        "",
        c.bold("교육 모드에서 보이는 단계"),
        "  ① 입력 → ② LLM 호출(컨텍스트·도구) → ③ 모델 응답(토큰·지연) →",
        "  ④ 도구 판단 → ⑤ 실행/승인 → ⑥ 결과 되먹임 → (반복)",
      ],
      { title: "도움말", color: "cyan" }
    )
  );
}

// 붙여넣기한 키에 섞이기 쉬운 따옴표/공백/줄바꿈을 정리.
function cleanKey(s) {
  return (s || "").trim().replace(/^["']|["']$/g, "").trim();
}

// 대화형 연결 설정. 키는 환경변수가 있으면 그걸 우선 안내(파일 저장 안 함).
// ask 가 null 을 주면(Ctrl+C) 조용히 취소.
async function runSetup(ask, cfg) {
  console.log(panel(
    [
      "어떤 AI 에 연결할까요? 번호를 입력하세요.",
      `  ${c.bold("1")}) openai      (GPT, 키: ${ENV_KEYS.openai})`,
      `  ${c.bold("2")}) anthropic   (Claude, 키: ${ENV_KEYS.anthropic})`,
      `  ${c.bold("3")}) openrouter  (여러 모델 중계, 키: ${ENV_KEYS.openrouter})`,
      `  ${c.bold("4")}) ollama      (로컬·폐쇄망 LLM, 키 불필요) 🏢`,
      `  ${c.bold("5")}) mock        (키 없이 연습)`,
    ],
    { title: "🔌 연결 설정 (/setup)", color: "cyan" }
  ));
  const pickRaw = await ask(c.cyan("제공자 번호 [1-5] (취소: Enter): "));
  if (pickRaw === null) return false;
  const provider = { "1": "openai", "2": "anthropic", "3": "openrouter", "4": "ollama", "5": "mock" }[pickRaw.trim()];
  if (!provider) {
    console.log(c.yellow("취소했습니다."));
    return false;
  }
  cfg.provider = provider;

  if (provider === "mock") {
    cfg.model = "mock-agent";
  } else if (provider === "ollama") {
    const hostAns = await ask(c.cyan("Ollama 주소 [http://localhost:11434]: "));
    if (hostAns === null) return false;
    const host = (hostAns.trim() || "http://localhost:11434").replace(/\/+$/, "");
    cfg.base_url = `${host}/v1/chat/completions`;
    cfg.api_key = "ollama"; // 로컬 LLM 은 키가 필요 없다(호환용 자리표시)
    // 설치된 모델 자동 감지(/api/tags) — 실패해도 조용히 추천 목록 사용
    let installed = [];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) installed = ((await res.json()).models || []).map((m) => m.name);
    } catch {
      console.log(c.yellow("  (Ollama 에 연결하지 못했어요 — `ollama serve` 실행 여부를 확인하세요. 계속 진행합니다.)"));
    }
    if (installed.length) console.log(c.green(`  설치된 모델: ${installed.slice(0, 8).join(", ")}`));
    const sugg = installed.length ? installed : SUGGESTED_MODELS.ollama;
    const def = sugg[0];
    const m = await ask(c.cyan(`모델 [${def}]: `));
    if (m === null) return false;
    cfg.model = m.trim() || def;
  } else {
    const envName = ENV_KEYS[provider];
    const envVal = (process.env[envName] || "").trim();
    let useExistingEnv = false;
    if (envVal) {
      const useEnv = (await ask(c.cyan(`환경변수 ${envName} 에서 키를 찾았어요. 사용할까요? [Y/n] `))) || "";
      useExistingEnv = ["", "y", "yes"].includes(useEnv.trim().toLowerCase());
    }
    if (useExistingEnv) {
      cfg.api_key = ""; // 환경변수 사용 → 파일엔 저장 안 함
    } else {
      if (!envVal) console.log(c.dim(`(또는 종료 후 환경변수 ${envName} 에 키를 넣어두면 파일에 저장하지 않아도 됩니다)`));
      const k = await ask(c.cyan("API 키 붙여넣기(붙여넣기 후 Enter): "));
      if (k === null) {
        console.log(c.yellow("취소했습니다."));
        return false;
      }
      cfg.api_key = cleanKey(k);
    }
    const sugg = SUGGESTED_MODELS[provider] || [];
    const def = sugg[0] || "";
    const picked = await pickModel(ask, cfg); // 실시간 목록에서 번호로 선택
    cfg.model = picked || def;
    if (!picked) console.log(c.dim(`기본 모델 사용: ${def}`));
  }

  const saved = saveConfig(cfg);
  console.log(c.green(`설정을 저장했습니다 → ${saved}`));
  console.log(c.dim(`provider=${cfg.provider} · model=${cfg.model}`));
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
    else if (a === "--no-stream") out.noStream = true;
    else if (a === "--no-color") out.noColor = true;
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
        "  --provider <openai|anthropic|openrouter|ollama|mock>\n" +
        "  --model <모델명>\n" +
        "  --workspace <폴더경로>\n" +
        "  --setup                대화형 연결 설정 실행\n" +
        "  --no-teach             교육 모드 끄고 간결하게\n" +
        "  --no-stream            실시간 스트리밍 끄기\n" +
        "  --no-color             색상 끄기(흑백)\n" +
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
  if (args.noStream) cfg.stream = false;
  if (args.noColor) cfg.no_color = true;
  if (cfg.no_color) setColor(false); // 색상 끄기(흑백)

  // 명령 히스토리(↑↓)를 세션 간에도 기억한다.
  const histPath = path.join(configDir(), "history");
  let savedHistory = [];
  try {
    savedHistory = fs.readFileSync(histPath, "utf8").split("\n").filter(Boolean).slice(0, 200);
  } catch { /* 첫 실행 */ }
  // Tab 자동완성: 슬래시 명령(내장+스킬) · /provider 인자 · @파일 멘션
  let toolbox = null;
  let skills = {};
  const completer = makeCompleter({
    skills: () => skills,
    workspace: () => (toolbox ? toolbox.workspace : null),
    providers: PROVIDERS,
  });
  const rl = readline.createInterface({ input: stdin, output: stdout, history: savedHistory, historySize: 200, completer });
  const saveHistory = () => {
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(histPath, (rl.history || []).slice(0, 200).join("\n"), "utf8");
    } catch { /* ignore */ }
  };
  let session = null;
  let mcp = { tools: [], servers: [], errors: [], closeAll: () => {} };

  // Ctrl+C → 깔끔하게 종료(스택트레이스 없이). 어디서 누르든 안전.
  const gracefulExit = () => {
    saveHistory();
    try { rl.close(); } catch { /* */ }
    try { session && session.close(); } catch { /* */ }
    try { mcp && mcp.closeAll && mcp.closeAll(); } catch { /* */ }
    console.log(c.dim("\n종료합니다. 안녕히 가세요!"));
    process.exit(0);
  };
  rl.on("SIGINT", gracefulExit);
  // 프롬프트 헬퍼. TTY 면 rl.question 그대로(히스토리·편집 지원).
  // 파이프/스크립트 입력(non-TTY)은 줄을 큐로 받아 어떤 타이밍에 물어도 유실되지 않게 한다
  // (모델 호출 중 도착한 승인 답변 줄이 사라지던 문제 해결 — CI/데모 자동화 가능).
  let ask;
  if (stdin.isTTY) {
    ask = async (q) => {
      try {
        return await rl.question(q);
      } catch {
        return null;
      }
    };
  } else {
    const lineQueue = [];
    let pendingResolve = null;
    let closed = false;
    rl.on("line", (l) => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r(l);
      } else lineQueue.push(l);
    });
    rl.on("close", () => {
      closed = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r(null);
      }
    });
    ask = (q) => {
      process.stdout.write(q);
      if (lineQueue.length) {
        const l = lineQueue.shift();
        process.stdout.write(l + "\n");
        return Promise.resolve(l);
      }
      if (closed) return Promise.resolve(null);
      return new Promise((res) => {
        pendingResolve = res;
      });
    };
  }

  if (args.setup) {
    await runSetup(ask, cfg);
  } else if (!cfg.isReady() && cfg.provider !== "mock") {
    console.log(c.yellow(`provider=${cfg.provider} 인데 API 키가 없습니다. 연결 설정을 시작합니다.\n`));
    await runSetup(ask, cfg);
  }

  printIntro(cfg);

  // 새 버전 안내(있을 때만, 하루 1회)
  const newer = await maybeCheckUpdate(cfg);
  if (newer) {
    console.log(
      c.yellow(`⬆️  새 버전 v${newer} 가 나왔어요!`) +
        c.dim(`  지금 바로: `) + c.cyan("/update") + c.dim(` · exe 는 Releases 에서 새로 받기`) +
        "\n"
    );
  }

  // ③ MCP 서버(다른 에이전트와 공용 표준) 연결 — 1회
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    process.stdout.write(c.dim("MCP 서버 연결 중...\r"));
    mcp = await connectMcpServers(cfg.mcpServers);
  }
  // 플러그인·스킬·도구상자를 작업 폴더 기준으로 구성(작업 폴더 변경 시 재사용)
  ({ toolbox, skills } = await buildExtensions(cfg, mcp));
  if (toolbox.plugins.length || Object.keys(skills).length || toolbox.pluginErrors.length || mcp.servers.length) {
    const bits = [];
    if (toolbox.plugins.length) bits.push(c.green(`도구 +${toolbox.plugins.length}개`));
    if (mcp.servers.length) bits.push(c.green(`MCP ${mcp.servers.length}개`) + c.grey(` (${mcp.servers.map((s) => s.name).join(", ")})`));
    if (Object.keys(skills).length) bits.push(c.green(`스킬 ${Object.keys(skills).length}개`));
    if (toolbox.pluginErrors.length) bits.push(c.red(`오류 ${toolbox.pluginErrors.length}개`));
    console.log("🔌 " + bits.join(" · ") + c.dim("  (/plugins /skills /mcp 로 상세)") + "\n");
  }

  session = SessionLog.create();
  // 스트리밍: 토큰이 도착하는 대로 실시간 출력(첫 토큰에 헤더 1회).
  const stream = { active: false };
  const onToken = (chunk) => {
    if (!stream.active) {
      process.stdout.write("\n" + c.green("🤖 ③ 모델 응답 (스트리밍)") + "\n");
      stream.active = true;
    }
    process.stdout.write(c.green(chunk));
  };
  const loop = new AgentLoop({
    config: cfg,
    client: makeClient(cfg),
    toolbox,
    onEvent: makePrinter(cfg, stream),
    approvalCallback: makeApproval(ask, cfg),
    session,
    onToken,
  });
  loop.reset();

  const rule = () => console.log(c.grey("─".repeat(Math.min(80, stdout.columns || 80))));

  // @파일 멘션: 입력 속 @경로 가 작업 폴더의 실제 파일이면 내용을 프롬프트에 첨부한다.
  const expandMentions = (text) => {
    const tokens = [...text.matchAll(/@([\w가-힣./\\-]+)/g)].map((m) => m[1]);
    let out = text;
    for (const t of [...new Set(tokens)]) {
      try {
        const r = toolbox.readFile(t);
        const clipped = (r.output || "").slice(0, 4000);
        out += `\n\n[첨부 @${t}]\n${clipped}`;
        console.log(c.dim(`📎 @${t} 첨부됨 (${clipped.length}자)`));
      } catch { /* 파일이 아니면 무시(이메일 등) */ }
    }
    return out;
  };

  // 대화 자동저장(/resume 용) + 멘션 확장을 겸하는 실행 헬퍼.
  const convPath = path.join(configDir(), "last_session.json");
  const runTurn = async (promptText) => {
    rule();
    try {
      await loop.run(expandMentions(promptText));
    } catch (e) {
      console.log(c.red(`실행 오류: ${e?.message || e}`));
    }
    rule();
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(convPath, JSON.stringify({ time: Date.now(), provider: cfg.provider, model: cfg.model, messages: loop.messages }), "utf8");
    } catch { /* 저장 실패 무시 */ }
  };

  // 첫 실행 온보딩(한 번만 — ~/.cdsa_harness/.welcomed 표시): 작업 폴더 설정 + 튜토리얼
  const markerPath = path.join(configDir(), ".welcomed");
  if (stdin.isTTY && !fs.existsSync(markerPath)) {
    console.log(panel(
      [
        "AI 가 파일을 다룰 ‘작업 폴더’를 정하세요.",
        c.dim("이 폴더 밖은 절대 건드리지 않아요(안전장치)."),
        "",
        `  ${c.bold("엔터")}  ${c.cyan("지금 이 폴더")} 를 그대로 사용 (터미널답게, 기본)`,
        `  ${c.bold("경로")}  따로 격리하고 싶으면 입력 — 예) ${c.cyan("./sandbox")} 또는 ${c.cyan("C:\\작업\\프로젝트")}`,
      ],
      { title: "📁 작업 폴더 설정 (처음 한 번)", color: "cyan" }
    ));
    const wsAns = await ask(c.cyan("작업 폴더 [엔터=기본]: "));
    if (wsAns !== null && wsAns.trim()) {
      cfg.workspace = wsAns.trim();
      const rebuilt = await buildExtensions(cfg, mcp);
      toolbox = rebuilt.toolbox;
      skills = rebuilt.skills;
      loop.toolbox = toolbox;
      loop.reset();
    }
    try {
      saveConfig(cfg);
    } catch {
      /* 저장 실패 무시 */
    }
    console.log(c.green(`작업 폴더: ${cfg.workspacePath()}`) + c.dim("  (나중에 /workspace 로 변경 가능)\n"));

    const a = await ask(c.cyan("짧은 튜토리얼을 볼까요? [Y/n] "));
    if (a !== null && ["", "y", "yes"].includes(a.trim().toLowerCase())) await runTutorial(ask);
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(markerPath, new Date().toISOString());
    } catch {
      /* 표시 실패는 무시 */
    }
  }

  while (true) {
    const raw = await ask(c.bold(c.cyan("› ")));
    if (raw === null) break; // Ctrl+D / Ctrl+C / 스트림 종료
    const user = raw.trim();
    if (!user) continue;
    const low = user.toLowerCase();

    if (["/quit", "/exit", "quit", "exit", ":q"].includes(low)) break;
    if (user === "/") {
      const skillNames = Object.keys(skills).sort();
      console.log(panel([
        c.bold("대화")+"      "+c.cyan("/new /compact /resume /undo /context"),
        c.bold("프로젝트")+"  "+c.cyan("/init /memory /workspace"),
        c.bold("모델·설정")+" "+c.cyan("/setup /models /model /provider /auto /status /teach /stream /update"),
        c.bold("확장")+"      "+c.cyan("/skills /plugins /mcp"),
        c.bold("기타")+"      "+c.cyan("/guide /tutorial /about /config /quit"),
        "",
        c.bold(`스킬 ${skillNames.length}개`)+"  "+c.grey(skillNames.slice(0,10).map(s=>"/"+s).join(" ")+(skillNames.length>10?" …":"")),
        "",
        c.dim("💡 Tab 키로 자동완성 — 예: /mi[Tab], /provider o[Tab], @파일[Tab]"),
      ], { title: "⌨️  명령 팔레트", color: "cyan" }));
      continue;
    }
    if (low === "/help") { printHelp(); continue; }
    if (low === "/guide" || low === "/start") { printGuide(); continue; }
    if (low === "/tutorial") { await runTutorial(ask); continue; }
    if (low === "/color") {
      cfg.no_color = !cfg.no_color;
      setColor(!cfg.no_color);
      console.log(cfg.no_color ? "색상 끔(흑백)." : c.green("색상 켬."));
      continue;
    }
    if (low === "/about") {
      console.log(panel([
        c.bold("CDSA Harness") + c.grey(`  v${VERSION}`),
        c.dim("AI 에이전트가 내부에서 무슨 일을 하는지 단계별로 드러내는 공개 교육용 하네스."),
        "",
        `${c.grey("made by")}  ${c.cyan(c.bold("CDSA"))}`,
        `${c.grey("npm")}      npm i -g cdsa-harness`,
        `${c.grey("repo")}     github.com/cdsassj00/miniharness`,
        `${c.grey("license")}  MIT · 의존성 0개(Node 18+)`,
      ], { title: "ℹ️  about", color: "cyan" }));
      continue;
    }
    // /clear·/new — Claude Code·OpenCode 컨벤션(= 기존 /reset)
    if (low === "/reset" || low === "/clear" || low === "/new") {
      loop.reset();
      console.log(c.green("새 대화를 시작합니다(컨텍스트 초기화)."));
      continue;
    }
    // /compact — 대화를 '모델이 직접' 요약해 컨텍스트를 압축 (Claude Code 방식, 모델-퍼스트)
    if (low === "/compact") {
      if (loop.messages.length < 4) {
        console.log(c.dim("아직 압축할 대화가 충분하지 않습니다."));
        continue;
      }
      const before = loop.messages.length;
      console.log(c.dim("모델에게 대화 요약을 맡겨 컨텍스트를 압축합니다…"));
      try {
        const req = [
          ...loop.messages,
          {
            role: "user",
            content:
              "지금까지의 대화를 다음 작업에 꼭 필요한 것만 남긴 한국어 요약으로 만들어줘: 확인된 사실, 내린 결정, 파일 변경 내역, 미완료 작업. 요약문만 출력해.",
          },
        ];
        const r = await loop.client.chat(req, []);
        const summary = (r.content || "").trim();
        if (!summary) throw new Error("빈 요약");
        loop.reset();
        loop.messages.push(
          { role: "user", content: `[이전 대화 요약]\n${summary}` },
          { role: "assistant", content: "요약을 확인했습니다. 이어서 진행하겠습니다." }
        );
        console.log(c.green(`압축 완료 — 메시지 ${before}개 → ${loop.messages.length}개`));
      } catch (e) {
        console.log(c.yellow(`압축 실패: ${e.message}`));
      }
      continue;
    }
    // /undo — 마지막 파일 변경 1건 되돌리기 (OpenCode 컨벤션)
    if (low === "/undo") {
      try {
        console.log(c.green(toolbox.undoLast().output));
      } catch (e) {
        console.log(c.yellow(e.message));
      }
      continue;
    }
    // /update — 자기 자신을 최신 버전으로 업데이트(npm 설치본). exe 는 다운로드 안내.
    if (low === "/update") {
      let isSea = false;
      try {
        isSea = (await import("node:sea")).isSea();
      } catch { /* 구버전 Node — SEA 아님 */ }
      if (isSea) {
        console.log(c.yellow("단일 실행파일(exe) 버전은 파일 교체 방식이라 자동 업데이트가 없어요."));
        console.log(c.dim("최신 exe 다운로드: ") + c.cyan("https://github.com/cdsassj00/miniharness/releases/latest"));
        continue;
      }
      console.log(c.cyan("최신 버전으로 업데이트합니다… (npm i -g cdsa-harness@latest)"));
      try {
        execSync("npm i -g cdsa-harness@latest", { stdio: "inherit" });
        console.log(c.green("✅ 업데이트 완료! /quit 후 다시 실행하면 새 버전이 적용됩니다."));
      } catch (e) {
        console.log(c.red(`업데이트 실패: ${e.message}`));
        console.log(c.dim("직접 실행: npm i -g cdsa-harness@latest"));
      }
      continue;
    }
    // /auto — 자동 수락 토글(신뢰 전환). Claude Code 의 auto-accept 에 해당.
    if (low === "/auto") {
      cfg.approval_mode = cfg.approval_mode === "auto" ? "manual" : "auto";
      console.log(
        cfg.approval_mode === "auto"
          ? c.green("자동 수락 ON — 파일 수정·셸을 묻지 않고 실행합니다. (해제: /auto)")
          : c.green("자동 수락 OFF — 변경 전 diff 를 보여주고 승인을 받습니다.")
      );
      continue;
    }
    // /init — '모델에게' 폴더를 파악시켜 AGENT.md 프로젝트 규칙을 만들게 한다 (Claude Code /init)
    if (low === "/init") {
      await runTurn(
        "이 작업 폴더를 list_dir/read_file/search_files 로 파악한 뒤, 앞으로의 에이전트 작업 지침이 될 " +
          "AGENT.md 파일을 write_file 로 생성해줘. 포함: ①프로젝트/폴더 개요 ②작업 시 지켜야 할 규칙(말투·제약·주의) " +
          "③자주 할 작업 예시. 이미 AGENT.md 가 있으면 읽고 부족한 부분만 개선해."
      );
      continue;
    }
    // /status·/cost — 현재 상태 + 세션 누적 토큰 (Claude Code 컨벤션)
    if (low === "/status" || low === "/cost") {
      const u = loop.usage;
      console.log(
        panel(
          [
            `${c.grey("모델".padEnd(6))} ${c.bold(`${cfg.provider} · ${cfg.model}`)}`,
            `${c.grey("폴더".padEnd(6))} ${cfg.workspacePath()}`,
            `${c.grey("승인".padEnd(6))} ${cfg.approval_mode === "auto" ? c.yellow("자동 수락") : "수동(diff 확인)"} · 셸 ${cfg.allow_shell ? "허용" : "차단"}`,
            `${c.grey("대화".padEnd(6))} 메시지 ${loop.messages.length}개 (/compact 로 압축 가능)`,
            `${c.grey("토큰".padEnd(6))} 입력 ${u.input.toLocaleString()} · 출력 ${u.output.toLocaleString()} · 합계 ${c.bold(u.total.toLocaleString())} (호출 ${u.calls}회)`,
          ],
          { title: "📊 상태 (/status)", color: "cyan" }
        )
      );
      continue;
    }
    // /models [검색어] — 모델 목록에서 번호로 선택(제공자별 실시간 조회)
    if (low === "/models" || low.startsWith("/models ")) {
      const query = user.split(/\s+/).slice(1).join(" ");
      const picked = await pickModel(ask, cfg, query);
      if (picked) {
        cfg.model = picked;
        loop.client = makeClient(cfg);
        saveConfig(cfg);
        console.log(c.green(`모델 변경 → ${picked}`) + c.dim("  (저장됨)"));
      } else {
        console.log(c.dim("변경하지 않았습니다."));
      }
      continue;
    }
    // /memory — 프로젝트 규칙 파일(AGENT.md) 보기 (Claude Code /memory)
    if (low === "/memory") {
      const candidates = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "rules.md"].map((n) => path.join(cfg.workspacePath(), n));
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) {
        console.log(panel(fs.readFileSync(found, "utf8").split("\n").slice(0, 40), { title: `🧠 프로젝트 규칙 — ${path.basename(found)}`, color: "cyan" }));
        console.log(c.dim(`전체 경로: ${found} (매 턴 시스템 프롬프트에 주입됩니다)`));
      } else {
        console.log(c.yellow("프로젝트 규칙 파일이 없습니다. ") + c.cyan("/init") + c.dim(" 을 실행하면 모델이 폴더를 파악해 AGENT.md 를 만들어줍니다."));
      }
      continue;
    }
    if (low === "/resume") {
      try {
        const saved = JSON.parse(fs.readFileSync(convPath, "utf8"));
        if (!Array.isArray(saved.messages) || !saved.messages.length) throw new Error("빈 세션");
        loop.messages = saved.messages;
        const when = new Date(saved.time).toLocaleString("ko-KR");
        console.log(c.green(`지난 대화를 이어갑니다 — ${when} · ${saved.model} · 메시지 ${saved.messages.length}개 복원`));
        console.log(c.dim("(새로 시작하려면 /reset)"));
      } catch {
        console.log(c.yellow("이어갈 지난 대화가 없습니다."));
      }
      continue;
    }
    if (low === "/config") { printIntro(cfg); console.log(c.dim(`config.json: ${configPath()}`)); continue; }
    if (low.startsWith("/workspace") || low.startsWith("/cd")) {
      const arg = user.split(/\s+/).slice(1).join(" ").trim();
      if (!arg) {
        console.log(c.dim(`현재 작업 폴더: ${cfg.workspacePath()}`));
        console.log(c.dim("변경: /workspace <폴더경로>   (현재 폴더 그대로: /workspace .)"));
        continue;
      }
      cfg.workspace = arg;
      const rebuilt = await buildExtensions(cfg, mcp);
      toolbox = rebuilt.toolbox;
      skills = rebuilt.skills;
      loop.toolbox = toolbox;
      loop.reset();
      console.log(
        c.green(`작업 폴더 변경 → ${cfg.workspacePath()}`) +
          c.dim(`  (도구 ${toolbox.plugins.length} · 스킬 ${Object.keys(skills).length})`)
      );
      continue;
    }
    if (low === "/sessions") { console.log(c.dim(`세션 로그: ${sessionsDir()}`)); continue; }
    if (low === "/teach") {
      cfg.teach_mode = !cfg.teach_mode;
      console.log(c.green(`교육 모드 ${cfg.teach_mode ? "ON" : "OFF"}.`));
      continue;
    }
    if (low === "/stream") {
      cfg.stream = !cfg.stream;
      console.log(c.green(`스트리밍 ${cfg.stream ? "ON (실시간 출력)" : "OFF"}.`));
      continue;
    }
    if (low === "/setup" || low === "/login") {
      await runSetup(ask, cfg);
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
      const names = Object.keys(skills).sort();
      const srcTag = (s) => {
        const src = s.source || "";
        if (src === "(내장)") return c.dim("⭐ 내장");
        if (src === "(npm)") return c.dim("📦 npm");
        if (src.includes(`${path.sep}.claude${path.sep}`)) return c.dim("🟣 claude");
        if (src.includes(`${path.sep}.opencode${path.sep}`)) return c.dim("🟠 opencode");
        if (src.includes(`${path.sep}node-cli${path.sep}skills`) || src.includes(`cdsa-harness${path.sep}skills`)) return c.dim("⭐ 내장");
        if (src.includes(`.cdsa_harness${path.sep}skills`)) return c.dim("🏠 전역");
        if (src.includes(`.cdsa${path.sep}skills`)) return c.dim("📂 프로젝트");
        return c.dim("📄 파일");
      };
      const lines = names.length
        ? names.map((n) => {
            const h = skills[n].hint ? " " + c.dim(skills[n].hint) : "";
            return `${c.cyan("/" + n)}${h}  ${c.grey(skills[n].description || "")}  ${srcTag(skills[n])}`;
          })
        : [c.dim("등록된 스킬이 없습니다.")];
      lines.unshift(c.dim("사용법: /명령 뒤에  <필수> 또는 [선택] 표기대로 입력하세요."));
      lines.push(c.dim("추가: <작업폴더>/.cdsa/skills/*.md · ~/.cdsa_harness/skills/ · config.json 의 skill_dirs"));
      lines.push(c.dim("외부(.claude/commands 등)는 import_foreign_skills 로 끌 수 있음"));
      console.log(panel(lines, { title: "🎯 스킬 (프롬프트 템플릿, /이름 으로 실행)", color: "cyan" }));
      continue;
    }

    // 위 내장 명령에 안 걸린 '/...' → 스킬이면 실행, 아니면 안내.
    if (user.startsWith("/")) {
      const name = low.slice(1).split(/\s+/)[0];
      if (skills[name]) {
        const argStr = user.split(/\s+/).slice(1).join(" ").trim();
        const hint = skills[name].hint || "";
        // 입력이 필요한 스킬(<...>)인데 비어 있으면, 실행 대신 사용법을 알려준다.
        if (!argStr && hint.includes("<")) {
          console.log(c.yellow(`사용법: ${c.bold("/" + name)} ${hint}`) + c.dim("  ← 명령 뒤에 내용을 입력하세요"));
          if (skills[name].description) console.log(c.dim("  " + skills[name].description));
          continue;
        }
        console.log(c.dim(`(스킬 '/${name}' 실행)`));
        await runTurn(renderSkill(skills[name], argStr));
      } else {
        const { BUILTIN_COMMANDS } = await import("./completion.js");
        const all = [...BUILTIN_COMMANDS, ...Object.keys(skills).map((s) => "/" + s)];
        const near = all.filter((n) => n.includes(name.slice(0, 3)) || n.slice(1).startsWith(name[0] || "")).slice(0, 4);
        console.log(
          c.yellow(`알 수 없는 명령: /${name}`) +
            (near.length ? c.dim("  혹시? ") + c.cyan(near.join(" ")) : "") +
            c.dim("  · '/' 입력=팔레트 · Tab=자동완성")
        );
      }
      continue;
    }

    await runTurn(user);
  }

  rl.close();
  session.close();
  mcp.closeAll();
  console.log(c.dim("\n종료합니다. 안녕히 가세요!"));
  return 0;
}
