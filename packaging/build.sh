#!/usr/bin/env bash
# Mini Harness - Linux/macOS 빌드 스크립트
# 저장소 루트에서 실행:  bash packaging/build.sh
set -e

echo "=== Mini Harness 빌드 시작 ==="
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install PySide6 pyinstaller
pyinstaller packaging/miniharness.spec --noconfirm
echo
echo "=== 빌드 완료 ==="
echo "실행 파일: dist/MiniHarness/MiniHarness"
