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
| websearch (Exa 의존) | — 외부 유료 API 의존이라 보류 | ⬜ |
| lsp (실험) | — 보류(무거움, 실험 단계) | ⬜ |

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

**패리티 판정: CLI 하네스 코어 기준 사실상 100%** (보류 4건은 외부 서버·유료 API·실험 기능).

## 2. OpenHands 에서 가져온 원리
- **이벤트 스트림**: 모든 단계가 이벤트로 흐르고 JSONL 로 기록(우린 교육 모드로 '보이게'까지 함).
- **CodeAct**: 행동=코드실행 — `run_shell`/`!cmd` 대응.
- **마이크로에이전트** → **트리거 스킬**로 이식: frontmatter `triggers: 민원, .hwpx` → 입력에 단어가 보이면 해당 스킬 지식을 자동 첨부(🧩 표시). *OpenCode에는 없는 기능.*
- **멀티에이전트 위임** → `spawn_agent`.

## 3. OpenClaw / omc·oma 류
- OpenClaw = 채널(카톡류) 개인 비서. 주변 생태계가 흥미로움:
  - *openclaw-harness*(보안): 모든 도구 호출 검사·차단·감사 → **우리의 permissions + 승인 diff + 세션 JSONL 감사로그**가 같은 역할.
  - *awesome-openclaw-agents*(SOUL.md 템플릿 162종) → **우리의 `.cdsa/agents/*.md` + 스킬 팩(npm 플러그인)** 으로 동일 패턴 수용 가능. omc/oma 같은 팩도 마크다운/MCP라 그대로 이식됨.

## 4. 우리만의 차별점 (OpenCode에 없는 것)
1. **🎓 교육 모드** — 컨텍스트·토큰·판단·되먹임 전 과정 시각화 (정체성)
2. **🇰🇷 공공 특화** — 민원/공문/HWPX 파서/개인정보점검 등 13종 내장
3. **🧩 트리거 스킬** — OpenHands 마이크로에이전트의 경량 구현
4. **🏢 폐쇄망 1급 시민** — Ollama 방향키 셋업, 오프라인 tgz, 단일 exe, 업데이트체크 무음 실패
5. **의존성 0 + 완전 자동 배포** — 버전 푸시만으로 npm+exe 3종

## 5. 남은 보류 항목(사유)
- /share: 공유 서버 인프라 필요 → 공공 특성상 오히려 비활성이 장점일 수 있음
- websearch: Exa 등 유료 API 키 의존 → webfetch 로 URL 직접 읽기는 가능
- LSP: OpenCode 도 experimental. 수요 확인 후.
- 이미지 입력: 터미널 한계. exe/TUI 확장 시 재검토.

### 출처
- https://opencode.ai/docs/ · https://opencode.ai/docs/tools/
- OpenHands: arXiv 2407.16741, 2511.03690 (SDK)
- github.com/openclaw/openclaw 및 harness 생태계 저장소들
