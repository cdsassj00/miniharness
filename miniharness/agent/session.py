"""세션 로그 기록.

하네스는 "무슨 일이 있었는지"를 남긴다. 각 실행을 JSONL 파일로 기록해
나중에 그대로 재생/검토할 수 있게 한다. (교육 목적: 에이전트의 의사결정 추적)
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .events import Event


def sessions_dir() -> Path:
    """세션 로그 저장 폴더 (~/.mini_harness/sessions)."""
    import os

    d = Path(os.path.expanduser("~")) / ".mini_harness" / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class SessionLog:
    path: Path

    @classmethod
    def create(cls) -> "SessionLog":
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = sessions_dir() / f"session-{ts}.jsonl"
        log = cls(path=path)
        log._append({"type": "session_start", "time": time.time()})
        return log

    def _append(self, obj: dict) -> None:
        try:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        except OSError:
            pass  # 로그 실패가 앱을 멈추게 하지 않는다.

    def record(self, event: Event) -> None:
        self._append(
            {
                "type": "event",
                "time": time.time(),
                "step": event.step.value,
                "title": event.title,
                "detail": event.detail,
                "data": event.data,
            }
        )

    def close(self) -> None:
        self._append({"type": "session_end", "time": time.time()})
