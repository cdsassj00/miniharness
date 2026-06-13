"""Agent Loop 를 백그라운드 스레드에서 돌리는 워커.

LLM 호출은 시간이 걸리므로 UI 스레드를 막으면 안 된다. AgentLoop 는 워커 스레드에서
돌고, 각 단계는 Qt 시그널로 메인 스레드에 안전하게 전달된다.

승인은 까다롭다. 워커 스레드가 '사용자 승인'을 기다려야 하는데, 다이얼로그는 메인
스레드에서만 띄울 수 있다. 그래서:
  워커 → approval_requested 시그널 emit → (threading.Event 로 대기)
  메인 → 다이얼로그 표시 → provide_decision() 호출 → Event set → 워커 재개
"""

from __future__ import annotations

import threading

from PySide6.QtCore import QThread, Signal

from ..agent.events import Event, Step
from ..agent.loop import AgentLoop, ApprovalDecision, ApprovalRequest


class AgentWorker(QThread):
    event_occurred = Signal(object)       # Event
    approval_requested = Signal(object)   # ApprovalRequest
    turn_finished = Signal(str)           # 최종 모델 텍스트

    def __init__(self, loop: AgentLoop, user_input: str) -> None:
        super().__init__()
        self.loop = loop
        self.user_input = user_input
        self._wait = threading.Event()
        self._decision: ApprovalDecision | None = None

        # 루프의 콜백을 이 워커로 연결한다.
        loop.on_event = self.event_occurred.emit
        loop.approval_callback = self._request_approval

    # 워커 스레드에서 호출됨 → 시그널 emit 후 메인 스레드의 결정 대기(블로킹)
    def _request_approval(self, req: ApprovalRequest) -> ApprovalDecision:
        self._decision = None
        self._wait.clear()
        self.approval_requested.emit(req)
        self._wait.wait()
        return self._decision or ApprovalDecision(False, "승인 응답이 없었습니다.")

    # 메인 스레드(다이얼로그)에서 호출 → 워커를 깨운다
    def provide_decision(self, decision: ApprovalDecision) -> None:
        self._decision = decision
        self._wait.set()

    def cancel(self) -> None:
        self.loop.cancel()
        # 승인 대기 중이면 거부로 깨워서 정리
        if not self._wait.is_set():
            self.provide_decision(ApprovalDecision(False, "사용자가 중단했습니다."))

    def run(self) -> None:  # QThread 엔트리
        try:
            result = self.loop.run(self.user_input)
            self.turn_finished.emit(result or "")
        except Exception as e:  # noqa: BLE001 — 어떤 예외든 UI 로 보고
            self.event_occurred.emit(Event(Step.ERROR, "예기치 못한 오류", str(e)))
            self.turn_finished.emit("")
