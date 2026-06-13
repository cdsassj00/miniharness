# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 스펙 — CDSA Harness(TUI)를 콘솔 실행 파일로 빌드.

사용법 (저장소 루트에서):
    pip install pyinstaller rich pyfiglet
    pyinstaller packaging/cdsa_harness.spec

결과: dist/CDSAHarness/CDSAHarness(.exe)  — 터미널에서 실행하는 콘솔 앱
"""

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

# pyfiglet 의 폰트 데이터(.flf)를 함께 번들해야 배너가 정상 렌더된다.
datas = [("../workspace", "workspace")]
try:
    datas += collect_data_files("pyfiglet")
except Exception:
    pass

a = Analysis(
    ["../tui.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=collect_submodules("miniharness"),
    hookspath=[],
    runtime_hooks=[],
    excludes=["PySide6", "tkinter", "matplotlib", "numpy"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CDSAHarness",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,           # TUI: 콘솔 창 유지
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="CDSAHarness",
)
