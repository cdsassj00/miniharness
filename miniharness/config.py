"""앱 설정 로드/저장.

설정은 사용자 홈의 ``~/.mini_harness/config.json`` 에 저장한다.
(예전 방식 호환을 위해, 실행 폴더에 config.json 이 있으면 그걸 우선 사용한다.)

config.json 예시::

    {
      "provider": "openai",
      "api_key": "",
      "model": "gpt-4.1-mini",
      "workspace": "./workspace",
      "approval_mode": "manual",
      "allow_shell": false
    }
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path


# 지원 provider 목록 (교육용으로 OpenAI / OpenRouter + 키 없이 체험하는 mock)
PROVIDERS = ["openai", "openrouter", "mock"]

# provider 별 추천 모델 (UI 자동완성용)
SUGGESTED_MODELS = {
    "openai": ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"],
    "openrouter": [
        "openai/gpt-4.1-mini",
        "anthropic/claude-3.5-sonnet",
        "google/gemini-2.5-flash",
    ],
    "mock": ["mock-agent"],
}

APPROVAL_MODES = ["manual", "auto"]  # manual: 파일 수정/셸 실행마다 승인, auto: 자동 승인


def config_dir() -> Path:
    """설정 디렉터리 경로 (~/.mini_harness)."""
    return Path(os.path.expanduser("~")) / ".mini_harness"


def config_path() -> Path:
    """config.json 의 실제 경로를 결정한다.

    실행 폴더에 config.json 이 있으면(포터블 사용) 그걸 쓰고, 없으면 홈 디렉터리.
    """
    local = Path.cwd() / "config.json"
    if local.exists():
        return local
    return config_dir() / "config.json"


@dataclass
class Config:
    provider: str = "mock"          # openai / openrouter / mock
    api_key: str = ""
    model: str = "mock-agent"
    workspace: str = "./workspace"  # 에이전트가 다룰 작업 폴더 (하네스의 sandbox)
    approval_mode: str = "manual"   # manual / auto
    allow_shell: bool = False       # 셸 실행 도구 허용 여부 (기본 비활성: 안전)
    max_steps: int = 8              # Agent Loop 1회 실행의 최대 반복 횟수 (무한루프 방지)
    temperature: float = 0.2

    # ---- 직렬화 -------------------------------------------------------------
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        known = {f for f in cls().__dataclass_fields__}  # type: ignore[attr-defined]
        clean = {k: v for k, v in (data or {}).items() if k in known}
        return cls(**clean)

    # ---- 파생 경로 ----------------------------------------------------------
    def workspace_path(self) -> Path:
        """workspace 의 절대 경로. 상대경로는 config.json 위치 기준으로 해석."""
        p = Path(self.workspace).expanduser()
        if not p.is_absolute():
            base = config_path().parent
            p = (base / p).resolve()
        return p

    def is_ready(self) -> bool:
        """에이전트를 돌릴 준비가 되었는지(키 등) 확인."""
        if self.provider == "mock":
            return True
        return bool(self.api_key.strip())


def load_config() -> Config:
    """디스크에서 설정을 읽는다. 파일이 없으면 기본값."""
    path = config_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return Config.from_dict(data)
        except (json.JSONDecodeError, OSError):
            # 손상된 설정은 무시하고 기본값으로 되돌린다.
            return Config()
    return Config()


def save_config(cfg: Config) -> Path:
    """설정을 디스크에 저장하고 저장 경로를 반환한다."""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(cfg.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path
