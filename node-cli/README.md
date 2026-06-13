# CDSA Harness (Node.js CLI) ⌨️

> Claude Code / Codex CLI / OpenCode 와 **똑같은 방식(npm/npx)** 으로 설치하는,
> 좁은 의미의 AI 에이전트 하네스 교육용 터미널 앱.

시작하면 ASCII 배너가 뜨고, **Agent Loop** 의 모든 단계가 색으로 흐릅니다.

```
입력 → 컨텍스트 구성 → LLM 호출 → 도구 판단 → 승인 → 실행 → 결과 반영 → 반복
```

- **의존성 0개** — Node 18+ 내장 기능만 사용(`fetch`/`readline`/`node:test`). `npx` 가 빠르고 설치 실패가 없습니다.
- 같은 저장소의 Python 버전(Mini Harness GUI / CDSA Harness TUI)과 **동일한 하네스 구조**를 그대로 옮긴 것입니다.

---

## 설치 / 실행

### npx (설치 없이 즉시)

```bash
# 로컬 체크아웃에서
cd node-cli
npx .                       # API Key 없으면 자동 mock 모드
```

### 전역 설치

```bash
cd node-cli
npm install -g .            # 또는: npm link
cdsa-harness                # 어디서나 실행 (별칭: cdsa)
```

### 그냥 node 로

```bash
cd node-cli
node bin/cdsa-harness.js
```

> npm 레지스트리에 publish 하면 `npm install -g cdsa-harness` / `npx cdsa-harness` 로 바로 설치됩니다.

---

## 옵션 / 명령

```bash
cdsa-harness --provider openai --model gpt-4.1-mini   # 실제 LLM
cdsa-harness --provider openrouter --model anthropic/claude-3.5-sonnet
cdsa-harness --workspace ./my-project                 # 작업 폴더 지정
cdsa-harness --auto                                   # 승인 자동
```

터미널 슬래시 명령: `/help` · `/reset` · `/config` · `/sessions` · `/quit` (Ctrl+D 로도 종료)

---

## 설정 (config.json)

`~/.cdsa_harness/config.json` 에 저장됩니다(실행 폴더에 `config.json` 이 있으면 우선).

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

작업 폴더 상대경로는 **현재 폴더(cwd)** 기준으로 해석합니다(CLI 답게).

---

## 도구 & 안전장치

| 도구 | 설명 | 승인 |
|------|------|:----:|
| `list_dir` | 폴더 나열 | 자동 |
| `read_file` | 파일 읽기 | 자동 |
| `write_file` | 파일 생성/수정 | **diff 승인** |
| `run_shell` | 셸 실행 | **승인**(기본 차단) |

모든 도구는 작업 폴더 밖으로 나갈 수 없습니다(경로 sandbox).

---

## 구조

```
node-cli/
├── bin/cdsa-harness.js   # npm/npx 진입점 (#!/usr/bin/env node)
├── src/
│   ├── config.js         # 설정 로드/저장
│   ├── llm.js            # OpenAI/OpenRouter(fetch) + mock
│   ├── tools.js          # 도구 + sandbox + diff + 스키마
│   ├── loop.js           # ⭐ Agent Loop
│   ├── session.js        # 세션 로그(JSONL)
│   ├── banner.js         # CDSA HARNESS ASCII 배너
│   ├── ui.js             # ANSI 색/박스/diff 렌더
│   └── cli.js            # 터미널 REPL
├── workspace/            # 샘플 작업 폴더
└── test/core.test.js     # node --test
```

## 테스트

```bash
cd node-cli
npm test        # node --test
```
