"""Mini Harness — 좁은 의미의 AI 에이전트 하네스를 눈으로 이해하는 교육용 데스크톱 앱.

이 패키지는 두 층으로 나뉜다.

* core 계층 (config / llm / agent): Qt에 의존하지 않는 순수 파이썬. 단위 테스트 가능.
* ui 계층 (ui): PySide6 기반 화면. core 를 호출만 한다.

"하네스(harness)"는 LLM 자체가 아니라, LLM 주변의 환경을 관리하는 실행기다.
즉 규칙 읽기 / 작업 폴더 읽기 / 도구 실행 / 사용자 승인 / 로그 기록 / 반복(Agent Loop)을 담당한다.
"""

APP_NAME = "Mini Harness"
APP_VERSION = "0.1.0"
