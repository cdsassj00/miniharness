"""Agent Loop 단계 다이어그램 위젯.

루프가 진행될 때 현재 단계를 점등시켜 "지금 하네스가 무엇을 하는지"를 한눈에 보여준다.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QLabel, QVBoxLayout, QWidget

from ..agent.events import LOOP_ORDER, STEP_LABELS, Step

_IDLE = "background:#2b2f3a; color:#aab; border:1px solid #3a3f4b;"
_ACTIVE = "background:#3b82f6; color:white; border:1px solid #60a5fa; font-weight:bold;"
_DONE = "background:#1f3b2b; color:#7fd1a3; border:1px solid #2f5d44;"
_ERROR = "background:#4a1f24; color:#f7a8b1; border:1px solid #7d2f38; font-weight:bold;"


class LoopView(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._chips: dict[Step, QLabel] = {}
        self._seen: set[Step] = set()

        root = QVBoxLayout(self)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(4)

        title = QLabel("Agent Loop")
        title.setStyleSheet("font-weight:bold; font-size:14px; color:#e5e7eb;")
        root.addWidget(title)

        self.iter_label = QLabel("반복: 0")
        self.iter_label.setStyleSheet("color:#9ca3af; font-size:11px;")
        root.addWidget(self.iter_label)

        for i, step in enumerate(LOOP_ORDER):
            chip = QLabel(f"{i+1}. {STEP_LABELS[step]}")
            chip.setAlignment(Qt.AlignCenter)
            chip.setMinimumHeight(30)
            chip.setStyleSheet(self._style(_IDLE))
            self._chips[step] = chip
            root.addWidget(chip)
            if i < len(LOOP_ORDER) - 1:
                arrow = QLabel("↓")
                arrow.setAlignment(Qt.AlignCenter)
                arrow.setStyleSheet("color:#6b7280;")
                root.addWidget(arrow)

        root.addStretch(1)
        self._iterations = 0

    @staticmethod
    def _style(base: str) -> str:
        return f"QLabel {{ {base} border-radius:6px; padding:4px 8px; }}"

    def reset(self) -> None:
        self._seen.clear()
        self._iterations = 0
        self.iter_label.setText("반복: 0")
        for chip in self._chips.values():
            chip.setStyleSheet(self._style(_IDLE))

    def on_step(self, step: Step) -> None:
        if step == Step.MODEL_CALL:
            self._iterations += 1
            self.iter_label.setText(f"반복: {self._iterations}")

        if step == Step.ERROR:
            # 활성 칩이 없으면 첫 칩을 에러로
            for chip in self._chips.values():
                pass
            return

        if step not in self._chips:
            return  # DONE 등 다이어그램 밖 단계는 무시

        # 이전 활성 칩들은 'done'으로, 현재 칩은 'active'로
        for s, chip in self._chips.items():
            if s == step:
                chip.setStyleSheet(self._style(_ACTIVE))
                self._seen.add(s)
            elif s in self._seen:
                chip.setStyleSheet(self._style(_DONE))

    def mark_done(self) -> None:
        for s in self._seen:
            self._chips[s].setStyleSheet(self._style(_DONE))
