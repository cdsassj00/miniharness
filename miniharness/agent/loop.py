"""Agent Loop — 하네스의 심장.

    사용자 요청
      → 컨텍스트 구성(규칙 + 작업 폴더)
      → 모델 호출
      → 도구 호출 필요 여부 판단
      → (수정/셸이면) 사용자 승인
      → 도구 실행
      → 실행 결과를 다시 모델에게 전달
      → 완료될 때까지 반복

이 모듈은 Qt 를 모른다. 각 단계를 Event 로 방출하고, 승인은 콜백으로 위임한다.
그래서 UI 없이도(테스트/CLI) 똑같이 동작한다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..config import Config
from ..llm import LLMClient, LLMError, LLMReply
from .events import Event, Step
from .session import SessionLog
from .tools import MUTATING_TOOLS, TOOL_LABELS, Toolbox, ToolError, tool_schemas

# 작업 폴더에서 찾을 규칙 파일 후보 (Claude Code 의 CLAUDE.md, Codex 의 AGENTS.md 와 같은 개념)
RULES_FILENAMES = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "rules.md", "RULES.md"]


@dataclass
class ApprovalRequest:
    """사용자 승인이 필요한 도구 호출 1건."""

    tool_name: str
    tool_label: str
    args: dict
    path: str = ""        # write_file 의 대상 경로
    diff: str = ""        # write_file 의 변경 미리보기(unified diff)
    command: str = ""     # run_shell 의 명령


@dataclass
class ApprovalDecision:
    approved: bool
    reason: str = ""      # 거부 사유(있으면 모델에게 전달되어 다른 시도를 유도)


# 승인 콜백 타입: 요청을 받아 결정을 돌려준다(블로킹 가능).
ApprovalCallback = Callable[[ApprovalRequest], ApprovalDecision]
EventCallback = Callable[[Event], None]


def find_rules(workspace: Path) -> tuple[str, str]:
    """작업 폴더에서 규칙 파일을 찾아 (파일명, 내용) 반환. 없으면 ('', '')."""
    for name in RULES_FILENAMES:
        p = workspace / name
        if p.exists() and p.is_file():
            try:
                return name, p.read_text(encoding="utf-8")
            except OSError:
                continue
    return "", ""


class AgentLoop:
    def __init__(
        self,
        config: Config,
        client: LLMClient,
        toolbox: Toolbox,
        on_event: EventCallback,
        approval_callback: ApprovalCallback,
        session: SessionLog | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self.toolbox = toolbox
        self.on_event = on_event
        self.approval_callback = approval_callback
        self.session = session
        self.messages: list[dict] = []
        self._cancelled = False

    # ---- 이벤트 헬퍼 --------------------------------------------------------
    def _emit(self, step: Step, title: str = "", detail: str = "", **data) -> None:
        ev = Event(step=step, title=title, detail=detail, data=data)
        if self.session:
            self.session.record(ev)
        self.on_event(ev)

    def cancel(self) -> None:
        self._cancelled = True

    # ---- 컨텍스트 구성 ------------------------------------------------------
    def _system_prompt(self) -> str:
        ws = self.toolbox.workspace
        rules_name, rules_text = find_rules(ws)
        try:
            listing = self.toolbox.list_dir(".").output
        except ToolError:
            listing = "(폴더를 읽을 수 없음)"

        tools_desc = ", ".join(
            f"{name}({TOOL_LABELS.get(name, name)})"
            for name in ["list_dir", "read_file", "write_file"]
            + (["run_shell"] if self.config.allow_shell else [])
        )

        parts = [
            "당신은 'Mini Harness' 안에서 동작하는 소형 코딩 에이전트입니다.",
            "당신은 직접 파일을 만질 수 없습니다. 반드시 제공된 도구로만 작업 폴더를 다룹니다.",
            f"사용 가능한 도구: {tools_desc}.",
            "파일을 수정할 때는 write_file 에 '파일 전체 내용'을 담아 호출하세요(부분 패치 아님).",
            "추측하지 말고, 필요하면 먼저 read_file/list_dir 로 사실을 확인하세요.",
            "작업이 끝나면 도구를 더 호출하지 말고 한국어로 결과를 요약하세요.",
            f"\n[작업 폴더 루트]\n{ws}",
            f"\n[현재 폴더 내용]\n{listing}",
        ]
        if rules_text:
            parts.append(f"\n[규칙 파일 {rules_name}]\n{rules_text.strip()}")
        return "\n".join(parts)

    def reset(self) -> None:
        """대화 히스토리를 비우고 시스템 프롬프트를 다시 구성한다."""
        self.messages = [{"role": "system", "content": self._system_prompt()}]

    # ---- 메인 루프 ----------------------------------------------------------
    def run(self, user_input: str) -> str:
        """사용자 한 턴을 처리한다. 최종 모델 텍스트를 반환."""
        self._cancelled = False
        if not self.messages:
            self.reset()

        self._emit(Step.USER_INPUT, "사용자 입력", user_input)
        self.messages.append({"role": "user", "content": user_input})

        self._emit(
            Step.BUILD_CONTEXT,
            "컨텍스트 구성",
            "규칙 파일 + 작업 폴더 내용을 시스템 프롬프트로 묶어 모델에 전달합니다.",
            system_preview=self.messages[0]["content"][:1500],
        )

        tools = tool_schemas(self.config.allow_shell)
        final_text = ""

        for step_no in range(1, self.config.max_steps + 1):
            if self._cancelled:
                self._emit(Step.DONE, "중단됨", "사용자가 실행을 중단했습니다.")
                return final_text

            # --- 모델 호출 ---
            self._emit(Step.MODEL_CALL, f"LLM 호출 (반복 {step_no})",
                       f"메시지 {len(self.messages)}개를 모델에 전송합니다.")
            try:
                reply: LLMReply = self.client.chat(self.messages, tools)
            except LLMError as e:
                self._emit(Step.ERROR, "LLM 오류", str(e))
                return final_text

            self._emit(
                Step.MODEL_REPLY,
                "모델 응답",
                reply.content or "(텍스트 없음)",
                tool_calls=[{"name": tc.name, "args": tc.arguments} for tc in reply.tool_calls],
            )
            if reply.content:
                final_text = reply.content

            # --- 도구 필요 판단 ---
            if not reply.wants_tool:
                self._emit(Step.TOOL_DECISION, "도구 판단",
                           "추가 도구 호출이 필요 없습니다. 작업을 마칩니다.")
                self.messages.append({"role": "assistant", "content": reply.content or ""})
                self._emit(Step.DONE, "완료", reply.content or "")
                return final_text

            names = ", ".join(f"{tc.name}({TOOL_LABELS.get(tc.name, tc.name)})"
                              for tc in reply.tool_calls)
            self._emit(Step.TOOL_DECISION, "도구 판단", f"모델이 도구 호출을 요청했습니다: {names}")

            # 도구 호출이 담긴 assistant 메시지를 히스토리에 기록 (OpenAI 형식)
            self.messages.append({
                "role": "assistant",
                "content": reply.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        },
                    }
                    for tc in reply.tool_calls
                ],
            })

            # --- 각 도구 처리: 승인 → 실행 → 결과 반영 ---
            for tc in reply.tool_calls:
                if self._cancelled:
                    self._emit(Step.DONE, "중단됨", "사용자가 실행을 중단했습니다.")
                    return final_text
                result_text = self._handle_tool_call(tc)
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_text,
                })

        # 최대 반복 초과
        self._emit(Step.DONE, "반복 한도 도달",
                   f"max_steps({self.config.max_steps})에 도달해 루프를 종료했습니다.")
        return final_text

    # ---- 단일 도구 처리 -----------------------------------------------------
    def _handle_tool_call(self, tc) -> str:
        label = TOOL_LABELS.get(tc.name, tc.name)

        # 1) 승인 단계
        needs_approval = tc.name in MUTATING_TOOLS
        if needs_approval and self.config.approval_mode == "manual":
            req = self._build_approval_request(tc)
            self._emit(Step.APPROVAL, f"사용자 승인 대기: {label}",
                       req.diff or req.command or json.dumps(tc.arguments, ensure_ascii=False),
                       tool=tc.name, path=req.path)
            decision = self.approval_callback(req)
            if not decision.approved:
                self._emit(Step.APPROVAL, f"거부됨: {label}", decision.reason or "사용자가 거부함")
                return f"사용자가 '{label}' 실행을 거부했습니다. 사유: {decision.reason or '(없음)'}"
            self._emit(Step.APPROVAL, f"승인됨: {label}", "사용자가 승인했습니다.")
        elif needs_approval:
            self._emit(Step.APPROVAL, f"자동 승인: {label}",
                       "approval_mode=auto 라 자동 승인되었습니다.")

        # 2) 실행 단계
        self._emit(Step.TOOL_RUN, f"도구 실행: {label}",
                   json.dumps(tc.arguments, ensure_ascii=False)[:2000])
        try:
            result = self.toolbox.execute(tc.name, tc.arguments)
        except ToolError as e:
            self._emit(Step.TOOL_RESULT, f"도구 오류: {label}", str(e))
            return f"도구 오류: {e}"

        # 3) 결과를 모델에게 되돌릴 준비 (이벤트로도 노출)
        self._emit(Step.TOOL_RESULT, f"결과 반영: {label}", result.output[:4000])
        return result.output

    def _build_approval_request(self, tc) -> ApprovalRequest:
        if tc.name == "write_file":
            path, diff = self.toolbox.preview_write(
                tc.arguments.get("path", ""), tc.arguments.get("content", "")
            )
            return ApprovalRequest("write_file", TOOL_LABELS["write_file"],
                                   tc.arguments, path=path, diff=diff)
        if tc.name == "run_shell":
            return ApprovalRequest("run_shell", TOOL_LABELS["run_shell"],
                                   tc.arguments, command=tc.arguments.get("command", ""))
        return ApprovalRequest(tc.name, TOOL_LABELS.get(tc.name, tc.name), tc.arguments)
