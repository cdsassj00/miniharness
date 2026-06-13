"""코어(Qt 비의존) 검증 테스트.

PySide6 없이도 Agent Loop 전 과정을 mock provider 로 돌려본다.
실행: `python -m tests.test_core`  또는  `pytest`
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from miniharness.agent.events import Event, Step
from miniharness.agent.loop import AgentLoop, ApprovalDecision
from miniharness.agent.tools import Toolbox, ToolError
from miniharness.config import Config
from miniharness.llm import LLMClient


def _make_loop(ws: Path, approval_mode="manual"):
    cfg = Config(provider="mock", model="mock-agent", workspace=str(ws),
                 approval_mode=approval_mode, max_steps=6)
    client = LLMClient("mock", "", "mock-agent")
    toolbox = Toolbox(ws)
    events: list[Event] = []
    loop = AgentLoop(
        config=cfg,
        client=client,
        toolbox=toolbox,
        on_event=events.append,
        approval_callback=lambda req: ApprovalDecision(True),  # 항상 승인
    )
    return loop, events


def test_sandbox_blocks_escape():
    with tempfile.TemporaryDirectory() as d:
        tb = Toolbox(Path(d))
        try:
            tb.read_file("../../etc/passwd")
        except ToolError:
            pass
        else:
            raise AssertionError("작업 폴더 밖 접근이 막히지 않았다")


def test_mock_full_loop_writes_file():
    with tempfile.TemporaryDirectory() as d:
        ws = Path(d)
        (ws / "notes.txt").write_text("처음 내용\n", encoding="utf-8")
        loop, events = _make_loop(ws)
        loop.run("notes.txt 에 메모를 추가해줘")

        steps = [e.step for e in events]
        assert Step.USER_INPUT in steps
        assert Step.BUILD_CONTEXT in steps
        assert Step.MODEL_CALL in steps
        assert Step.TOOL_RUN in steps
        assert Step.APPROVAL in steps  # write_file 은 승인 단계를 거친다
        assert Step.DONE in steps

        # 파일이 실제로 수정되었는지 (승인했으므로)
        content = (ws / "notes.txt").read_text(encoding="utf-8")
        assert "Mini Harness mock 에이전트가 추가" in content


def test_denied_write_keeps_file_unchanged():
    with tempfile.TemporaryDirectory() as d:
        ws = Path(d)
        original = "건드리면 안 됨\n"
        (ws / "notes.txt").write_text(original, encoding="utf-8")

        cfg = Config(provider="mock", model="mock-agent", workspace=str(ws),
                     approval_mode="manual", max_steps=6)
        loop = AgentLoop(
            config=cfg,
            client=LLMClient("mock", "", "mock-agent"),
            toolbox=Toolbox(ws),
            on_event=lambda e: None,
            approval_callback=lambda req: ApprovalDecision(False, "거부"),  # 항상 거부
        )
        loop.run("notes.txt 수정해줘")
        assert (ws / "notes.txt").read_text(encoding="utf-8") == original


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok: {fn.__name__}")
    print(f"\n{len(fns)}개 테스트 통과 ✅")


if __name__ == "__main__":
    _run_all()
