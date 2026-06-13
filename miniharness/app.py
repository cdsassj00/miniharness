"""앱 진입점: QApplication 부트스트랩."""

from __future__ import annotations

import sys


def main() -> int:
    from PySide6.QtWidgets import QApplication

    from . import APP_NAME
    from .ui.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    _apply_dark_theme(app)

    win = MainWindow()
    win.show()
    return app.exec()


def _apply_dark_theme(app) -> None:
    """가벼운 다크 테마. (교육 데모에서 단계 색 대비가 잘 보이도록)"""
    app.setStyleSheet(
        """
        QWidget { background:#1e2129; color:#e5e7eb; font-size:13px; }
        QTextEdit, QPlainTextEdit, QLineEdit, QTreeView, QComboBox, QSpinBox {
            background:#262a33; border:1px solid #3a3f4b; border-radius:4px;
        }
        QPushButton {
            background:#3b82f6; color:white; border:none; border-radius:4px;
            padding:6px 14px;
        }
        QPushButton:disabled { background:#3a3f4b; color:#8b8f99; }
        QPushButton:hover:!disabled { background:#2563eb; }
        QTabBar::tab { background:#262a33; padding:6px 12px; }
        QTabBar::tab:selected { background:#3b82f6; }
        QMenuBar, QMenu { background:#1e2129; }
        QMenu::item:selected, QMenuBar::item:selected { background:#3b82f6; }
        """
    )


if __name__ == "__main__":
    raise SystemExit(main())
