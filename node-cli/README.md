# CDSA Harness (Node.js CLI) 🎓⌨️

> **AI 에이전트가 내부에서 실제로 뭘 하는지** 단계별로 드러내는 교육용 터미널 하네스.
> Claude Code·Codex 는 과정을 숨기지만, CDSA Harness 는 **컨텍스트 구성 → API 요청 → 모델의 판단 → 토큰/응답시간 → 도구 실행 → 결과 되먹임**을 전부 펼쳐 보여줍니다.

```
① 입력 → ② LLM 호출(보낼 컨텍스트·도구) → ③ 모델 응답(토큰·지연·tool_call)
      → ④ 도구 판단 → ⑤ 실행/승인 → ⑥ 결과 되먹임 → (반복)
```

- **의존성 0개** — Node 18+ 내장 기능만(`fetch`/`readline`/`node:test`)
- **실시간 스트리밍** — 모델 응답이 토큰 단위로 흐름(`/stream` 토글, OpenAI·Claude·mock)
- **실제 LLM 연결** — OpenAI · Anthropic(Claude) · OpenRouter, 또는 키 없이 `mock`
- **교육 모드** — 매 반복마다 모델에 보내는 메시지 구성·추정 토큰·시스템 프롬프트, 실제 토큰 사용량/응답시간까지 그대로 표시
- **MCP 클라이언트** — Claude Code·Cursor 등과 **공용 표준**. MCP 서버를 그대로 붙여 도구로 사용
- **플러그인** — npm 으로 설치하거나 `.cdsa/plugins/` 에 JS 파일 → **도구 자동 등록**
- **크로스포맷 스킬** — `.cdsa/skills/` 뿐 아니라 `.claude/commands/`·`.opencode/command/` 의 스킬도 인식

---

## 설치 / 실행 — 둘 중 하나 선택

### 방법 1) Node.js + npm (개발자·일반)
Node 18+ 가 있으면:
```bash
npx cdsa-harness                 # 설치 없이 즉시 (키 없으면 mock)
npm install -g cdsa-harness      # 전역 설치 → 'cdsa-harness' / 'cdsa'
```

### 방법 2) 단일 실행파일 다운로드 (Node 불필요 · 폐쇄망)
**Node 설치 없이** 파일 하나만 받아 실행합니다. 공공/폐쇄망에 적합.
1. [Releases](https://github.com/cdsassj00/miniharness/releases) 에서 OS 에 맞는 파일 다운로드
   - Windows: `cdsa-harness-win.exe`
   - macOS: `cdsa-harness-macos`
   - Linux: `cdsa-harness-linux`
2. 실행:
   ```bash
   # Windows (PowerShell)
   .\cdsa-harness-win.exe
   # macOS / Linux (실행권한 부여 후)
   chmod +x ./cdsa-harness-linux && ./cdsa-harness-linux
   ```
> 이 바이너리는 Node 런타임을 포함(약 100MB+)하므로 Node 설치가 필요 없습니다.
> 내장 스킬·플러그인(HWPX 포함)도 모두 들어있어 단독 실행됩니다.

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
| `/guide` · `/tutorial` | 빠른 시작 안내 · 단계별 인터랙티브 튜토리얼 |
| `/workspace <폴더>` | 작업 폴더 보기/변경 (`.` = 현재 폴더) |
| `/color` | 색상 켜기/끄기(흑백) |
| `/setup` | 제공자·API 키·모델 대화형 연결 |
| `/provider <이름>` | openai · anthropic · openrouter · mock 전환 |
| `/model <이름>` | 모델 변경 |
| `/teach` | 교육 모드 켜기/끄기 |
| `/stream` | 실시간 스트리밍 출력 켜기/끄기 |
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

## 🔌 플러그인 (추가 도구)

### 방법 A — npm 으로 설치 (권장)

`cdsa-harness-plugin-*` 이름의 패키지를 설치하면 **자동으로 발견·로드**됩니다.

```bash
cdsa-harness add cdsa-harness-plugin-git   # = npm install 후 자동 로드
# 또는 직접:  npm install cdsa-harness-plugin-git
cdsa-harness                               # 실행 → /plugins 에 자동 등록됨
```

- cwd 의 `node_modules` 와 전역 설치 위치를 모두 탐색합니다.
- 이름 규칙과 무관하게 강제 로드하려면 `config.json` 의 `"plugins": ["패키지명"]` 에 추가.
- 플러그인 패키지는 default export 로 `플러그인 def` · `def 배열` · `{ tools:[...], skills:[...] }` 중 하나를 제공.

> **npm vs npx**: `npm install`(=설치, 보관) 으로 플러그인을 **추가**하고, `npx`(=설치 없이 실행) 또는 설치된 `cdsa-harness` 로 **실행**합니다.

### 방법 B — 로컬 파일 (실험용)

`.cdsa/plugins/` (작업 폴더) 또는 `~/.cdsa_harness/plugins/` 에 `.js`/`.mjs` 파일을 두면 자동 등록.

```js
// .cdsa/plugins/word_count.mjs
import fs from "node:fs";
import path from "node:path";
export default {
  name: "word_count",
  description: "텍스트 파일의 글자/줄/단어 수를 센다",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  mutating: false,                 // true 면 실행 전 승인
  async handler(args, ctx) {       // ctx.workspace = 작업 폴더 절대경로
    const text = fs.readFileSync(path.resolve(ctx.workspace, args.path), "utf8");
    return `글자 ${text.length}, 줄 ${text.split("\n").length}`;
  },
};
```

## 🔗 MCP — 다른 에이전트와 플러그인 공유

[MCP](https://modelcontextprotocol.io) 서버는 Claude Code·Cursor·Zed 등이 함께 쓰는 **공용 도구 표준**입니다.
`config.json` 에 **그 도구들과 동일한 형식**으로 적으면, 다른 에이전트용으로 만든 MCP 서버를 cdsa-harness 에서 그대로 씁니다.

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },
    "github":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

연결되면 각 도구가 `mcp__서버__도구` 이름으로 모델에 노출됩니다. `/mcp` 로 확인.
(부수효과가 있을 수 있는 도구는 실행 전 승인을 받습니다 — `readOnlyHint` 가 있으면 자동.)

## 🎯 스킬 (프롬프트 템플릿)

`.cdsa/skills/` 에 마크다운을 두면 `/파일명` 으로 실행됩니다. 본문의 `$ARGUMENTS`(또는 `{{args}}`)가 치환됩니다.

- **기본 내장 스킬**(설치하면 누구에게나 제공):
  - 실용: `/explain` 쉽게 설명 · `/review` 코드 리뷰 · `/summarize` 3줄 요약 · `/tour` 프로젝트 브리핑 · `/todo` 미완성(TODO) 수집 · `/plan` 실행 전 계획만
  - 교육/재미: `/eli5` 5살도 알게 · `/rubberduck` 질문으로 디버깅 · `/quiz` 학습 퀴즈 · `/haiku` 하이쿠 · `/loop` 이 요청을 에이전트 루프로 어떻게 처리할지 해설
  - **🇰🇷 공공(대한민국)**: `/minwon` 민원분류 · `/gongmun` 공문 기안 · `/privacy` 개인정보 점검 · `/press` 보도자료 · `/report` 개조식 보고 · `/minutes` 회의록 · `/insa` 인사발령 · `/budget` 예산 검토 · `/notice` 공고문 · `/answer` 민원답변 · `/briefing` 보도협조 · `/policyqa` 정책 Q&A · `/hwpx` 한컴 문서 요약

## 🇰🇷 공공 특화 + HWPX

- **공공 스킬** — 위 `/minwon` `/gongmun` `/privacy` 등으로 민원·공문·개인정보·보도자료 등 행정 업무를 바로 시도.
- **HWPX 내장 도구(`hwpx_read`)** — 한컴 `.hwpx` 문서(zip+xml)에서 본문 텍스트를 **의존성 없이** 추출. `/hwpx 파일.hwpx` 로 읽어 요약.
  - 구버전 `.hwp`(바이너리)는 한컴오피스에서 `.hwpx` 로 저장 후 사용.
- **다른 에이전트의 스킬도 인식** — `.claude/commands/`, `.claude/skills/<이름>/SKILL.md`, `.opencode/command/` 등을 함께 읽습니다.
- **남과 공유**하려면: 로컬 스킬 파일은 본인만 쓰지만, 플러그인 패키지(`{ skills: [...] }`)로 npm 배포하면 `cdsa-harness add` 한 모두가 사용. `/skills` 로 목록 확인.

```markdown
---
description: 파일을 읽고 3줄로 요약
---
$ARGUMENTS 파일을 read_file 로 읽고 핵심을 한국어 3줄로 요약해줘.
```
실행: `/summarize notes.txt`

## 🏢 폐쇄망 / 오프라인 설치

의존성이 **0개**라 폐쇄망 배포가 쉽습니다(추가 다운로드 없음).

**Node 가 이미 있는 경우 — tgz 반입 후 오프라인 설치:**
```bash
# (외부망) 패키지 묶기
npm pack cdsa-harness          # → cdsa-harness-x.y.z.tgz 생성
# (폐쇄망으로 파일 반입 후)
npm install -g ./cdsa-harness-x.y.z.tgz   # 인터넷 불필요
```

**사내/폐쇄망 LLM (OpenAI 호환 서버 — vLLM, 내부 게이트웨이 등):**
`config.json` 의 `base_url` 에 **전체 엔드포인트**를 적으면 그쪽으로 호출합니다.
```json
{
  "provider": "openai",
  "base_url": "https://llm.내부망.local/v1/chat/completions",
  "api_key": "사내토큰",
  "model": "사내모델명"
}
```

> Node 자체를 못 까는 환경은 **단일 실행파일(.exe)** 빌드가 답입니다(로드맵).

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
│   ├── mcp.js            # MCP 클라이언트(stdio JSON-RPC) — 다른 에이전트와 공용
│   ├── plugins.js        # 파일·npm 플러그인 발견/로드
│   ├── skills.js         # 크로스포맷 스킬 로더
│   ├── session.js        # 세션 로그(JSONL)
│   ├── banner.js / ui.js # 배너 · ANSI/박스/diff 렌더
│   └── cli.js            # REPL + 교육 모드 렌더 + /setup
└── test/core.test.js     # node --test
```

## 테스트

```bash
npm test        # node --test
```
