# 개발

이 저장소는 하위 에이전트 오케스트레이션을 위한 Pi 확장 패키지입니다.

## 저장소

공식으로 내보낸 저장소:

<https://github.com/spi-ca/pi-subagent>

## 준비 사항

- `package.json`의 `packageManager` 필드와 맞는 Bun
- `tsconfig.json`이 참조하는 형제 Pi 패키지를 제공하는 Pi 체크아웃 또는 설치 레이아웃

## 명령

```bash
bun install
bun run check
bun test --pass-with-no-tests
bun run ci

# package file 목록에서 V2 broker entrypoint 확인
bun pm pack --dry-run
```

`bun run ci`는 타입 체크와 테스트를 실행합니다. `bun pm pack --dry-run` 출력에는 `src/runtime/pane-launch-broker.mjs`가 포함되어야 합니다. opt-in acceptance는 production과 같은 deterministic runtime/backend resolver를 사용합니다. runtime path는 선택된 실행 명령이고 interpreter path는 native binary 또는 첫 shebang interpreter입니다. env shebang과 Bun/Node를 `exec`하는 shell wrapper도 지원하므로 parent Pi의 `process.execPath`를 provenance로 신뢰하지 않습니다. live cmux/tmux는 명시적 environment gate가 필요합니다. cmux harness는 caller workspace를 disposable로 요구하지 않고, 자체 private workspace를 생성·정리합니다. 기본 CI에는 포함하지 않습니다. live crash/reaper E2E는 reaper 직전 fixture의 실제 absent/zombie 상태와 해당 exact run ID의 `reaped` 결과를 증거로 요구하며, platform zombie liveness 판정은 parser/reaper 단위 테스트가 별도로 보장합니다. package tarball smoke는 isolated tarball의 pack/install/exact-module-import/strict `subagent` registration만 확인하는 실행 증거가 있고 full Pi session은 범위 밖입니다. 정적 harness/unit/package 기준은 executable **GO**다. 설계 문서에는 live cmux run `accept-929d0c06-51a6-45ca-8bfb-098d719e8171`과 tmux run `accept-e6670112-84e7-4e1a-8a3f-95f77a5bc3df`의 **PASS**가 기록되어 있지만, 그 private retained evidence는 저장소에 포함되지 않으며 현재 worktree에서 독립 재실행한 결과로 간주하지 않는다. 상세 checkpoint·evidence·cleanup 규칙은 [`cmux-pi-tui-design.md`의 Acceptance runbook](cmux-pi-tui-design.md#12-acceptance-runbook)을 따른다.

```bash
bun run acceptance:dry-run
PI_SUBAGENT_PACKAGE_ACCEPTANCE=1 bun run acceptance:package -- --keep
# live tmux/cmux only when deliberately authorized:
PI_SUBAGENT_LIVE_TMUX=1 bun run acceptance:tmux -- --keep
PI_SUBAGENT_LIVE_CMUX=1 bun run acceptance:cmux -- --keep
```

## 개발 가정

이 패키지는 보통 기존 Pi 설치 내부에서 개발합니다. 타입 체크는 `tsconfig.json`을 통해 `../../npm/node_modules/@earendil-works/...` 같은 형제 Pi 패키지 경로에 의존합니다.

체크아웃을 해당 레이아웃 밖으로 옮기면 `bun run check`를 실행하기 전에 Pi 패키지를 설치하거나 경로를 매핑해야 합니다.

## 프로젝트 구조

```text
index.ts                    — Pi 패키지 manifest가 참조하는 확장 진입점
src/core/                   — 에이전트 발견, 신뢰/경로 검사, 스키마, 체인 헬퍼, 이벤트 파싱, 공통 타입
src/runtime/                — 자식 runner, cmux/tmux adapter, one-shot `pane-launch-broker.mjs`, 공통 interactive-pane backend, child bridge, V1 state/lease·V2 broker protocol, session tail, inline 경로
src/ui/                     — subagent 도구 호출과 결과를 위한 TUI 렌더링
test/core/                  — 발견, 신뢰, 메타데이터, 체인 동작, 공통 타입 단위 테스트
test/runtime/               — runner, cmux/tmux/backend/bridge/protocol/reaper, 인증 전파, CLI 파싱 테스트
test/entrypoint/            — 공개 확장/도구 진입점 계약 테스트
docs/                       — 주제별 문서
docs/guidelines/            — 문서와 에이전트 지침 작성 가이드
```

루트 `index.ts`는 의도적으로 그대로 둡니다. `package.json`의 Pi 패키지 manifest가 이 파일을 확장 진입점으로 참조하기 때문입니다. 내부 모듈은 `src/` 아래에 있고, 테스트는 같은 core/runtime 구분을 `test/` 아래에서 따릅니다.

## 개발 설계 문서

- [`cmux-pi-tui-design.md`](cmux-pi-tui-design.md) — legacy Zellij bridge를 제거하고 cmux/tmux 기반 실제 Pi TUI, V2 one-shot broker, session-backed result channel, orphan/recovery 방지와 opt-in acceptance runbook을 기록한 설계와 구현 기준
- [`pi-cmux-integration.md`](pi-cmux-integration.md) — `pi-subagent`와 `pi-cmux`의 역할 경계 및 운영 정책
- [`interactive-pane-layout-design.md`](interactive-pane-layout-design.md) — 구현된 `auto`/`split` layout의 설계·정적 테스트 범위와 live 검증 상태. cmux와 tmux `auto` smoke는 2026-07-20에 모두 **PASS**했으며, tmux smoke는 제한된 3 top-level + parent/2 nested 범위다. 기존 tmux crash/reaper **PASS**는 별도 acceptance다.
- [`interactive-runtime-performance-design.md`](interactive-runtime-performance-design.md) — Linux/macOS 전용 `node:net` lifecycle socket, `CompletionRecordV3`, cmux desktop control socket v2, gated `tmux -C` 및 polling 제거를 다루는 transport 성능 설계안(미구현). Windows는 현재 forced-inline이며 socket을 사용하지 않습니다.
- [`pi-subagent-hot-path-performance-design.md`](pi-subagent-hot-path-performance-design.md) — transport 설계 다음에 읽는 companion 문서. topology/cache/preflight/lease/UI/fork/I/O/tail/reaper, scheduler 및 managed-child 정책을 다루는 internal hot-path 설계안(미구현)입니다.

성능 설계에서 정상 run의 cmux backend `inspect()` polling 제거는 **Phase 2** 범위이고, gated `tmux -C` run의 polling 제거는 **Phase 3** 범위입니다. JSONL, `complete.json`, wrapper status의 250ms file polling을 제거하는 작업은 후속 단계이며, durable `complete.json`, 약 2초 parent lease/child lease check, startup reaper와 exact-target cleanup은 설계 후에도 유지합니다.

이 문서는 구현 의도와 후속 평가 항목을 설명하며, 현재 동작의 최종 source of truth는 코드와 테스트입니다.

## 문서 작성 방식

`docs/guidelines/`의 progressive disclosure 접근을 따릅니다.

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 예외를 추가하기보다 모순을 제거합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.
