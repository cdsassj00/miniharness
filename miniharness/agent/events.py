"""Agent Loop 가 진행되며 바깥(UI/로그)으로 흘려보내는 '이벤트' 정의.

하네스의 핵심 교육 포인트는 "각 단계가 무엇인지 눈에 보이는 것"이다.
그래서 루프의 모든 단계를 Event 로 방출(emit)하고, UI 는 이를 받아 단계 다이어그램을
점등시키거나 로그에 남긴다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Step(str, Enum):
    """Agent Loop 의 단계. 값은 화면 표기용 한글 라벨과 매핑된다."""

    USER_INPUT = "user_input"          # 사용자 요청 수신
    BUILD_CONTEXT = "build_context"    # 규칙 + 작업 폴더로 컨텍스트 구성
    MODEL_CALL = "model_call"          # LLM 호출
    MODEL_REPLY = "model_reply"        # LLM 응답(텍스트/도구요청)
    TOOL_DECISION = "tool_decision"    # 도구 호출 필요 여부 판단
    APPROVAL = "approval"              # 사용자 승인 대기/결정
    TOOL_RUN = "tool_run"              # 도구 실행 (파일 읽기/수정/셸)
    TOOL_RESULT = "tool_result"        # 실행 결과를 모델에게 되돌림
    DONE = "done"                      # 완료
    ERROR = "error"                    # 오류


# 단계별 한글 라벨 (UI 다이어그램용)
STEP_LABELS = {
    Step.USER_INPUT: "사용자 입력",
    Step.BUILD_CONTEXT: "컨텍스트 구성",
    Step.MODEL_CALL: "LLM 호출",
    Step.MODEL_REPLY: "모델 응답",
    Step.TOOL_DECISION: "도구 판단",
    Step.APPROVAL: "사용자 승인",
    Step.TOOL_RUN: "도구 실행",
    Step.TOOL_RESULT: "결과 반영",
    Step.DONE: "완료",
    Step.ERROR: "오류",
}

# 다이어그램에 표시할 루프 순서 (DONE/ERROR 제외)
LOOP_ORDER = [
    Step.USER_INPUT,
    Step.BUILD_CONTEXT,
    Step.MODEL_CALL,
    Step.MODEL_REPLY,
    Step.TOOL_DECISION,
    Step.APPROVAL,
    Step.TOOL_RUN,
    Step.TOOL_RESULT,
]


@dataclass
class Event:
    """루프가 방출하는 단일 이벤트.

    step    : 현재 단계
    title   : 한 줄 요약 (로그 헤더)
    detail  : 상세 본문 (프롬프트, 응답, 도구 인자, diff 등)
    data    : 부가 구조화 데이터 (UI 가 필요 시 사용)
    """

    step: Step
    title: str = ""
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)
