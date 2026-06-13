@echo off
REM Mini Harness - Windows 빌드 스크립트
REM 저장소 루트에서 실행하세요:  packaging\build_windows.bat

echo === Mini Harness 빌드 시작 ===

python -m venv .venv
call .venv\Scripts\activate.bat

python -m pip install --upgrade pip
python -m pip install PySide6 pyinstaller

pyinstaller packaging\miniharness.spec --noconfirm

echo.
echo === 빌드 완료 ===
echo 실행 파일: dist\MiniHarness\MiniHarness.exe
pause
