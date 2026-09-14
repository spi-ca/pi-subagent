# 문서 인덱스

프로젝트 개요와 가장 짧은 시작 경로는 저장소 루트의 [`README.md`](../README.md)를,
이 저장소를 편집하는 에이전트 규칙은 [`AGENTS.md`](../AGENTS.md)를 참고하세요.

## 처음 사용하기

다음 순서로 읽으면 설치부터 첫 위임까지 이어집니다.

1. [`README.md`](../README.md) — immutable release 설치와 첫 `spawn` 호출
2. [`agents.md`](./agents.md) — 사용자·프로젝트 에이전트 위치와 최소 frontmatter
3. [`usage.md`의 단일 모드](./usage.md#단일-모드) — 첫 `subagent({ agent, task })` 호출

## 운영과 개발

| 목적 | 문서 |
| --- | --- |
| 설치 방식, 한계, 신뢰, terminal 환경과 문제 해결 | [`configuration.md`](./configuration.md) |
| 병렬·체인·백그라운드 호출, 입력 검증, 상태·취소 | [`usage.md`](./usage.md) |
| 개발 환경, 기본 CI, opt-in acceptance와 evidence 규칙 | [`development.md`](./development.md) |

## 설계·연동 문서

설계·구현 기록은 문서 상단의 `> **상태:**` 배너를 우선합니다. 현재 구현의 최종 source of truth는 코드와 테스트이며, 검증 근거와 실행 경계는 [`development.md`의 개발 설계 문서](./development.md#개발-설계-문서)를 참고하세요.

- [`cmux-pi-tui-design.md`](./cmux-pi-tui-design.md) — cmux/tmux/Herdr 실제 Pi TUI 전환과 Herdr fail-closed 점검
- [`interactive-pane-layout-design.md`](./interactive-pane-layout-design.md) — 다중 interactive pane의 `auto`/`split` layout
- [`interactive-runtime-performance-design.md`](./interactive-runtime-performance-design.md) — interactive runtime transport 성능 설계
- [`pi-subagent-hot-path-performance-design.md`](./pi-subagent-hot-path-performance-design.md) — internal hot-path 성능 개선 설계
- [`pi-081-usage-accounting-design.md`](./pi-081-usage-accounting-design.md) — Pi 0.81 subagent 사용량 회계
- [`pi-cmux-integration.md`](./pi-cmux-integration.md) — 선택적 `pi-cmux` UX 연동
- [`pi-cmux-presence-integration.md`](./pi-cmux-presence-integration.md) — 선택적 `pi-cmux-presence` presence 연동
- [`pi-herdr-presence-integration.md`](./pi-herdr-presence-integration.md) — Herdr presence 연동 상태와 남은 교차 검증
- [`tmux-window-naming-design.md`](./tmux-window-naming-design.md) — stable tmux window 이름과 pane title 역할 분리

## 참고 자료

- [`diagram/`](./diagram/) — Mermaid 원본과 렌더링된 SVG/PNG. 렌더링 방법은 [`development.md`의 다이어그램 렌더링](./development.md#다이어그램-렌더링)을 참고하세요.
- [`guidelines/`](./guidelines/) — 에이전트가 읽는 영어 문서 작성 지침
