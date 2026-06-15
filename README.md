# CDSA Harness 🎓  ·  made by CDSA

> **AI 에이전트가 내부에서 무슨 일을 하는지** 단계별로 드러내는 교육용 터미널 하네스.
> Claude Code·Codex 는 과정을 숨기지만, CDSA Harness 는 **컨텍스트 구성 → LLM 호출 → 모델 판단(토큰·지연) → 도구 실행 → 결과 되먹임**을 전부 펼쳐 보여줍니다.

대한민국 공공 업무용 스킬(민원분류·공문·개인정보점검·HWPX 등)도 기본 내장. 의존성 0개.

---

## 설치 — 둘 중 하나

### 1) Node.js + npm (개발자·일반)
Node 18+ 가 있으면:
```bash
npx cdsa-harness            # 설치 없이 즉시 실행
npm install -g cdsa-harness # 전역 설치 → 어디서나 'cdsa-harness'
```

### 2) 단일 실행파일 (Node 불필요 · 폐쇄망)
**Node 설치 없이** 파일 하나만 받아 실행 — 공공/폐쇄망에 적합.
1. [Releases](https://github.com/cdsassj00/miniharness/releases) 에서 OS 파일 다운로드
   (`cdsa-harness-win.exe` / `cdsa-harness-macos` / `cdsa-harness-linux`)
2. 실행 → 끝

---

## 활용법

**1. AI 연결** — 실행 후 `/setup` 입력 (OpenAI · Claude · OpenRouter 중 선택, 키 입력).
키가 없으면 자동 `mock` 모드로 전체 흐름을 연습할 수 있습니다.

**2. 그냥 시키기** — 한국어로 입력:
```
notes.txt 맨 아래에 오늘 할 일 3개 추가해줘
```
→ 모델이 도구(폴더 보기·읽기·쓰기)를 호출하고, 파일 수정은 **diff 를 보여준 뒤 [y/N] 승인**.

**3. 슬래시 명령**
- 기본: `/help` `/about` `/setup` `/model` `/teach`(과정 펼치기) `/stream`(실시간 출력) `/skills` `/plugins` `/mcp` `/reset` `/quit`
- 🇰🇷 공공 스킬: `/minwon` 민원분류 · `/gongmun` 공문 · `/privacy` 개인정보점검 · `/press` 보도자료 · `/report` 개조식보고 · `/minutes` 회의록 · `/hwpx` 한컴문서 요약
- 교육/실용: `/explain` `/review` `/summarize` `/tour` `/plan` `/eli5` `/quiz` `/loop` …

---

## 특징

- **교육 모드** — 매 단계(보낼 컨텍스트·토큰·모델 판단·도구·되먹임)를 패널로 표시
- **실시간 스트리밍** — 응답이 토큰 단위로 흐름
- **실제 LLM** — OpenAI · Anthropic(Claude) · OpenRouter, 사내/폐쇄망 LLM(`base_url`)
- **확장** — npm 플러그인(`cdsa-harness add …`), 마크다운 스킬, **MCP**(Claude Code·Cursor 와 공용)
- **안전장치** — 모든 도구는 작업 폴더 밖으로 못 나가고(sandbox), 파일 수정·셸은 **승인** 필요
- **의존성 0개** (Node 18+ 내장만 사용)

> 더 자세한 설정·플러그인·스킬·폐쇄망 가이드 → **[`node-cli/README.md`](node-cli/README.md)**

---

## (참고) 교육용 원본 — Python 버전

같은 하네스 구조를 처음 만든 Python 버전도 포함되어 있습니다.
```bash
pip install -r requirements.txt
python tui.py      # 터미널(TUI) 버전
python run.py      # 데스크톱 GUI 버전 (PySide6)
```

---

## 라이선스 / 목적

MIT. 교육용 데모입니다 — 목표는 **"AI 에이전트(하네스) 원리를 눈으로 이해시키는 것"**.
