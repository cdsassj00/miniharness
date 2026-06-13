# CDSA Harness (Node.js CLI) 🎓⌨️

> **AI 에이전트가 내부에서 실제로 뭘 하는지** 단계별로 드러내는 교육용 터미널 하네스.
> Claude Code·Codex 는 과정을 숨기지만, CDSA Harness 는 **컨텍스트 구성 → API 요청 → 모델의 판단 → 토큰/응답시간 → 도구 실행 → 결과 되먹임**을 전부 펼쳐 보여줍니다.

```
① 입력 → ② LLM 호출(보낼 컨텍스트·도구) → ③ 모델 응답(토큰·지연·tool_call)
      → ④ 도구 판단 → ⑤ 실행/승인 → ⑥ 결과 되먹임 → (반복)
```

- **의존성 0개** — Node 18+ 내장 기능만(`fetch`/`readline`/`node:test`)
- **실제 LLM 연결** — OpenAI · Anthropic(Claude) · OpenRouter, 또는 키 없이 `mock`
- **교육 모드** — 매 반복마다 모델에 보내는 메시지 구성·추정 토큰·시스템 프롬프트, 실제 토큰 사용량/응답시간까지 그대로 표시

---

## 설치 / 실행

```bash
npx cdsa-harness                 # 설치 없이 즉시 (키 없으면 mock)
npm install -g cdsa-harness      # 전역 설치 → 'cdsa-harness' / 'cdsa'
```

## 실제 AI 연결하기

가장 쉬운 길 — 실행 후 `/setup` 입력(대화형으로 제공자·키·모델 선택):
```bash
cdsa-harness
› /setup
```

또는 플래그/환경변수로:
```bash
cdsa-harness --provider openai --model gpt-4o-mini
cdsa-harness --provider anthropic --model claude-3-5-haiku-latest

# 키는 환경변수로도 자동 인식(파일에 저장 안 함)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
```

---

## 슬래시 명령

| 명령 | 설명 |
|------|------|
| `/setup` | 제공자·API 키·모델 대화형 연결 |
| `/provider <이름>` | openai · anthropic · openrouter · mock 전환 |
| `/model <이름>` | 모델 변경 |
| `/teach` | 교육 모드 켜기/끄기 |
| `/context` | 지금 모델에 보내는 컨텍스트 들여다보기 |
| `/reset` | 대화/컨텍스트 초기화 |
| `/config` | 현재 설정값 |
| `/quit` | 종료 (Ctrl+D) |

## 플래그

```
--provider <openai|anthropic|openrouter|mock>
--model <모델명>
--workspace <폴더경로>
--setup        대화형 연결 설정
--no-teach     교육 모드 끄고 간결 출력
--auto         승인 자동
```

---

## 설정 (config.json)

`~/.cdsa_harness/config.json` (실행 폴더에 `config.json` 있으면 우선).

```json
{
  "provider": "openai",
  "api_key": "",
  "model": "gpt-4o-mini",
  "workspace": "./workspace",
  "approval_mode": "manual",
  "allow_shell": false,
  "max_steps": 8,
  "temperature": 0.2,
  "max_tokens": 1024,
  "teach_mode": true
}
```

> `api_key` 가 비어 있으면 해당 provider 의 환경변수를 자동으로 찾습니다.

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
├── bin/cdsa-harness.js   # npm/npx 진입점
├── src/
│   ├── config.js         # 설정 + 환경변수 키 감지
│   ├── llm.js            # OpenAI/Anthropic/OpenRouter + mock, 응답 정규화(토큰·지연)
│   ├── tools.js          # 도구 + sandbox + diff
│   ├── loop.js           # ⭐ Agent Loop + 교육용 이벤트(컨텍스트/되먹임)
│   ├── session.js        # 세션 로그(JSONL)
│   ├── banner.js / ui.js # 배너 · ANSI/박스/diff 렌더
│   └── cli.js            # REPL + 교육 모드 렌더 + /setup
└── test/core.test.js     # node --test
```

## 테스트

```bash
npm test        # node --test
```
