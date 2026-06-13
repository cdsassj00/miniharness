"""시작 배너(ASCII 아트).

pyfiglet 이 있으면 'CDSA Harness' 를 멋진 폰트로 생성하고,
없으면 하드코딩 폴백 배너를 쓴다(의존성 없이도 항상 동작).
"""

from __future__ import annotations

# pyfiglet 미설치 시 사용할 폴백 (slant 폰트로 미리 렌더)
_FALLBACK = r"""
   __________  _____ ___       __  __
  / ____/ __ \/ ___//   |     / / / /___ __________  ___  __________
 / /   / / / /\__ \/ /| |    / /_/ / __ `/ ___/ __ \/ _ \/ ___/ ___/
/ /___/ /_/ /___/ / ___ |   / __  / /_/ / /  / / / /  __(__  |__  )
\____/_____//____/_/  |_|  /_/ /_/\__,_/_/  /_/ /_/\___/____/____/
"""

# 배너에 입힐 그라데이션 색 (위→아래로 순환)
GRADIENT = ["#22d3ee", "#38bdf8", "#3b82f6", "#6366f1", "#8b5cf6"]


def render_banner_text(font: str = "slant") -> str:
    """배너 ASCII 문자열을 반환."""
    try:
        from pyfiglet import Figlet  # 선택적 의존성

        art = Figlet(font=font, width=100).renderText("CDSA Harness")
        # 빈 줄 정리
        lines = [ln for ln in art.rstrip("\n").splitlines() if ln.strip()]
        return "\n".join(lines)
    except Exception:  # noqa: BLE001 — pyfiglet 없거나 폰트 오류 시 폴백
        return _FALLBACK.strip("\n")


def banner_renderable():
    """rich 로 그라데이션을 입힌 배너 + 부제를 담은 렌더러블을 만든다."""
    from rich.console import Group
    from rich.text import Text

    art = render_banner_text()
    lines = art.splitlines()
    text = Text()
    for i, line in enumerate(lines):
        text.append(line + "\n", style=f"bold {GRADIENT[i % len(GRADIENT)]}")

    subtitle = Text(
        "좁은 의미의 하네스를 터미널에서 체험하는 미니 AI 에이전트 런타임",
        style="dim italic",
    )
    return Group(text, subtitle)
