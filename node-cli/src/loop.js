// Agent Loop — 하네스의 심장.
//   입력 → 컨텍스트 구성 → 모델 호출 → 도구 판단 → (수정/셸이면) 승인
//        → 도구 실행 → 결과를 다시 모델에 전달 → 완료까지 반복
//
// UI 를 모른다. 각 단계를 onEvent 로 방출하고, 승인은 approvalCallback 으로 위임한다.
import fs from "node:fs";
import path from "node:path";

import { LLMError } from "./llm.js";
import { MUTATING_TOOLS, TOOL_LABELS, ToolError, toolSchemas } from "./tools.js";

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
  done: "완료",
  error: "오류",
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
  constructor({ config, client, toolbox, onEvent, approvalCallback, session = null }) {
    this.config = config;
    this.client = client;
    this.toolbox = toolbox;
    this.onEvent = onEvent;
    this.approvalCallback = approvalCallback;
    this.session = session;
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
    let listing;
    try {
      listing = this.toolbox.listDir(".").output;
    } catch {
      listing = "(폴더를 읽을 수 없음)";
    }
    const toolNames = ["list_dir", "read_file", "write_file"].concat(
      this.config.allow_shell ? ["run_shell"] : []
    );
    const toolsDesc = toolNames.map((n) => `${n}(${TOOL_LABELS[n]})`).join(", ");

    const parts = [
      "당신은 'CDSA Harness' 안에서 동작하는 소형 코딩 에이전트입니다.",
      "당신은 직접 파일을 만질 수 없습니다. 반드시 제공된 도구로만 작업 폴더를 다룹니다.",
      `사용 가능한 도구: ${toolsDesc}.`,
      "파일을 수정할 때는 write_file 에 '파일 전체 내용'을 담아 호출하세요(부분 패치 아님).",
      "추측하지 말고, 필요하면 먼저 read_file/list_dir 로 사실을 확인하세요.",
      "작업이 끝나면 도구를 더 호출하지 말고 한국어로 결과를 요약하세요.",
      `\n[작업 폴더 루트]\n${ws}`,
      `\n[현재 폴더 내용]\n${listing}`,
    ];
    if (rulesText) parts.push(`\n[규칙 파일 ${rulesName}]\n${rulesText.trim()}`);
    return parts.join("\n");
  }

  reset() {
    this.messages = [{ role: "system", content: this._systemPrompt() }];
  }

  async run(userInput) {
    if (this.messages.length === 0) this.reset();

    this._emit(Step.USER_INPUT, "사용자 입력", userInput);
    this.messages.push({ role: "user", content: userInput });

    this._emit(
      Step.BUILD_CONTEXT,
      "컨텍스트 구성",
      "규칙 파일 + 작업 폴더 내용을 시스템 프롬프트로 묶어 모델에 전달합니다."
    );

    const tools = toolSchemas(this.config.allow_shell);
    let finalText = "";

    for (let stepNo = 1; stepNo <= this.config.max_steps; stepNo++) {
      this._emit(
        Step.MODEL_CALL,
        `LLM 호출 (반복 ${stepNo})`,
        `메시지 ${this.messages.length}개를 모델에 전송합니다.`
      );

      let reply;
      try {
        reply = await this.client.chat(this.messages, tools);
      } catch (e) {
        if (e instanceof LLMError) {
          this._emit(Step.ERROR, "LLM 오류", e.message);
          return finalText;
        }
        throw e;
      }

      this._emit(Step.MODEL_REPLY, "모델 응답", reply.content || "(텍스트 없음)", {
        toolCalls: reply.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
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
    }

    this._emit(Step.DONE, "반복 한도 도달", `max_steps(${this.config.max_steps})에 도달해 종료했습니다.`);
    return finalText;
  }

  async _handleToolCall(tc) {
    const label = TOOL_LABELS[tc.name] || tc.name;
    const needsApproval = MUTATING_TOOLS.has(tc.name);

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
      const result = this.toolbox.execute(tc.name, tc.args);
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
