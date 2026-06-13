"""CDSA Harness — 터미널(TUI) 프런트엔드.

GUI(Mini Harness)와 '똑같은 코어'(agent/llm/config)를 재사용한다.
터미널은 본질적으로 순차/블로킹이라 스레드가 필요 없고, Agent Loop 의 각 단계를
색으로 흘려보내면 Claude Code / OpenCode / Codex 같은 체험이 된다.

실행:  python -m miniharness.tui   또는   python tui.py
"""
