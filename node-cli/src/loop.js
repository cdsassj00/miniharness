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
  constructor({ config, client, toolbox, onEvent, approvalCallback, session = null, onToken = null }) {
    this.config = config;
    this.client = client;
    this.toolbox = toolbox;
    this.onEvent = onEvent;
    this.approvalCallback = approvalCallback;
    this.session = session;
    this.onToken = onToken; // 스트리밍 토큰 콜백(있으면 실시간 출력)
    this.messages = [];
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
      "파일시스템에 직접 접근할 수 없으며, 제공된 도구 호출로만 작업 폴더를 다룹니다.",
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
      pluginNames ? `- 추가 도구: ${pluginNames}` : null,
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

  async _handleToolCall(tc) {
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
