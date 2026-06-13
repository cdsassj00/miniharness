"""하네스가 제공하는 '도구(tool)' 들.

LLM 은 생각만 한다. 실제 파일을 읽고/고치고/명령을 실행하는 것은 전부 하네스(=이 도구들)의 몫이다.
도구는 모두 작업 폴더(workspace) 안으로만 접근하도록 제한(sandbox)된다 — 이것이 하네스의 안전장치다.

각 도구는 OpenAI 호환 function-calling 스키마로도 노출된다(아래 tool_schemas()).
"""

from __future__ import annotations

import difflib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# 사람이 읽기 좋은 도구 한글 설명 (UI/로그용)
TOOL_LABELS = {
    "list_dir": "폴더 보기",
    "read_file": "파일 읽기",
    "write_file": "파일 수정",
    "run_shell": "셸 실행",
}

# 사용자 승인이 필요한(=환경을 바꾸는) 도구 집합.
# 읽기 전용 도구는 승인 없이 바로 실행 → 하네스가 위험도에 따라 차등 대우함을 교육.
MUTATING_TOOLS = {"write_file", "run_shell"}


class ToolError(Exception):
    """도구 실행 실패. 메시지는 모델에게 그대로 전달되어 스스로 정정하게 한다."""


@dataclass
class ToolResult:
    ok: bool
    output: str          # 모델에게 돌려줄 텍스트 결과
    detail: str = ""     # UI 로그용 부가 정보 (예: diff 전문)
    data: dict[str, Any] | None = None


class Toolbox:
    """workspace 에 묶인 도구 모음.

    모든 경로는 workspace 루트 안으로 강제된다(_resolve). 밖으로 나가면 ToolError.
    """

    def __init__(self, workspace: Path, allow_shell: bool = False) -> None:
        self.workspace = Path(workspace).resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.allow_shell = allow_shell

    # ---- 경로 sandbox -------------------------------------------------------
    def _resolve(self, rel: str) -> Path:
        rel = (rel or ".").strip()
        # 절대경로/홈경로가 들어와도 workspace 기준 상대경로로만 취급
        candidate = (self.workspace / rel).resolve()
        try:
            candidate.relative_to(self.workspace)
        except ValueError:
            raise ToolError(
                f"작업 폴더 밖 경로에는 접근할 수 없습니다: {rel} "
                f"(허용 루트: {self.workspace})"
            )
        return candidate

    def rel(self, p: Path) -> str:
        """workspace 기준 상대경로 문자열."""
        try:
            return str(Path(p).resolve().relative_to(self.workspace)) or "."
        except ValueError:
            return str(p)

    # ---- 개별 도구 ----------------------------------------------------------
    def list_dir(self, path: str = ".") -> ToolResult:
        target = self._resolve(path)
        if not target.exists():
            raise ToolError(f"경로가 없습니다: {path}")
        if target.is_file():
            return ToolResult(True, f"(파일) {self.rel(target)}")
        entries = []
        for child in sorted(target.iterdir()):
            kind = "DIR " if child.is_dir() else "FILE"
            size = "" if child.is_dir() else f"  {child.stat().st_size}B"
            entries.append(f"[{kind}] {self.rel(child)}{size}")
        listing = "\n".join(entries) if entries else "(빈 폴더)"
        return ToolResult(True, listing)

    def read_file(self, path: str) -> ToolResult:
        target = self._resolve(path)
        if not target.exists() or not target.is_file():
            raise ToolError(f"파일이 없습니다: {path}")
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise ToolError(f"텍스트 파일이 아닙니다(읽기 불가): {path}")
        # 너무 큰 파일은 잘라 모델 토큰을 보호
        if len(text) > 20000:
            text = text[:20000] + "\n... (이후 생략)"
        return ToolResult(True, text, detail=text)

    def preview_write(self, path: str, content: str) -> tuple[str, str]:
        """write_file 의 '제안'을 미리보기. (상대경로, unified diff) 반환.

        실제로 쓰지는 않는다 — 승인 다이얼로그가 이 diff 를 보여준다.
        """
        target = self._resolve(path)
        old = ""
        if target.exists() and target.is_file():
            try:
                old = target.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                old = ""
        diff = "\n".join(
            difflib.unified_diff(
                old.splitlines(),
                (content or "").splitlines(),
                fromfile=f"a/{self.rel(target)}",
                tofile=f"b/{self.rel(target)}",
                lineterm="",
            )
        )
        if not diff:
            diff = "(내용 변화 없음)"
        return self.rel(target), diff

    def write_file(self, path: str, content: str) -> ToolResult:
        """실제로 파일을 저장한다. (승인 이후에만 호출되어야 함)"""
        target = self._resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        existed = target.exists()
        target.write_text(content or "", encoding="utf-8")
        verb = "수정" if existed else "생성"
        return ToolResult(
            True,
            f"{self.rel(target)} 파일을 {verb}했습니다 ({len(content or '')}자).",
            detail=content or "",
        )

    def run_shell(self, command: str) -> ToolResult:
        if not self.allow_shell:
            raise ToolError("셸 실행이 설정에서 비활성화되어 있습니다(allow_shell=false).")
        if not command or not command.strip():
            raise ToolError("실행할 명령이 비어 있습니다.")
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(self.workspace),
                capture_output=True,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            raise ToolError("명령이 30초를 초과해 중단되었습니다.")
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        out = out.strip() or "(출력 없음)"
        if len(out) > 8000:
            out = out[:8000] + "\n... (이후 생략)"
        out = f"$ {command}\n(exit={proc.returncode})\n{out}"
        return ToolResult(proc.returncode == 0, out, detail=out)

    # ---- 디스패치 -----------------------------------------------------------
    def execute(self, name: str, args: dict[str, Any]) -> ToolResult:
        """승인이 끝난 도구 호출을 실제 실행한다."""
        args = args or {}
        if name == "list_dir":
            return self.list_dir(args.get("path", "."))
        if name == "read_file":
            return self.read_file(args.get("path", ""))
        if name == "write_file":
            return self.write_file(args.get("path", ""), args.get("content", ""))
        if name == "run_shell":
            return self.run_shell(args.get("command", ""))
        raise ToolError(f"알 수 없는 도구입니다: {name}")


def tool_schemas(allow_shell: bool = False) -> list[dict]:
    """OpenAI 호환 function-calling 스키마. allow_shell=False 면 셸 도구 제외."""
    schemas = [
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "작업 폴더(workspace) 안의 폴더 내용을 나열한다.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "작업 폴더 기준 상대 경로. 루트는 '.'",
                        }
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "작업 폴더 안의 텍스트 파일을 읽어 내용을 반환한다.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "읽을 파일의 상대 경로"}
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": (
                    "작업 폴더 안의 파일을 새 내용으로 만들거나 덮어쓴다. "
                    "전체 파일 내용을 content 로 전달해야 한다. 사용자 승인 후 적용된다."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "저장할 파일의 상대 경로"},
                        "content": {"type": "string", "description": "파일 전체 내용"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
    ]
    if allow_shell:
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": "run_shell",
                    "description": "작업 폴더에서 셸 명령을 실행한다. 사용자 승인 후 실행된다.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string", "description": "실행할 명령"}
                        },
                        "required": ["command"],
                    },
                },
            }
        )
    return schemas
