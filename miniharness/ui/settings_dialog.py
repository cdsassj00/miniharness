"""API Key / provider / model / workspace 등 설정 화면."""

from __future__ import annotations

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..config import APPROVAL_MODES, PROVIDERS, SUGGESTED_MODELS, Config


class SettingsDialog(QDialog):
    def __init__(self, cfg: Config, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("설정 — Mini Harness")
        self.setMinimumWidth(560)
        self._cfg = cfg

        root = QVBoxLayout(self)
        form = QFormLayout()
        root.addLayout(form)

        # Provider
        self.provider = QComboBox()
        self.provider.addItems(PROVIDERS)
        self.provider.setCurrentText(cfg.provider)
        self.provider.currentTextChanged.connect(self._on_provider_changed)
        form.addRow("Provider", self.provider)

        # API Key
        self.api_key = QLineEdit(cfg.api_key)
        self.api_key.setEchoMode(QLineEdit.Password)
        self.api_key.setPlaceholderText("sk-... (mock provider 는 비워도 됨)")
        self.show_key = QCheckBox("표시")
        self.show_key.toggled.connect(
            lambda on: self.api_key.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password)
        )
        key_row = QHBoxLayout()
        key_row.addWidget(self.api_key, 1)
        key_row.addWidget(self.show_key)
        key_wrap = QWidget()
        key_wrap.setLayout(key_row)
        form.addRow("API Key", key_wrap)

        # Model (편집 가능 콤보)
        self.model = QComboBox()
        self.model.setEditable(True)
        self.model.setCurrentText(cfg.model)
        form.addRow("Model", self.model)

        # Workspace
        self.workspace = QLineEdit(cfg.workspace)
        browse = QPushButton("폴더 선택…")
        browse.clicked.connect(self._browse_workspace)
        ws_row = QHBoxLayout()
        ws_row.addWidget(self.workspace, 1)
        ws_row.addWidget(browse)
        ws_wrap = QWidget()
        ws_wrap.setLayout(ws_row)
        form.addRow("작업 폴더", ws_wrap)

        # 승인 모드
        self.approval = QComboBox()
        self.approval.addItems(APPROVAL_MODES)
        self.approval.setCurrentText(cfg.approval_mode)
        form.addRow("승인 모드", self.approval)
        hint = QLabel("manual: 파일 수정/셸 실행마다 승인 요청 · auto: 자동 승인")
        hint.setStyleSheet("color:#9ca3af; font-size:11px;")
        form.addRow("", hint)

        # 셸 허용
        self.allow_shell = QCheckBox("셸 실행 도구(run_shell) 허용 (주의: 위험)")
        self.allow_shell.setChecked(cfg.allow_shell)
        form.addRow("", self.allow_shell)

        # max steps / temperature
        self.max_steps = QSpinBox()
        self.max_steps.setRange(1, 50)
        self.max_steps.setValue(cfg.max_steps)
        form.addRow("최대 반복(max_steps)", self.max_steps)

        self._refresh_models(cfg.provider, keep=cfg.model)

        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

    def _on_provider_changed(self, provider: str) -> None:
        self._refresh_models(provider, keep=self.model.currentText())
        if provider == "mock":
            self.api_key.setEnabled(False)
        else:
            self.api_key.setEnabled(True)

    def _refresh_models(self, provider: str, keep: str = "") -> None:
        self.model.blockSignals(True)
        self.model.clear()
        self.model.addItems(SUGGESTED_MODELS.get(provider, []))
        if keep:
            self.model.setCurrentText(keep)
        elif self.model.count():
            self.model.setCurrentIndex(0)
        self.model.blockSignals(False)
        self.api_key.setEnabled(provider != "mock")

    def _browse_workspace(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "작업 폴더 선택", self.workspace.text())
        if path:
            self.workspace.setText(path)

    def result_config(self) -> Config:
        """다이얼로그 입력을 Config 로 만든다."""
        return Config(
            provider=self.provider.currentText().strip(),
            api_key=self.api_key.text().strip(),
            model=self.model.currentText().strip(),
            workspace=self.workspace.text().strip() or "./workspace",
            approval_mode=self.approval.currentText().strip(),
            allow_shell=self.allow_shell.isChecked(),
            max_steps=self.max_steps.value(),
            temperature=self._cfg.temperature,
        )
