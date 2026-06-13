"""메인 윈도우 — 하네스 전 과정을 한 화면에서 보고 체험.

왼쪽: 작업 폴더 트리 (하네스가 다루는 sandbox)
가운데: 대화 + 입력
오른쪽: Agent Loop 다이어그램 + 세션 로그(상세 추적)
"""

from __future__ import annotations

import html
from pathlib import Path

from PySide6.QtCore import QDir, Qt
from PySide6.QtGui import QAction, QFont

# QFileSystemModel 의 위치는 PySide6 버전마다 다르다(QtWidgets ↔ QtGui). 둘 다 시도.
try:
    from PySide6.QtWidgets import QFileSystemModel
except ImportError:  # pragma: no cover
    from PySide6.QtGui import QFileSystemModel
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextEdit,
    QTreeView,
    QVBoxLayout,
    QWidget,
)

from .. import APP_NAME, APP_VERSION
from ..agent.events import STEP_LABELS, Event, Step
from ..agent.loop import AgentLoop, ApprovalDecision, ApprovalRequest
from ..agent.session import SessionLog, sessions_dir
from ..agent.tools import Toolbox
from ..config import Config, load_config, save_config
from ..llm import LLMClient
from .approval_dialog import ApprovalDialog
from .loop_view import LoopView
from .settings_dialog import SettingsDialog
from .worker import AgentWorker


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.config: Config = load_config()
        self.loop: AgentLoop | None = None
        self.worker: AgentWorker | None = None

        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION}")
        self.resize(1280, 800)

        self._build_menu()
        self._build_body()
        self._refresh_status()

        if not self.config.is_ready():
            self._append_system(
                "환영합니다! 좌측 상단 <b>설정</b>에서 provider 와 API Key 를 입력하거나, "
                "키 없이 체험하려면 provider 를 <b>mock</b> 으로 두세요."
            )

    # ---- 메뉴/툴바 ----------------------------------------------------------
    def _build_menu(self) -> None:
        bar = self.menuBar()
        file_menu = bar.addMenu("파일")

        settings_act = QAction("설정…", self)
        settings_act.triggered.connect(self.open_settings)
        file_menu.addAction(settings_act)

        reset_act = QAction("새 대화(컨텍스트 초기화)", self)
        reset_act.triggered.connect(self.reset_session)
        file_menu.addAction(reset_act)

        sessions_act = QAction("세션 로그 폴더 경로 보기", self)
        sessions_act.triggered.connect(self.show_sessions_path)
        file_menu.addAction(sessions_act)

        file_menu.addSeparator()
        quit_act = QAction("종료", self)
        quit_act.triggered.connect(self.close)
        file_menu.addAction(quit_act)

        help_menu = bar.addMenu("도움말")
        about_act = QAction("Mini Harness 란?", self)
        about_act.triggered.connect(self.show_about)
        help_menu.addAction(about_act)

    # ---- 본문 레이아웃 ------------------------------------------------------
    def _build_body(self) -> None:
        splitter = QSplitter(Qt.Horizontal)
        self.setCentralWidget(splitter)

        # 좌: 작업 폴더 트리
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(4, 4, 4, 4)
        left_layout.addWidget(QLabel("📁 작업 폴더 (workspace)"))
        self.fs_model = QFileSystemModel()
        self.fs_model.setFilter(QDir.AllEntries | QDir.NoDotAndDotDot)
        self.tree = QTreeView()
        self.tree.setModel(self.fs_model)
        self.tree.setColumnHidden(2, True)
        self.tree.setColumnHidden(3, True)
        self.tree.doubleClicked.connect(self._preview_file)
        left_layout.addWidget(self.tree, 1)
        refresh_btn = QPushButton("새로고침")
        refresh_btn.clicked.connect(self._refresh_tree)
        left_layout.addWidget(refresh_btn)
        splitter.addWidget(left)

        # 가운데: 대화 + 입력
        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(4, 4, 4, 4)
        self.transcript = QTextEdit()
        self.transcript.setReadOnly(True)
        center_layout.addWidget(self.transcript, 1)

        input_row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("에이전트에게 시킬 일을 입력하세요. 예: notes.txt 에 오늘 할 일 정리해줘")
        self.input.returnPressed.connect(self.on_send)
        self.send_btn = QPushButton("보내기")
        self.send_btn.clicked.connect(self.on_send)
        self.cancel_btn = QPushButton("중단")
        self.cancel_btn.clicked.connect(self.on_cancel)
        self.cancel_btn.setEnabled(False)
        input_row.addWidget(self.input, 1)
        input_row.addWidget(self.send_btn)
        input_row.addWidget(self.cancel_btn)
        center_layout.addLayout(input_row)
        splitter.addWidget(center)

        # 우: 루프 다이어그램 + 로그
        right = QTabWidget()
        self.loop_view = LoopView()
        right.addTab(self.loop_view, "Agent Loop")
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        self.log.setFont(QFont("Consolas", 9))
        right.addTab(self.log, "세션 로그")
        splitter.addWidget(right)

        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 5)
        splitter.setStretchFactor(2, 3)

        self._refresh_tree()

    # ---- 상태/도우미 --------------------------------------------------------
    def _refresh_status(self) -> None:
        ws = self.config.workspace_path()
        self.statusBar().showMessage(
            f"provider={self.config.provider} · model={self.config.model} · "
            f"승인={self.config.approval_mode} · 셸={'on' if self.config.allow_shell else 'off'} · "
            f"workspace={ws}"
        )

    def _refresh_tree(self) -> None:
        ws = self.config.workspace_path()
        ws.mkdir(parents=True, exist_ok=True)
        self.fs_model.setRootPath(str(ws))
        self.tree.setRootIndex(self.fs_model.index(str(ws)))

    def _preview_file(self, index) -> None:
        path = Path(self.fs_model.filePath(index))
        if not path.is_file():
            return
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            QMessageBox.information(self, "미리보기", "텍스트로 열 수 없는 파일입니다.")
            return
        dlg = QDialog(self)
        dlg.setWindowTitle(f"미리보기 — {path.name}")
        dlg.resize(700, 520)
        lay = QVBoxLayout(dlg)
        viewer = QPlainTextEdit()
        viewer.setReadOnly(True)
        viewer.setPlainText(text)
        viewer.setFont(QFont("Consolas", 10))
        lay.addWidget(viewer)
        dlg.exec()

    # ---- 대화 출력 ----------------------------------------------------------
    def _append_html(self, html_text: str) -> None:
        self.transcript.append(html_text)
        self.transcript.ensureCursorVisible()

    def _append_system(self, text: str) -> None:
        self._append_html(f"<div style='color:#9ca3af;'>ℹ️ {text}</div>")

    def _append_user(self, text: str) -> None:
        self._append_html(
            f"<div style='margin-top:8px;'><b style='color:#60a5fa;'>🧑 사용자</b><br>"
            f"{html.escape(text)}</div>"
        )

    def _append_assistant(self, text: str) -> None:
        self._append_html(
            f"<div style='margin-top:6px;'><b style='color:#34d399;'>🤖 모델</b><br>"
            f"{html.escape(text).replace(chr(10), '<br>')}</div>"
        )

    def _append_tool(self, text: str) -> None:
        self._append_html(f"<div style='color:#fbbf24;'>🔧 {html.escape(text)}</div>")

    def _log_event(self, ev: Event) -> None:
        label = STEP_LABELS.get(ev.step, ev.step.value)
        detail = (ev.detail or "").strip()
        if len(detail) > 1200:
            detail = detail[:1200] + " …(생략)"
        block = f"[{label}] {ev.title}"
        if detail:
            block += "\n    " + detail.replace("\n", "\n    ")
        self.log.append(html.escape(block))
        self.log.ensureCursorVisible()

    # ---- 액션 ---------------------------------------------------------------
    def open_settings(self) -> None:
        dlg = SettingsDialog(self.config, self)
        if dlg.exec() == QDialog.Accepted:
            self.config = dlg.result_config()
            save_config(self.config)
            self.loop = None  # 설정이 바뀌면 다음 전송 때 루프 재생성
            self._refresh_status()
            self._refresh_tree()
            self._append_system("설정을 저장했습니다.")

    def reset_session(self) -> None:
        if self.worker and self.worker.isRunning():
            return
        self.loop = None
        self.loop_view.reset()
        self.transcript.clear()
        self.log.clear()
        self._append_system("새 대화를 시작합니다. (컨텍스트 초기화됨)")

    def show_sessions_path(self) -> None:
        QMessageBox.information(self, "세션 로그", f"세션 로그 저장 위치:\n{sessions_dir()}")

    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "Mini Harness 란?",
            "Mini Harness 는 'AI 코딩 에이전트의 하네스 원리'를 눈으로 이해하는 교육용 앱입니다.\n\n"
            "• LLM 은 '생각'만 합니다.\n"
            "• 하네스는 규칙 읽기 / 파일 읽기·수정 / 도구 실행 / 사용자 승인 / 로그 기록 / 반복을 담당합니다.\n"
            "• 이 반복 구조가 바로 Agent Loop 이며, Claude Code·Codex·OpenCode 의 핵심입니다.",
        )

    def _ensure_loop(self) -> AgentLoop | None:
        if self.loop is not None:
            return self.loop
        if not self.config.is_ready():
            QMessageBox.warning(self, "설정 필요",
                                "API Key 가 필요합니다. 설정에서 입력하거나 provider 를 mock 으로 바꾸세요.")
            self.open_settings()
            return None
        try:
            client = LLMClient(
                provider=self.config.provider,
                api_key=self.config.api_key,
                model=self.config.model,
                temperature=self.config.temperature,
            )
            toolbox = Toolbox(self.config.workspace_path(), allow_shell=self.config.allow_shell)
            session = SessionLog.create()
            # on_event/approval_callback 은 워커가 생성 시 연결하므로 임시 no-op
            self.loop = AgentLoop(
                config=self.config,
                client=client,
                toolbox=toolbox,
                on_event=lambda ev: None,
                approval_callback=lambda req: ApprovalDecision(False),
                session=session,
            )
            self.loop.reset()
            return self.loop
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "초기화 오류", str(e))
            return None

    def on_send(self) -> None:
        if self.worker and self.worker.isRunning():
            return
        text = self.input.text().strip()
        if not text:
            return
        loop = self._ensure_loop()
        if loop is None:
            return

        self.input.clear()
        self._append_user(text)
        self.loop_view.reset()

        self.worker = AgentWorker(loop, text)
        self.worker.event_occurred.connect(self.on_event)
        self.worker.approval_requested.connect(self.on_approval)
        self.worker.turn_finished.connect(self.on_turn_finished)

        self.send_btn.setEnabled(False)
        self.input.setEnabled(False)
        self.cancel_btn.setEnabled(True)
        self.worker.start()

    def on_cancel(self) -> None:
        if self.worker and self.worker.isRunning():
            self.worker.cancel()
            self._append_system("중단을 요청했습니다…")

    # ---- 워커 시그널 핸들러 (메인 스레드) -----------------------------------
    def on_event(self, ev: Event) -> None:
        self.loop_view.on_step(ev.step)
        self._log_event(ev)

        if ev.step == Step.MODEL_REPLY and ev.detail and ev.detail != "(텍스트 없음)":
            self._append_assistant(ev.detail)
        elif ev.step == Step.TOOL_RUN:
            self._append_tool(f"도구 실행: {ev.title.replace('도구 실행: ', '')} — {ev.detail[:120]}")
        elif ev.step == Step.APPROVAL and ("거부" in ev.title or "자동 승인" in ev.title or "승인됨" in ev.title):
            self._append_system(ev.title)
        elif ev.step == Step.ERROR:
            self._append_html(f"<div style='color:#f87171;'>❌ {html.escape(ev.title)}: "
                              f"{html.escape(ev.detail)}</div>")

    def on_approval(self, req: ApprovalRequest) -> None:
        dlg = ApprovalDialog(req, self)
        approved = dlg.exec() == QDialog.Accepted
        reason = "" if approved else "사용자가 변경을 거부했습니다."
        if self.worker:
            self.worker.provide_decision(ApprovalDecision(approved, reason))

    def on_turn_finished(self, _result: str) -> None:
        self.loop_view.mark_done()
        self.send_btn.setEnabled(True)
        self.input.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.input.setFocus()
        self._refresh_tree()
        self._append_html("<hr>")

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.worker and self.worker.isRunning():
            self.worker.cancel()
            self.worker.wait(2000)
        if self.loop and self.loop.session:
            self.loop.session.close()
        super().closeEvent(event)
