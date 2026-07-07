// Agent Loop — 하네스의 심장.
//   입력 → 컨텍스트 구성 → 모델 호출 → 도구 판단 → (수정/셸이면) 승인
//        → 도구 실행 → 결과를 다시 모델에 전달 → 완료까지 반복
//
// UI 를 모른다. 각 단계를 onEvent 로 방출하고, 승인은 approvalCallback 으로 위임한다.
import fs from "node:fs";
import path from "node:path";

import { LLMError } from "./llm.js";
import { TOOL_LABELS, ToolError, toolSchemas } from "./tools.js";

// 단계(Step) 상수
export const Step = {
  USER_INPUT: "user_input",
  BUILD_CONTEXT: "build_context",
  MODEL_CALL: "model_call",
  MODEL_REPLY: "model_reply",
  TOOL_DECISION: "tool_decision",
  APPROVAL: "approval",
  TOOL_RUN: "tool_run",
  TOOL_RESULT: "tool_result",
  FEEDBACK: "feedback",
  DONE: "done",
  ERROR: "error",
};

export const STEP_LABELS = {
  user_input: "사용자 입력",
  build_context: "컨텍스트 구성",
  model_call: "LLM 호출",
  model_reply: "모델 응답",
  tool_decision: "도구 판단",
  approval: "사용자 승인",
  tool_run: "도구 실행",
  tool_result: "결과 반영",
  feedback: "결과 되먹임",
  done: "완료",
  error: "오류",
};

// 아주 거친 토큰 추정(영문 ~4자/토큰, 한글은 더 많지만 교육용 어림값).
export function estimateTokens(text) {
  return Math.max(1, Math.round((text || "").length / 4));
}

// messages 를 교육용으로 요약: 역할별 글자수 + 도구호출 수.
function summarizeMessages(messages) {
  let totalChars = 0;
  const rows = messages.map((m) => {
    const text = m.content || "";
    let chars = text.length;
    let extra = "";
    if (m.tool_calls && m.tool_calls.length) {
      const j = JSON.stringify(m.tool_calls);
      chars += j.length;
      extra = ` +tool_calls(${m.tool_calls.length})`;
    }
    if (m.role === "tool") extra = " (도구 결과)";
    totalChars += chars;
    return { role: m.role, chars, extra };
  });
  return { rows, totalChars, estTokens: estimateTokens(messages.map((m) => (m.content || "") + JSON.stringify(m.tool_calls || "")).join("")) };
}

// 서브에이전트 위임 도구 — 최상위(depth 0)에서만 노출해 중첩 위임을 막는다.
const SPAWN_AGENT_SCHEMA = {
  type: "function",
  function: {
    name: "spawn_agent",
    description:
      "독립적인 하위 작업을 서브에이전트에게 위임한다. 서브에이전트는 같은 도구(읽기/검색/수정)로 작업하고 결과 텍스트를 돌려준다. 크고 스스로 완결되는 작업 덩어리에만 사용하고, 간단한 일은 직접 도구를 호출하라.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "위임할 작업 지시(구체적으로)" },
        context: { type: "string", description: "작업에 필요한 배경 정보(선택)" },
      },
      required: ["task"],
    },
  },
};

const RULES_FILENAMES = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "rules.md", "RULES.md"];

function findRules(workspace) {
  for (const name of RULES_FILENAMES) {
    const p = path.join(workspace, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { name, text: fs.readFileSync(p, "utf8") };
      }
    } catch {
      /* ignore */
    }
  }
  return { name: "", text: "" };
}

export class AgentLoop {
  constructor({ config, client, toolbox, onEvent, approvalCallback, session = null, onToken = null, depth = 0 }) {
    this.config = config;
    this.client = client;
    this.toolbox = toolbox;
    this.onEvent = onEvent;
    this.approvalCallback = approvalCallback;
    this.session = session;
    this.onToken = onToken; // 스트리밍 토큰 콜백(있으면 실시간 출력)
    this.depth = depth; // 0=최상위, 1=서브에이전트(중첩 위임 불가)
    this.messages = [];
    this.usage = { input: 0, output: 0, total: 0, calls: 0 }; // 세션 누적 토큰(/status, /cost)
  }

  _emit(step, title = "", detail = "", data = {}) {
    const ev = { step, title, detail, data };
    if (this.session) this.session.record(ev);
    this.onEvent(ev);
  }

  _systemPrompt() {
    const ws = this.toolbox.workspace;
    const { name: rulesName, text: rulesText } = findRules(ws);
    // 폴더 '전체 목록'을 박아넣지 않는다(낡은 정보·토큰 낭비 방지) — 최상위 이름만 참고로 주고
    // 최신 상태는 도구(list_dir/search_files)로 확인하게 한다. (OpenCode/Claude Code 방식)
    let topLevel = "";
    try {
      const names = fs.readdirSync(ws).filter((n) => !n.startsWith(".")).sort();
      topLevel = names.slice(0, 15).join(", ") + (names.length > 15 ? ` … (총 ${names.length}개)` : "");
    } catch {
      topLevel = "(읽을 수 없음)";
    }
    const pluginNames = (this.toolbox.plugins || []).map((p) => p.name).join(", ");
    const now = new Date();
    const day = ["일", "월", "화", "수", "목", "금", "토"][now.getDay()];

    const parts = [
      "# 정체성",
      "당신은 CDSA Harness(made by CDSA) 안에서 동작하는 코딩·업무 에이전트입니다.",
      "작업 폴더의 파일을 도구(list_dir/read_file/search_files/edit_file/write_file)로 직접 읽고·검색하고·수정할 수 있습니다.",
      "'파일에 접근할 수 없다'고 답하지 마세요 — 필요한 도구를 호출하면 됩니다. 도구가 곧 당신의 손입니다.",
      "",
      "# 환경",
      `- 작업 폴더(루트): ${ws}`,
      `- 최상위 항목(참고용 스냅샷): ${topLevel || "(빈 폴더)"}`,
      `- 플랫폼: ${process.platform} · Node ${process.versions.node} · 오늘: ${now.toISOString().slice(0, 10)}(${day})`,
      "- 모든 도구는 작업 폴더 밖으로 나갈 수 없습니다(sandbox). 파일 수정·셸 실행은 사용자 승인 후에만 적용됩니다.",
      "",
      "# 도구 사용 원칙",
      "- 추측 금지: 파일 위치·내용이 불확실하면 먼저 search_files / list_dir / read_file 로 사실을 확인한다.",
      "- 기존 파일의 일부 수정은 edit_file(old_text 는 파일에서 유일해야 함), 새 파일·전체 교체만 write_file 을 쓴다.",
      "- 도구가 오류를 돌려주면 같은 호출을 반복하지 말고, 오류 메시지를 읽고 접근을 바꾼다.",
      "- 사용자가 승인을 거부하면 그 의사를 존중하고 대안을 제시한다.",
      this.depth === 0
        ? "- 크고 독립적으로 나눌 수 있는 작업은 spawn_agent 로 서브에이전트에 위임할 수 있다(간단한 일엔 쓰지 말 것)."
        : "- 당신은 상위 에이전트가 위임한 하위 작업을 수행하는 서브에이전트다. 주어진 작업만 완수하고, 결과를 명확한 텍스트로 보고하라.",
      pluginNames ? `- 추가 도구: ${pluginNames}` : null,
      "",
      "# CDSA Harness 자체 사용법 — 사용자가 이 도구의 설정·사용법을 물으면 아래로 정확히 답하라",
      "- 설정 파일: 홈폴더/.cdsa_harness/config.json (실행 폴더에 config.json 이 있으면 그쪽 우선).",
      '- MCP 연결: 설정 파일에 \"mcpServers\": { \"이름\": { \"command\": \"npx\", \"args\": [\"-y\",\"서버패키지\"] } } — Claude Code/Cursor 와 동일 형식. 저장 후 재시작하면 /mcp 에 표시.',
      "- 주요 명령: /setup 연결마법사 · /models 모델선택 · /workspace 작업폴더 변경 · /auto 자동승인 · /update 업데이트 · /mcp /plugins /skills 목록 · /help 전체 · /guide 시작안내.",
      "- 확장: 스킬 = 작업폴더/.cdsa/skills/*.md (또는 홈/.cdsa_harness/skills), 플러그인 = .cdsa/plugins/*.mjs 또는 npm 'cdsa-harness-plugin-*' 설치.",
      "",
      "# 응답 스타일",
      "- 한국어로, 간결하게. 불필요한 서론·사과 없이 핵심부터.",
      "- 작업이 끝나면 도구를 더 호출하지 말고 무엇을 했는지 요약한다.",
    ].filter((p) => p !== null);
    if (rulesText) parts.push("", `# 프로젝트 규칙 (${rulesName})`, rulesText.trim());
    return parts.join("\n");
  }

  reset() {
    this.systemPromptText = this._systemPrompt();
    this.messages = [{ role: "system", content: this.systemPromptText }];
  }

  // 매 턴 시작 시 시스템 프롬프트를 신선하게 재구성한다(대화는 유지, 환경·스냅샷만 갱신).
  refreshSystemPrompt() {
    this.systemPromptText = this._systemPrompt();
    if (this.messages.length && this.messages[0].role === "system") {
      this.messages[0] = { role: "system", content: this.systemPromptText };
    } else {
      this.messages.unshift({ role: "system", content: this.systemPromptText });
    }
  }

  // /context 명령용: 현재 대화 컨텍스트 요약.
  contextSummary() {
    return { ...summarizeMessages(this.messages), systemPrompt: this.systemPromptText };
  }

  async run(userInput) {
    if (this.messages.length === 0) this.reset();
    else this.refreshSystemPrompt(); // 환경·규칙·스냅샷을 매 턴 최신으로 (대화 이력은 유지)

    this._emit(Step.USER_INPUT, "사용자 입력", userInput);
    this.messages.push({ role: "user", content: userInput });

    this._emit(
      Step.BUILD_CONTEXT,
      "컨텍스트 구성",
      "정체성·환경·도구원칙·프로젝트규칙(AGENT.md)을 시스템 프롬프트로 묶어 매 턴 신선하게 전달합니다."
    );

    const tools = toolSchemas(this.config.allow_shell, this.toolbox.plugins);
    if (this.depth === 0) tools.push(SPAWN_AGENT_SCHEMA); // 서브에이전트는 재위임 불가
    const toolNames = tools.map((t) => t.function.name);
    let finalText = "";

    for (let stepNo = 1; stepNo <= this.config.max_steps; stepNo++) {
      // ② 모델에 보내는 컨텍스트를 그대로 드러낸다(교육 모드 핵심).
      const ctx = summarizeMessages(this.messages);
      this._emit(
        Step.MODEL_CALL,
        `LLM 호출 (반복 ${stepNo}/${this.config.max_steps})`,
        `메시지 ${this.messages.length}개(추정 ${ctx.estTokens} 토큰)를 모델에 전송합니다.`,
        {
          iteration: stepNo,
          provider: this.config.provider,
          model: this.config.model,
          messages: ctx.rows,
          totalChars: ctx.totalChars,
          estTokens: ctx.estTokens,
          tools: toolNames,
          systemPrompt: stepNo === 1 ? this.systemPromptText : null,
        }
      );

      const streaming = Boolean(this.onToken && this.config.stream);
      let reply;
      try {
        reply = await this.client.chat(this.messages, tools, streaming ? this.onToken : null);
      } catch (e) {
        if (e instanceof LLMError) {
          this._emit(Step.ERROR, "LLM 오류", e.message);
          return finalText;
        }
        throw e;
      }

      // ③ 모델의 원본 판단 + 실측 메타(응답시간/토큰/요청크기)를 드러낸다.
      // streamed=true 면 텍스트는 이미 실시간 출력됨 → UI 는 메타만 덧붙인다.
      this.usage.calls += 1; // 모든 LLM 호출 횟수(usage 미제공 provider 포함)
      if (reply.usage) {
        this.usage.input += reply.usage.input || 0;
        this.usage.output += reply.usage.output || 0;
        this.usage.total += reply.usage.total || 0;
      }

      this._emit(Step.MODEL_REPLY, "모델 응답", reply.content || "(텍스트 없음)", {
        toolCalls: reply.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
        usage: reply.usage || null,
        latencyMs: reply.latencyMs ?? null,
        request: reply.request || null,
        streamed: streaming && Boolean(reply.content),
      });
      if (reply.content) finalText = reply.content;

      if (!reply.toolCalls.length) {
        this._emit(Step.TOOL_DECISION, "도구 판단", "추가 도구 호출이 필요 없습니다. 작업을 마칩니다.");
        this.messages.push({ role: "assistant", content: reply.content || "" });
        this._emit(Step.DONE, "완료", reply.content || "");
        return finalText;
      }

      const names = reply.toolCalls.map((tc) => `${tc.name}(${TOOL_LABELS[tc.name] || tc.name})`).join(", ");
      this._emit(Step.TOOL_DECISION, "도구 판단", `모델이 도구 호출을 요청했습니다: ${names}`);

      this.messages.push({
        role: "assistant",
        content: reply.content || "",
        tool_calls: reply.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tc of reply.toolCalls) {
        const resultText = await this._handleToolCall(tc);
        this.messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      }

      // ⑤ 도구 결과를 messages 에 넣고 다시 ②로 — 이 되먹임이 'Loop' 의 정체.
      this._emit(
        Step.FEEDBACK,
        "결과 되먹임",
        `도구 결과를 대화에 추가했습니다(현재 메시지 ${this.messages.length}개). 같은 컨텍스트로 다시 모델을 호출합니다.`,
        { messageCount: this.messages.length }
      );
    }

    this._emit(Step.DONE, "반복 한도 도달", `max_steps(${this.config.max_steps})에 도달해 종료했습니다.`);
    return finalText;
  }

  // 서브에이전트: 하위 AgentLoop 를 만들어 위임 작업을 수행시키고 결과 텍스트를 회수한다.
  async _runSubAgent(tc) {
    const task = (tc.args.task || "").trim();
    if (!task) return "spawn_agent 오류: task 가 비어 있습니다.";
    if (this.depth > 0) return "spawn_agent 오류: 서브에이전트는 다시 위임할 수 없습니다.";
    this._emit(Step.TOOL_RUN, "도구 실행: 서브에이전트 위임", task.slice(0, 300));

    const child = new AgentLoop({
      config: this.config,
      client: this.client,
      toolbox: this.toolbox, // 같은 sandbox·같은 승인 정책 공유
      session: this.session,
      approvalCallback: this.approvalCallback,
      onToken: null, // 하위 스트리밍은 화면 소음 — 패널로만 표시
      onEvent: (ev) =>
        this.onEvent({ ...ev, title: `┆ ${ev.title}`, data: { ...(ev.data || {}), sub: 1 } }),
      depth: this.depth + 1,
    });
    child.reset();
    const prompt = (tc.args.context ? `[배경]\n${tc.args.context}\n\n` : "") + `[위임된 작업]\n${task}`;

    let result = "";
    try {
      result = await child.run(prompt);
    } catch (e) {
      result = `서브에이전트 실행 오류: ${e?.message || e}`;
    }
    // 하위 토큰 사용량을 상위(/status)에 합산
    this.usage.input += child.usage.input;
    this.usage.output += child.usage.output;
    this.usage.total += child.usage.total;
    this.usage.calls += child.usage.calls;

    const out = (result || "").trim() || "(서브에이전트가 결과 텍스트를 반환하지 않았습니다)";
    this._emit(Step.TOOL_RESULT, "결과 반영: 서브에이전트", out.slice(0, 4000));
    return out;
  }

  async _handleToolCall(tc) {
    if (tc.name === "spawn_agent") return this._runSubAgent(tc);
    const label = this.toolbox.label ? this.toolbox.label(tc.name) : TOOL_LABELS[tc.name] || tc.name;
    const needsApproval = this.toolbox.isMutating(tc.name);

    if (needsApproval && this.config.approval_mode === "manual") {
      const req = this._buildApprovalRequest(tc);
      this._emit(
        Step.APPROVAL,
        `사용자 승인 대기: ${label}`,
        req.diff || req.command || JSON.stringify(tc.args),
        { tool: tc.name, path: req.path }
      );
      const decision = await this.approvalCallback(req);
      if (!decision.approved) {
        this._emit(Step.APPROVAL, `거부됨: ${label}`, decision.reason || "사용자가 거부함");
        return `사용자가 '${label}' 실행을 거부했습니다. 사유: ${decision.reason || "(없음)"}`;
      }
      this._emit(Step.APPROVAL, `승인됨: ${label}`, "사용자가 승인했습니다.");
    } else if (needsApproval) {
      this._emit(Step.APPROVAL, `자동 승인: ${label}`, "approval_mode=auto 라 자동 승인되었습니다.");
    }

    this._emit(Step.TOOL_RUN, `도구 실행: ${label}`, JSON.stringify(tc.args).slice(0, 2000));
    try {
      const result = await this.toolbox.execute(tc.name, tc.args);
      this._emit(Step.TOOL_RESULT, `결과 반영: ${label}`, (result.output || "").slice(0, 4000));
      return result.output;
    } catch (e) {
      if (e instanceof ToolError) {
        this._emit(Step.TOOL_RESULT, `도구 오류: ${label}`, e.message);
        return `도구 오류: ${e.message}`;
      }
      throw e;
    }
  }

  _buildApprovalRequest(tc) {
    if (tc.name === "write_file") {
      const { path: p, diff } = this.toolbox.previewWrite(tc.args.path || "", tc.args.content || "");
      return { toolName: "write_file", toolLabel: TOOL_LABELS.write_file, args: tc.args, path: p, diff };
    }
    if (tc.name === "edit_file") {
      const { path: p, diff } = this.toolbox.previewEdit(tc.args.path || "", tc.args.old_text || "", tc.args.new_text ?? "");
      return { toolName: "edit_file", toolLabel: TOOL_LABELS.edit_file, args: tc.args, path: p, diff };
    }
    if (tc.name === "run_shell") {
      return {
        toolName: "run_shell",
        toolLabel: TOOL_LABELS.run_shell,
        args: tc.args,
        command: tc.args.command || "",
      };
    }
    return { toolName: tc.name, toolLabel: TOOL_LABELS[tc.name] || tc.name, args: tc.args };
  }
}
