# Mini Harness 🪢

> **좁은 의미의 "하네스(harness)"를 눈으로 이해하고 직접 체험하는 교육용 데스크톱 앱**

Mini Harness 는 프롬프트 서식기나 매뉴얼 생성기가 아닙니다.
**OpenCode / Claude Code / Codex CLI 와 같은 구조의 아주 작은 AI 에이전트 실행기**입니다.

비개발자도 "AI 코딩 에이전트가 내부에서 무슨 일을 하는가"를 한 화면에서 볼 수 있도록 만들었습니다.

> **세 가지 얼굴, 하나의 코어** — 같은 하네스 구조(`agent/`·`llm/`·`config`)를 공유합니다.
> - 🖥️ **Mini Harness (GUI)** — PySide6 데스크톱 앱 (`python run.py`)
> - ⌨️ **CDSA Harness (Python TUI)** — 터미널 앱 (`python tui.py`)
> - 📦 **CDSA Harness (Node.js CLI)** — Claude Code/Codex처럼 npm/npx 설치 → [`node-cli/`](node-cli/) (`npx cdsa-harness`)

```
사용자 입력
  → 규칙 파일 읽기 (AGENT.md)
  → 현재 작업 폴더 읽기
  → LLM 호출
  → 도구 요청 판단
  → 파일 읽기 / 파일 수정 제안
  → 사용자 승인
  → 파일 저장
  → 세션 로그 기록
  → 다시 LLM 호출  (완료될 때까지 반복 = Agent Loop)
```

---

## 핵심 개념: LLM ≠ 하네스

| 구분 | 역할 |
|------|------|
| **LLM** | "생각"만 한다. 다음에 무엇을 할지 텍스트/도구요청으로 내놓는다. |
| **하네스** | LLM 주변의 **환경을 관리**한다. 규칙 읽기, 파일 읽기·수정, 도구 실행, **사용자 승인**, 로그 기록, 그리고 이 모든 것을 **반복(Agent Loop)** 한다. |

Claude Code · Codex · OpenCode 의 핵심은 결국 이 **Agent Loop** 한 가지입니다.
Mini Harness 는 그 루프의 모든 단계를 화면 우측 다이어그램에 **점등**시켜 보여줍니다.

---

## 스크린샷 구성

- **왼쪽** — 작업 폴더(workspace) 트리. 하네스가 다루는 sandbox.
- **가운데** — 대화창 + 입력. 사용자/모델/도구 활동이 흐른다.
- **오른쪽** — `Agent Loop` 단계 다이어그램 + `세션 로그`(단계별 상세 추적).
- **승인 다이얼로그** — 파일 수정 시 변경 내용(diff)을 보여주고 승인/거부를 받는다.

---

## 빠른 시작

### 📦 CDSA Harness (Node.js CLI) — Claude Code/Codex처럼 설치

```bash
cd node-cli
npm install -g .       # 전역 설치 → 어디서나 'cdsa-harness'
cdsa-harness           # 실행 (API Key 없으면 자동 mock)
# 또는 설치 없이:  cd node-cli && npx .
```

의존성 0개(Node 18+ 내장만 사용). 자세한 내용은 [`node-cli/README.md`](node-cli/README.md).

### ⌨️ CDSA Harness (Python 터미널/TUI)

실제 Claude Code / OpenCode / Codex 처럼 터미널에서 동작합니다. 시작 시 ASCII 배너가 뜹니다.

```bash
pip install -r requirements.txt
python tui.py                 # API Key 없으면 자동으로 mock 모드
python tui.py --provider openai --model gpt-4.1-mini   # 실제 LLM
python tui.py --auto          # 승인 자동(approval_mode=auto)
```

```
   __________  _____ ___       __  __
  / ____/ __ \/ ___//   |     / / / /___ __________  ___  __________
 / /   / / / /\__ \/ /| |    / /_/ / __ `/ ___/ __ \/ _ \/ ___/ ___/
/ /___/ /_/ /___/ / ___ |   / __  / /_/ / /  / / / /  __(__  |__  )
\____/_____//____/_/  |_|  /_/ /_/\__,_/_/  /_/ /_/\___/____/____/
```

루프의 각 단계(`🧱 컨텍스트 → 🧠 LLM 호출 → 🤔 도구 판단 → 🔐 승인 → 🔧 실행 → 📄 결과`)가
색으로 흐르고, 파일 수정은 diff 를 보여준 뒤 `[y/N]` 로 승인받습니다.

터미널 슬래시 명령: `/help` · `/reset` · `/config` · `/sessions` · `/quit`

### 🖥️ Mini Harness (데스크톱/GUI)

```bash
pip install -r requirements.txt
python run.py
```

> **API Key 없이 체험하기**: 설정에서 provider 를 `mock` 으로 두면,
> 키 없이도 "폴더 보기 → 파일 읽기 → 수정 제안 → 승인 → 저장"의 전체 루프를 시연합니다.

### 2) 실제 LLM 연결

앱 상단 **파일 → 설정** 에서:

- **Provider**: `openai` 또는 `openrouter`
- **API Key**: 발급받은 키
- **Model**: 예) `gpt-4.1-mini`, `gpt-4o-mini`, `openai/gpt-4.1-mini`, `anthropic/claude-3.5-sonnet`, `google/gemini-2.5-flash`
- **작업 폴더 / 승인 모드 / 셸 허용 / 최대 반복** 설정

설정은 로컬 `config.json` 에 저장됩니다(아래 참고).

### Windows 실행 파일(exe) 빌드

```bat
packaging\build_windows.bat
```
→ GUI: `dist\MiniHarness\MiniHarness.exe` / TUI: `dist\CDSAHarness\CDSAHarness.exe`

(Linux/macOS 는 `bash packaging/build.sh`)

개별 빌드는 직접 spec 을 지정하면 됩니다:
```bash
pyinstaller packaging/miniharness.spec    # GUI
pyinstaller packaging/cdsa_harness.spec   # TUI
```

---

## 설정 파일 (config.json)

`~/.mini_harness/config.json` 에 저장됩니다. (실행 폴더에 `config.json` 이 있으면 그쪽을 우선 사용 — 포터블)

```json
{
  "provider": "openai",
  "api_key": "",
  "model": "gpt-4.1-mini",
  "workspace": "./workspace",
  "approval_mode": "manual",
  "allow_shell": false,
  "max_steps": 8,
  "temperature": 0.2
}
```

> ⚠️ `config.json` 과 `sessions/` 는 `.gitignore` 에 등록되어 있습니다(API Key 유출 방지).

---

## 하네스가 제공하는 도구

| 도구 | 설명 | 승인 필요 |
|------|------|:--------:|
| `list_dir` | 작업 폴더 내용 나열 | 아니오 (읽기) |
| `read_file` | 텍스트 파일 읽기 | 아니오 (읽기) |
| `write_file` | 파일 생성/수정 (전체 내용) | **예** (diff 승인) |
| `run_shell` | 셸 명령 실행 | **예** (기본 비활성) |

모든 도구는 **작업 폴더 밖으로 나갈 수 없습니다**(경로 sandbox). 이것이 하네스의 안전장치입니다.
읽기 전용 도구는 자동 실행, **환경을 바꾸는 도구는 사용자 승인**을 거칩니다 — 위험도에 따른 차등 대우를 그대로 보여줍니다.

---

## 규칙 파일 (AGENT.md)

작업 폴더의 `AGENT.md`(또는 `AGENTS.md` / `CLAUDE.md` / `rules.md`)를 매 호출마다 읽어
시스템 프롬프트에 합칩니다. Claude Code 의 `CLAUDE.md`, Codex 의 `AGENTS.md` 와 같은 개념입니다.

---

## 프로젝트 구조

```
miniharness/
├── run.py                     # GUI 런처 (python run.py)
├── tui.py                     # TUI 런처 (python tui.py)
├── requirements.txt
├── miniharness/
│   ├── app.py                 # QApplication 부트스트랩 + 테마
│   ├── config.py              # config.json 로드/저장
│   ├── llm/
│   │   └── client.py          # OpenAI/OpenRouter(HTTP) + mock 에이전트
│   ├── agent/                 # ⭐ Qt 비의존 코어 (단위 테스트 가능)
│   │   ├── events.py          # 루프 단계 정의 (Step/Event)
│   │   ├── tools.py           # 도구 + 경로 sandbox + function 스키마
│   │   ├── session.py         # 세션 로그(JSONL)
│   │   └── loop.py            # ⭐ Agent Loop 본체
│   ├── ui/                    # PySide6 GUI (코어를 호출만 함)
│   │   ├── main_window.py     # 3분할 메인 화면
│   │   ├── loop_view.py       # Agent Loop 단계 다이어그램
│   │   ├── approval_dialog.py # 파일 수정 승인(diff)
│   │   ├── settings_dialog.py # API Key/모델/워크스페이스 설정
│   │   └── worker.py          # 백그라운드 스레드 + 승인 브릿지
│   └── tui/                   # rich 기반 TUI (코어를 호출만 함)
│       ├── banner.py          # CDSA Harness ASCII 배너
│       └── runner.py          # 터미널 REPL + 단계 출력 + 승인
├── workspace/                 # 샘플 작업 폴더 (AGENT.md, notes.txt)
├── packaging/                 # PyInstaller 스펙 + 빌드 스크립트
└── tests/test_core.py         # 코어 end-to-end 테스트(mock)
```

> **설계 원칙**: `agent/` · `llm/` · `config.py` 는 Qt 에 의존하지 않습니다.
> 그래서 GUI 없이도 동작/테스트가 가능하고, 나중에 CLI·웹으로 옮기기도 쉽습니다.

---

## 테스트

```bash
python -m tests.test_core    # 또는: pytest
```

`mock` provider 로 Agent Loop 전 과정(폴더 보기 → 읽기 → 수정 제안 → 승인 → 저장)과
경로 sandbox, 거부 시 파일 불변을 검증합니다.

---

## 학습용 실험 아이디어

1. `mock` 으로 한 번 돌려 단계 다이어그램이 어떻게 점등되는지 본다.
2. 승인 다이얼로그에서 **거부**를 눌러 본다 → 모델이 거부 사실을 받아 다르게 행동한다.
3. 승인 모드를 `auto` 로 바꿔 차이를 본다.
4. 실제 LLM 을 연결해 `"hello.py 만들어줘"` 같은 요청을 시켜 본다.
5. `세션 로그` 탭과 `~/.mini_harness/sessions/*.jsonl` 을 비교해 본다.

---

## 라이선스 / 목적

교육용 데모입니다. 상용 수준의 Claude Code/OpenCode 를 대체하지 않습니다.
목표는 **"하네스 원리를 눈으로 이해시키는 것"** 입니다.
