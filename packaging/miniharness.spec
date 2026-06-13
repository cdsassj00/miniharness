# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 스펙 — Mini Harness 를 단일 실행 파일로 빌드.

사용법 (저장소 루트에서):
    pip install pyinstaller PySide6
    pyinstaller packaging/miniharness.spec

결과: dist/MiniHarness/MiniHarness(.exe)
샘플 workspace 폴더를 함께 번들해 첫 실행부터 체험할 수 있게 한다.
"""

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

a = Analysis(
    ["../run.py"],
    pathex=["."],
    binaries=[],
    # 샘플 작업 폴더를 실행 파일 옆에 함께 배치
    datas=[("../workspace", "workspace")],
    hiddenimports=collect_submodules("miniharness"),
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MiniHarness",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # GUI 앱: 콘솔 창 숨김
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
    name="MiniHarness",
)
