"""LLM 클라이언트.

OpenAI 와 OpenRouter 는 둘 다 동일한 ``/chat/completions`` (function-calling 포함) 형식을
쓰므로 한 코드로 처리한다. 외부 패키지 없이 표준 라이브러리 urllib 만 사용해
PyInstaller 빌드와 비개발자 배포를 단순화했다.

추가로 'mock' provider 를 제공한다. API Key 없이도 Agent Loop 전 과정을
체험할 수 있게 도구 호출을 흉내 내는 작은 결정형 에이전트다.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


class LLMError(Exception):
    """LLM 호출 실패 (네트워크/인증/응답 형식 등)."""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LLMReply:
    """모델의 한 번 응답을 정규화한 형태."""

    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: dict | None = None

    @property
    def wants_tool(self) -> bool:
        return bool(self.tool_calls)


ENDPOINTS = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
}


class LLMClient:
    def __init__(
        self,
        provider: str,
        api_key: str,
        model: str,
        temperature: float = 0.2,
        timeout: int = 60,
    ) -> None:
        self.provider = provider
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.timeout = timeout

    # ---- 공개 API -----------------------------------------------------------
    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> LLMReply:
        """대화 메시지(+도구 스키마)를 보내고 모델 응답을 받는다."""
        if self.provider == "mock":
            return _mock_chat(messages, tools)
        if self.provider not in ENDPOINTS:
            raise LLMError(f"지원하지 않는 provider 입니다: {self.provider}")
        return self._http_chat(messages, tools)

    # ---- HTTP (OpenAI 호환) -------------------------------------------------
    def _http_chat(self, messages: list[dict], tools: list[dict] | None) -> LLMReply:
        url = ENDPOINTS[self.provider]
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.provider == "openrouter":
            # OpenRouter 권장 헤더 (대시보드 식별용, 없어도 동작)
            headers["HTTP-Referer"] = "https://github.com/mini-harness"
            headers["X-Title"] = "Mini Harness"

        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")
            except Exception:  # noqa: BLE001
                pass
            raise LLMError(f"API 오류 {e.code}: {detail or e.reason}")
        except urllib.error.URLError as e:
            raise LLMError(f"네트워크 오류: {e.reason}")
        except json.JSONDecodeError:
            raise LLMError("응답을 JSON 으로 해석할 수 없습니다.")

        return _parse_openai_reply(payload)


def _parse_openai_reply(payload: dict) -> LLMReply:
    try:
        msg = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise LLMError(f"예상치 못한 응답 형식입니다: {json.dumps(payload)[:300]}")

    tool_calls: list[ToolCall] = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        raw_args = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
        except json.JSONDecodeError:
            args = {"_raw": raw_args}
        tool_calls.append(
            ToolCall(id=tc.get("id", f"call_{len(tool_calls)}"), name=fn.get("name", ""), arguments=args)
        )

    return LLMReply(content=msg.get("content"), tool_calls=tool_calls, raw=payload)


# ---------------------------------------------------------------------------
# Mock 에이전트: 키 없이 Agent Loop 전체(폴더 보기→읽기→수정 제안→승인)를 체험
# ---------------------------------------------------------------------------
def _mock_chat(messages: list[dict], tools: list[dict] | None) -> LLMReply:
    """대화 히스토리에 쌓인 tool 결과 개수로 '현재 단계'를 판단하는 결정형 에이전트."""
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    last_user = next(
        (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    phase = len(tool_msgs)

    if phase == 0:
        # 1) 먼저 작업 폴더를 살펴본다.
        return LLMReply(
            content="작업 폴더 구조부터 확인하겠습니다.",
            tool_calls=[ToolCall(id="mock_1", name="list_dir", arguments={"path": "."})],
        )

    if phase == 1:
        # 2) 목록에서 첫 텍스트 파일을 골라 읽는다(사용자가 파일명을 말했으면 그것).
        listing = tool_msgs[0].get("content", "")
        target = _guess_file(listing, last_user)
        return LLMReply(
            content=f"`{target}` 파일을 읽어 현재 내용을 확인하겠습니다.",
            tool_calls=[ToolCall(id="mock_2", name="read_file", arguments={"path": target})],
        )

    if phase == 2:
        # 3) 읽은 내용 끝에 한 줄 추가하는 수정을 '제안'한다(승인 단계 시연).
        listing = tool_msgs[0].get("content", "")
        target = _guess_file(listing, last_user)
        current = tool_msgs[1].get("content", "")
        addition = f"\n\n# (Mini Harness mock 에이전트가 추가) 요청: {last_user.strip()[:60]}"
        new_content = current.rstrip("\n") + addition + "\n"
        return LLMReply(
            content=f"`{target}` 끝에 메모 한 줄을 추가하는 수정을 제안합니다.",
            tool_calls=[
                ToolCall(
                    id="mock_3",
                    name="write_file",
                    arguments={"path": target, "content": new_content},
                )
            ],
        )

    # 4) 도구 사용을 마치고 최종 답변.
    return LLMReply(
        content=(
            "완료했습니다. 방금까지의 흐름이 바로 하네스의 Agent Loop 입니다:\n"
            "① 작업 폴더 보기 → ② 파일 읽기 → ③ 파일 수정 제안 → ④ 사용자 승인 → "
            "⑤ 저장 → ⑥ 결과를 다시 모델에 전달.\n"
            "실제 LLM 을 쓰려면 설정에서 OpenAI/OpenRouter provider 와 API Key 를 입력하세요."
        )
    )


def _guess_file(listing: str, user_text: str) -> str:
    """list_dir 결과 문자열에서 읽을 파일 하나를 고른다."""
    files = []
    for line in listing.splitlines():
        line = line.strip()
        if line.startswith("[FILE]"):
            # "[FILE] name.txt  12B" → name.txt
            rest = line[len("[FILE]"):].strip()
            name = rest.split("  ")[0].strip()
            files.append(name)
    # 사용자가 언급한 파일명이 목록에 있으면 우선
    for name in files:
        if name and name in user_text:
            return name
    return files[0] if files else "notes.txt"
