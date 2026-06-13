"""CDSA Harness TUI 본체.

GUI 와 동일한 코어를 쓴다:
  AgentLoop( on_event=<단계를 색으로 출력>, approval_callback=<터미널에서 y/N> )
"""

from __future__ import annotations

import argparse
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm
from rich.rule import Rule
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text

from .. import APP_VERSION
from ..agent.events import Event, Step
from ..agent.loop import AgentLoop, ApprovalDecision, ApprovalRequest
from ..agent.session import SessionLog, sessions_dir
from ..agent.tools import Toolbox
from ..config import Config, config_path, load_config, save_config
from ..llm import LLMClient
from .banner import banner_renderable

TUI_NAME = "CDSA Harness"

# 단계별 표시 (아이콘 / 색)
STEP_STYLE = {
    Step.USER_INPUT: ("🧑", "cyan"),
    Step.BUILD_CONTEXT: ("🧱", "grey62"),
    Step.MODEL_CALL: ("🧠", "magenta"),
    Step.MODEL_REPLY: ("🤖", "green"),
    Step.TOOL_DECISION: ("🤔", "yellow"),
    Step.APPROVAL: ("🔐", "yellow"),
    Step.TOOL_RUN: ("🔧", "blue"),
    Step.TOOL_RESULT: ("📄", "grey62"),
    Step.DONE: ("✅", "bold green"),
    Step.ERROR: ("❌", "bold red"),
}


class TuiPrinter:
    """Agent Loop 이벤트를 터미널에 단계별로 흘려보낸다."""

    def __init__(self, console: Console) -> None:
        self.console = console

    def __call__(self, ev: Event) -> None:
        icon, color = STEP_STYLE.get(ev.step, ("•", "white"))

        # 승인 단계는 approval_callback 이 직접 UI 를 그리므로 여기선 자동승인 안내만
        if ev.step == Step.APPROVAL and "자동 승인" not in ev.title:
            return

        if ev.step == Step.MODEL_REPLY:
            if ev.detail and ev.detail != "(텍스트 없음)":
                self.console.print(
                    Panel(ev.detail, title="🤖 모델", border_style="green", expand=False)
                )
            return

        if ev.step == Step.DONE:
            self.console.print(
                Panel(ev.detail or "완료", title=f"{icon} 완료", border_style="green")
            )
            return

        if ev.step == Step.ERROR:
            self.console.print(
                Panel(ev.detail, title=f"{icon} {ev.title}", border_style="red")
            )
            return

        # 일반 단계: 한 줄 라벨 + 짧은 상세
        line = Text()
        line.append(f"{icon} ", style=color)
        line.append(ev.title, style=f"bold {color}")
        detail = (ev.detail or "").strip().replace("\n", " ")
        if detail and ev.step not in (Step.USER_INPUT,):
            if len(detail) > 110:
                detail = detail[:110] + " …"
            line.append(f"  {detail}", style="grey70")
        self.console.print(line)


def make_approval_callback(console: Console):
    """write_file/run_shell 승인 프롬프트(터미널)."""

    def approve(req: ApprovalRequest) -> ApprovalDecision:
        if req.tool_name == "write_file":
            console.print(
                Panel(
                    Syntax(req.diff or "(변경 미리보기 없음)", "diff", theme="ansi_dark"),
                    title=f"🔐 파일 수정 제안 — {req.path}",
                    border_style="yellow",
                )
            )
        elif req.tool_name == "run_shell":
            console.print(
                Panel(req.command, title="🔐 셸 실행 제안", border_style="red")
            )
        else:
            console.print(Panel(str(req.args), title=f"🔐 {req.tool_label}", border_style="yellow"))

        try:
            ok = Confirm.ask("[bold yellow]이 작업을 승인하시겠습니까?[/]", default=False)
        except (EOFError, KeyboardInterrupt):
            ok = False
        return ApprovalDecision(ok, "" if ok else "사용자가 거부했습니다.")

    return approve


def print_intro(console: Console, cfg: Config) -> None:
    console.print(banner_renderable())
    console.print()

    table = Table.grid(padding=(0, 2))
    table.add_column(style="grey62")
    table.add_column(style="bold")
    table.add_row("버전", f"v{APP_VERSION}")
    table.add_row("provider", cfg.provider)
    table.add_row("model", cfg.model)
    table.add_row("작업 폴더", str(cfg.workspace_path()))
    table.add_row("승인 모드", cfg.approval_mode)
    table.add_row("셸 실행", "허용" if cfg.allow_shell else "차단")
    console.print(Panel(table, title=f"⚙️  {TUI_NAME} 설정", border_style="cyan", expand=False))

    console.print(
        "[dim]명령:[/] [cyan]/help[/] 도움말 · [cyan]/reset[/] 새 대화 · "
        "[cyan]/config[/] 설정값 · [cyan]/quit[/] 종료\n"
    )


def print_help(console: Console) -> None:
    console.print(
        Panel(
            "[bold]사용법[/]\n"
            "그냥 시키고 싶은 일을 입력하면 됩니다. 예) [cyan]notes.txt 맨 아래에 할 일 3개 추가해줘[/]\n\n"
            "[bold]슬래시 명령[/]\n"
            "  [cyan]/help[/]    이 도움말\n"
            "  [cyan]/reset[/]   대화/컨텍스트 초기화 (새 세션)\n"
            "  [cyan]/config[/]  현재 설정값과 config.json 경로\n"
            "  [cyan]/sessions[/] 세션 로그 폴더 경로\n"
            "  [cyan]/quit[/]    종료 (Ctrl+D 도 가능)\n\n"
            "[bold]하네스 흐름[/] (각 단계가 위에 색으로 표시됩니다)\n"
            "  입력 → 컨텍스트 구성 → LLM 호출 → 도구 판단 → 승인 → 실행 → 결과 반영 → 반복",
            title="도움말",
            border_style="cyan",
        )
    )


def build_loop(cfg: Config, console: Console) -> AgentLoop:
    client = LLMClient(cfg.provider, cfg.api_key, cfg.model, temperature=cfg.temperature)
    toolbox = Toolbox(cfg.workspace_path(), allow_shell=cfg.allow_shell)
    session = SessionLog.create()
    loop = AgentLoop(
        config=cfg,
        client=client,
        toolbox=toolbox,
        on_event=TuiPrinter(console),
        approval_callback=make_approval_callback(console),
        session=session,
    )
    loop.reset()
    return loop


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cdsa-harness", description="CDSA Harness TUI")
    parser.add_argument("--provider", help="openai / openrouter / mock")
    parser.add_argument("--model", help="모델 이름")
    parser.add_argument("--workspace", help="작업 폴더 경로")
    parser.add_argument("--auto", action="store_true", help="승인 자동(approval_mode=auto)")
    args = parser.parse_args(argv)

    console = Console()
    cfg = load_config()
    if args.provider:
        cfg.provider = args.provider
    if args.model:
        cfg.model = args.model
    if args.workspace:
        # CLI 로 넘긴 경로는 '현재 폴더' 기준으로 해석(직관적)
        cfg.workspace = str(Path(args.workspace).resolve())
    if args.auto:
        cfg.approval_mode = "auto"

    # 키가 없으면 mock 으로 폴백해 즉시 체험 가능하게
    if not cfg.is_ready():
        console.print(
            "[yellow]API Key 가 없어 mock 모드로 실행합니다.[/] "
            f"실제 LLM 을 쓰려면 {config_path()} 에 provider/api_key 를 설정하세요.\n"
        )
        cfg.provider = "mock"
        cfg.model = "mock-agent"

    print_intro(console, cfg)

    try:
        loop = build_loop(cfg, console)
    except Exception as e:  # noqa: BLE001
        console.print(f"[bold red]초기화 실패:[/] {e}")
        return 1

    while True:
        try:
            user = console.input("[bold cyan]› [/]").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]종료합니다. 안녕히 가세요![/]")
            break

        if not user:
            continue

        low = user.lower()
        if low in ("/quit", "/exit", "quit", "exit", ":q"):
            break
        if low == "/help":
            print_help(console)
            continue
        if low == "/reset":
            loop.reset()
            console.print("[green]컨텍스트를 초기화했습니다(새 세션).[/]")
            continue
        if low == "/config":
            print_intro(console, cfg)
            console.print(f"[dim]config.json:[/] {config_path()}")
            continue
        if low == "/sessions":
            console.print(f"[dim]세션 로그 폴더:[/] {sessions_dir()}")
            continue

        console.print(Rule(style="grey30"))
        try:
            loop.run(user)
        except Exception as e:  # noqa: BLE001
            console.print(f"[bold red]실행 오류:[/] {e}")
        console.print(Rule(style="grey30"))

    if loop.session:
        loop.session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
