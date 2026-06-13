"""파일 수정/셸 실행 승인 다이얼로그.

하네스의 핵심: 환경을 바꾸는 행동은 사용자가 '직접' 허락해야 한다.
변경 내용(diff) 또는 실행할 명령을 보여주고 승인/거부를 받는다.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QLabel,
    QPlainTextEdit,
    QVBoxLayout,
)

from ..agent.loop import ApprovalRequest


class ApprovalDialog(QDialog):
    def __init__(self, req: ApprovalRequest, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("승인 요청 — Mini Harness")
        self.setMinimumSize(640, 460)
        self.req = req

        layout = QVBoxLayout(self)

        if req.tool_name == "write_file":
            head = QLabel(f"에이전트가 <b>{req.path}</b> 파일을 수정하려고 합니다.<br>"
                          f"아래 변경 내용(diff)을 검토하고 승인하세요.")
            body = req.diff or "(변경 내용 미리보기를 만들 수 없습니다)"
        elif req.tool_name == "run_shell":
            head = QLabel("에이전트가 셸 명령을 실행하려고 합니다. 실행할 명령을 확인하세요.")
            body = req.command
        else:
            head = QLabel(f"에이전트가 도구 '{req.tool_label}' 실행을 요청합니다.")
            body = str(req.args)

        head.setWordWrap(True)
        head.setTextFormat(Qt.RichText)
        layout.addWidget(head)

        viewer = QPlainTextEdit()
        viewer.setReadOnly(True)
        viewer.setPlainText(body)
        viewer.setStyleSheet("font-family: Consolas, 'Courier New', monospace;")
        layout.addWidget(viewer, 1)

        buttons = QDialogButtonBox()
        self.approve_btn = buttons.addButton("승인 (실행)", QDialogButtonBox.AcceptRole)
        self.deny_btn = buttons.addButton("거부", QDialogButtonBox.RejectRole)
        self.approve_btn.setStyleSheet("background:#16a34a; color:white; padding:6px 14px;")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
