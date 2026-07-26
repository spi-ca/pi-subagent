# 문서 인덱스

`docs/` 아래 문서를 목적별로 정리합니다. 프로젝트 개요와 빠른 시작은 저장소 루트의
[`README.md`](../README.md)를, 이 저장소 자체를 편집하는 에이전트를 위한 규칙은
[`AGENTS.md`](../AGENTS.md)를 참고하세요.

## 가이드

패키지 사용자를 대상으로 한 존댓말 문서입니다. 아래 순서로 읽으면 설치부터 사용까지
이어집니다.

1. [`configuration.md`](./configuration.md) — 설치, 런타임 플래그, `pi-subagent.json` 설정, 위임 보호 장치, 신뢰 모델
2. [`usage.md`](./usage.md) — `subagent` 도구 호출 형태(단일/병렬/체인/백그라운드)와 예시
3. [`agents.md`](./agents.md) — 하위 에이전트 정의 파일(frontmatter, 통신 모델) 작성법
4. [`development.md`](./development.md) — 개발 환경, 검증 명령, 프로젝트 구조, 설계 문서 전체 목록([§ 개발 설계 문서](./development.md#개발-설계-문서))

## 설계·연동 문서

평서체로 작성한 설계/구현 기록입니다. 각 문서 상단의 `> **상태:**` 배너가 현재
구현·검증 상태를 표시하며, 아래 한 줄 요약보다 그 배너가 우선합니다. 구현 상태의
세부 근거는 [`development.md`의 개발 설계 문서 목록](./development.md#개발-설계-문서)을
참고하세요.

- [`cmux-pi-tui-design.md`](./cmux-pi-tui-design.md) — cmux/tmux 기반 실제 Pi TUI 전환 설계
- [`interactive-pane-layout-design.md`](./interactive-pane-layout-design.md) — 다중 subagent interactive pane layout(`auto`/`split`) 설계
- [`interactive-runtime-performance-design.md`](./interactive-runtime-performance-design.md) — interactive subagent runtime transport 성능 개선 설계
- [`foreground-steer-background-transition-design.md`](./foreground-steer-background-transition-design.md) — 사용자 steer 시 foreground 실행을 background로 전환하는 후속 설계(제안 — 미구현)
- [`pi-subagent-hot-path-performance-design.md`](./pi-subagent-hot-path-performance-design.md) — 내부 hot-path 성능 개선 설계(위 transport 문서의 companion)
- [`pi-081-usage-accounting-design.md`](./pi-081-usage-accounting-design.md) — Pi 0.81 subagent 사용량 회계 설계
- [`pi-cmux-integration.md`](./pi-cmux-integration.md) — 선택적 `pi-cmux` UX 연동 가이드
- [`pi-cmux-presence-integration.md`](./pi-cmux-presence-integration.md) — 선택적 `pi-cmux-presence` presence 연동
- [`tmux-window-naming-design.md`](./tmux-window-naming-design.md) — tmux window 이름/pane title 정책 제안(제안 — 미구현)

## 참고 자료

- [`diagram/`](./diagram/) — Mermaid 원본(`.mmd`)과 렌더링된 SVG/PNG. 렌더링 방법은 [`development.md`의 다이어그램 렌더링](./development.md#다이어그램-렌더링)을 참고하세요.
- [`guidelines/`](./guidelines/) — 에이전트가 읽는 영어 문서 작성 지침(`a-complete-guide-to-agents-md.md`, `karpathy-guidelines.md`)
