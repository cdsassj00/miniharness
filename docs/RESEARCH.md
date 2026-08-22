# 하네스 리서치 & 패리티 보고서 (2026-07 밤샘 작업)

> 조사 대상: **OpenCode**(opencode.ai 공식 문서 전수), **OpenHands**(구 OpenDevin, arXiv 논문·SDK 문서), **OpenClaw** 생태계.
> 결론: **OpenCode 핵심 기능 패리티 달성**, OpenHands 원리 2종 이식, 차별점 5종 확보.

## 1. OpenCode 패리티 매트릭스 (v0.22.0 기준)

### 도구 (OpenCode 13종 대응)
| OpenCode | CDSA Harness | 상태 |
|---|---|---|
| bash | `run_shell` (+`!cmd` 사용자 패스스루) | ✅ |
| edit | `edit_file` (old→new 유일일치) | ✅ |
| write | `write_file` | ✅ |
| read | `read_file` | ✅ |
| grep | `grep` (정규식 + 파일 글롭 필터) | ✅ |
| glob | `glob` (`**/*.js`, 최신 수정순) | ✅ |
| apply_patch | `multi_edit` (원자적 복수 수정) | ✅ 동등 |
| todowrite/todoread | `todo_write`/`todo_read` | ✅ |
| webfetch | `webfetch` (HTML→텍스트, 승인) | ✅ |
| question | `question` (선택지 = 방향키 메뉴) | ✅ |
| skill | 스킬 시스템(24종 내장+크로스포맷) | ✅ |
| task(하위 에이전트) | `spawn_agent` | ✅ |
| websearch (Exa 의존) | `websearch` — Exa 유료 API 대신 DuckDuckGo→Bing 무료 폴백으로 구현(PR #6) | ✅ |
| lsp (실험) | `lsp_diagnostics` — js/mjs/json/py/yaml 구문 검사(의존성 0, PR #6) | ✅ |

### 명령·기능
| OpenCode | CDSA | 상태 |
|---|---|---|
| /init (AGENTS.md 생성) | /init (모델이 AGENT.md 생성) | ✅ |
| /undo /redo | 다단계 스냅샷 스택(50) | ✅ |
| Plan/Build 모드 | `/agent` → plan(읽기전용)/build | ✅ |
| 커스텀 에이전트 | `.cdsa/agents/*.md` | ✅ |
| permissions (allow/ask/deny) | `config.permissions` 도구별 | ✅ |
| 세션 목록/전환 | `/sessions` 방향키 복원 | ✅ |
| @ 파일 퍼지검색 | `@파일` 멘션 + Tab 완성 | ✅ |
| /connect | `/setup` (방향키, Ollama 포함) | ✅ |
| 자동 컨텍스트 관리 | `auto_compact_tokens` 자동압축 | ✅ |
| MCP / rules(AGENTS.md) / 커스텀 명령 / 테마(색) | 기존 구현 | ✅ |
| /share (대화 공유 링크) | 서버 필요 — 보류 | ⬜ |
| 이미지 드롭 / 데스크톱·웹 UI / SDK | 범위 외 | ⬜ |

**패리티 판정: CLI 하네스 코어 기준 100%** (남은 보류 2건은 서버 인프라·터미널 한계로 범위 밖 — §5 참고).

## 2. OpenHands 에서 가져온 원리
- **이벤트 스트림**: 모든 단계가 이벤트로 흐르고 JSONL 로 기록(우린 교육 모드로 '보이게'까지 함).
- **CodeAct**: 행동=코드실행 — `run_shell`/`!cmd` 대응.
- **마이크로에이전트** → **트리거 스킬**로 이식: frontmatter `triggers: 민원, .hwpx` → 입력에 단어가 보이면 해당 스킬 지식을 자동 첨부(🧩 표시). *OpenCode에는 없는 기능.*
- **멀티에이전트 위임** → `spawn_agent`.

## 3. OpenClaw / omc·oma 류
- OpenClaw = 채널(카톡류) 개인 비서. 주변 생태계가 흥미로움:
  - *openclaw-harness*(보안): 모든 도구 호출 검사·차단·감사 → **우리의 permissions + 승인 diff + 세션 JSONL 감사로그**가 같은 역할.
  - *awesome-openclaw-agents*(SOUL.md 템플릿 162종) → **우리의 `.cdsa/agents/*.md` + 스킬 팩(npm 플러그인)** 으로 동일 패턴 수용 가능.

### 3.1 "omc"/"oma" 실제 조사 결과 (npm 레지스트리 전수 확인)
- **`omc`**: 무관한 옛 로거 패키지(oh-my-console). 별도로 `@y-square-t3/oh-my-codes`(OS별 바이너리, CI 배지에 opencode 언급)가 있으나 npm 미공개 패키지로 설치 불가 확인.
- **`oma`**: 무관한 Open Mainframe Architecture 레퍼런스 구현. 근접한 후보로 `@getoma/cli`("oma managed agents platform" CLI)가 있으나 **CDSA Harness 플러그인 포맷이 아님**(자체 독립 CLI, `.cdsa/plugins` 규격과 무관).
- **결론**: "omc/oma" 라는 이름의 **CDSA Harness 호환 플러그인은 존재하지 않는다.** README 예시(`cdsa-harness-plugin-git`)도 실제로는 npm에 게시된 적 없는 예시일 뿐(확인 완료 — 404).

### 3.2 그래서 플러그인 설치 파이프라인 자체를 end-to-end 로 검증함
이름 매칭 대신, **"설치가 실제로 되는가"** 라는 사용자의 진짜 관심사를 최소 플러그인으로 직접 실증:
1. `cdsa-harness-plugin-omatest` (도구 1개, `oma_ping`) 를 로컬에서 `npm pack`
2. 별도 워크스페이스에 `npm install ./*.tgz` — 실제 사용자가 겪을 설치 과정 그대로
3. `discoverNpmExtensions()` 가 `node_modules` 를 스캔해 자동 발견 (`/plugins` 에도 노출 확인)
4. **AgentLoop 로 실제 모델 호출→도구 실행까지 구동** — `PONG: hello-from-plugin` 응답 확인
→ **설치(npm install) → 자동 발견 → 모델의 도구 호출 → 실행** 전 구간이 실제로 동작함을 확인(2026-08-22).
이 파이프라인만 있으면 앞으로 omc/oma 같은 이름의 실제 플러그인이 나왔을 때 `npm install` 한 번으로 바로 붙는다.

## 4. 우리만의 차별점 (OpenCode에 없는 것)
1. **🎓 교육 모드** — 컨텍스트·토큰·판단·되먹임 전 과정 시각화 (정체성)
2. **🇰🇷 공공 특화** — 민원/공문/HWPX 파서/개인정보점검 등 13종 내장
3. **🧩 트리거 스킬** — OpenHands 마이크로에이전트의 경량 구현
4. **🏢 폐쇄망 1급 시민** — Ollama 방향키 셋업, 오프라인 tgz, 단일 exe, 업데이트체크 무음 실패
5. **의존성 0 + 완전 자동 배포** — 버전 푸시만으로 npm+exe 3종

## 5. 남은 보류 항목(사유)
- /share: 공유 서버 인프라 필요 → 공공 특성상 오히려 비활성이 장점일 수 있음
- 이미지 입력: 터미널 한계. exe/TUI 확장 시 재검토.
- (websearch·LSP 는 PR #6 에서 구현 완료 — 위 §1 표 참고)

### 출처
- https://opencode.ai/docs/ · https://opencode.ai/docs/tools/
- OpenHands: arXiv 2407.16741, 2511.03690 (SDK)
- github.com/openclaw/openclaw 및 harness 생태계 저장소들
