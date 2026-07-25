# 개발

이 저장소는 하위 에이전트 오케스트레이션을 위한 Pi 확장 패키지입니다.

## 저장소

공식으로 내보낸 저장소:

<https://github.com/spi-ca/pi-subagent>

## 준비 사항

- `package.json`의 `packageManager` 필드와 맞는 Bun

## 명령

```bash
bun install --frozen-lockfile
bun run check
bun test --pass-with-no-tests
bun run ci

# package file 목록에서 V2 broker entrypoint 확인
bun pm pack --dry-run
```

`bun run ci`는 타입 체크와 테스트를 실행합니다. `bun pm pack --dry-run` 출력에는 `src/runtime/pane-launch-broker.mjs`, `pi-subagent.schema.json`, `pi-subagent.detached-ownership.schema.json`가 포함되어야 합니다. opt-in acceptance는 production과 같은 deterministic runtime/backend resolver를 사용합니다. runtime path는 선택된 실행 명령이고 interpreter path는 native binary 또는 첫 shebang interpreter입니다. interactive preflight는 backend뿐 아니라 broker runtime/interpreter/entrypoint의 realpath·inode·metadata generation을 캡처하고 intent publish 및 broker spawn 직전에 다시 확인합니다. tmux는 canonical socket inode와 server PID start identity도 preflight와 publish 직전에 재검증합니다. env shebang과 Bun/Node를 `exec`하는 shell wrapper도 지원하므로 parent Pi의 `process.execPath`를 provenance로 신뢰하지 않습니다. live cmux/tmux는 명시적 environment gate가 필요합니다. cmux harness는 caller workspace를 disposable로 요구하지 않고, 자체 private workspace를 생성·정리합니다. 기본 push/schedule CI에는 포함하지 않으며 `.github/workflows/live-acceptance.yml`의 `workflow_dispatch`로만 tmux와 명시적 self-hosted cmux job을 실행합니다. 실제 multiplexer가 없는 CI에서는 `test/integration/fake-adapter-runner.e2e.test.ts`가 full `runAgent` completion/cancel/external-close/shutdown/reload를 검증합니다. broker acceptance에는 backend response 수신 뒤 `allocation.json` publish 전 exact STOP/kill window도 포함됩니다. live crash/reaper E2E는 reaper 직전 fixture의 실제 absent/zombie 상태와 해당 exact run ID의 `reaped` 결과를 증거로 요구하며, platform zombie liveness 판정은 parser/reaper 단위 테스트가 별도로 보장합니다. package tarball smoke는 isolated tarball의 pack/install/exact-module-import, strict `subagent` registration, bounded dashboard/aggregate `pi.events` probe와 두 public schema 포함만 확인하는 retained 실행 증거가 있고 full Pi session은 범위 밖입니다. 정적 harness/unit/package 기준은 executable **GO**다. 설계 문서에는 live cmux run `accept-929d0c06-51a6-45ca-8bfb-098d719e8171`과 tmux run `accept-e6670112-84e7-4e1a-8a3f-95f77a5bc3df`의 **PASS**가 기록되어 있지만, 그 private retained evidence는 저장소에 포함되지 않으며 현재 worktree에서 독립 재실행한 결과로 간주하지 않는다. 상세 checkpoint·evidence·cleanup 규칙은 [`cmux-pi-tui-design.md`의 Acceptance runbook](cmux-pi-tui-design.md#12-acceptance-runbook)을 따른다.

```bash
bun run acceptance:dry-run
PI_SUBAGENT_PACKAGE_ACCEPTANCE=1 bun run acceptance:package -- --keep
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE=1 bun run acceptance:managed-child
# 명시 base compatibility lane: 지정한 executable은 정확히 Pi 0.80.10이어야 한다.
# executable을 지정하지 않은 일반 base acceptance만 PATH에서 가장 높은 stable >=0.80.10을 선택한다.
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE=1 \
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi-0.80.10/pi/pi \
bun run acceptance:managed-child
# provider auth/network usage까지 명시적으로 허용한 managed nested smoke 및 foreground usage persistence 확인:
# live는 PATH를 탐색하지 않는다. 검증할 Pi 0.81.1 regular executable의 절대 경로를 직접 지정한다.
# 예: /absolute/path/to/pi-0.81.1/pi/pi (버전 디렉터리가 아니라 executable file)
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE=1 \
PI_SUBAGENT_MANAGED_CHILD_LIVE_NESTED=1 \
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi-0.81.1/pi/pi \
bun run acceptance:managed-child
# 성공 stdout JSON은 `foregroundUsagePersistence: true`를 포함한다. 이 gate는 input/output/cacheRead/cacheWrite/totalTokens
# 다섯 base token field의 top-level/nested 일치와 이에 대응하는 get_session_stats token totals, private session JSONL persistence만 검증한다.
# cost 또는 cacheWrite1h/reasoning 같은 optional usage field와 footer 시각 렌더링은 검증하지 않는다.
# live tmux/cmux only when deliberately authorized:
PI_SUBAGENT_LIVE_TMUX=1 bun run acceptance:tmux -- --keep
PI_SUBAGENT_LIVE_CMUX=1 bun run acceptance:cmux -- --keep
PI_SUBAGENT_LIVE_TITLE_SMOKE=1 bun run title:live:tmux
PI_SUBAGENT_LIVE_TITLE_SMOKE=1 bun run title:live:cmux
```

### Phase 0 provider-live evidence (명시적 수동 record)

`benchmark:phase0:live:preflight`은 provider를 호출하거나 fixture를 읽지 않는 non-mutating 검사다. schema v4 live evidence는 두 tier만 지원한다. `routine-v1`은 `inline | tmux | cmux` × 다섯 workload의 `activeRuns=1` 15 cells/15 children이며, 반복 capture에서 총 5~6분이 관찰됐다. `cmux-concurrency-16-v1`은 cmux `short-response`, `activeRuns=16` 한 cell/16 children이며, 반복 capture에서 약 8.2분이 관찰됐다. 두 값은 SLA가 아니다.

```bash
# non-mutating; fixture가 없더라도 실행 가능
bun run benchmark:phase0:live:preflight

# provider-backed record; scripts가 --execute-live, record gate, tier ack를 고정함
bun run benchmark:phase0:live:routine:record
bun run benchmark:phase0:live:concurrency:record

# fixed tier fixture paths의 current-source binding을 각각 검증
bun run benchmark:phase0:live:routine:verify
bun run benchmark:phase0:live:concurrency:verify
bun run benchmark:phase0:live:verify
```

record에는 공통으로 `PI_SUBAGENT_PHASE0_LIVE=1`, `PI_SUBAGENT_PHASE0_LIVE_RECORD=1`, `--execute-live` 및 tier별 `--ack-provider-child-runs=15|16`가 필요하다. concurrency에는 `PI_SUBAGENT_PHASE0_LIVE_CMUX16=1`과 `--ack-cmux-active-runs=16`도 필요하다. 기록 대상은 고정된 `test/fixtures/transport-performance-phase0-live-routine.json` 및 `test/fixtures/transport-performance-phase0-live-concurrency.json`뿐이다.

checkpoint schema는 v3이다. routine의 `--max-cells=1..15` completed prefix만 resume할 수 있고, claim 뒤 각 provider cell 전에 terminalize되어 one-use다. concurrency partial resume과 automatic retry는 지원하지 않는다. fixture 유효성은 routine 및 concurrency current-source verifier가 모두 성공할 때만 판정한다. 문서 변경 뒤에는 네 source-bound fixture를 다시 생성한 뒤 이 두 verifier를 실행해야 하며, 그 전의 fixture를 최종 검증 결과로 간주하지 않는다. 세부 계약은 [`interactive-runtime-performance-design.md`](interactive-runtime-performance-design.md#m0-harness-상태)를 따른다.

### Generic presence producer 집중 검증

root-only presence producer의 wire DTO, session/generation fence, `ready` replay의 `attention: "none"`, cumulative terminal count와 observer failure 격리는 다음 focused test로 확인합니다.

```bash
bun test test/integration/pi-presence-producer.test.ts
```

그 뒤 baseline은 `bun run ci`입니다. 이 non-live 범위는 별도 `pi-cmux-presence` package의 실제 consumer 또는 live cmux E2E 조합을 증명하지 않습니다. producer는 dependency 없이 duplicated wire contract를 유지하고, cmux CLI/socket mutation이나 lifecycle authority를 갖지 않습니다.

### Issue #24 완료: interactive completion boundary 집중 검증

아래는 abnormal completion의 V3 generic boundary, child/parent completion-fence·ACK FIFO(단, reaper는 proven-quiescent/dead owner 뒤 별도 observer 경로), identity-bound final replay, boundary-less V3의 delayed exact-child permit settlement, reaper transcript retention을 확인하는 비-live 범위입니다.

```bash
bun test test/runtime/completion-v3.test.ts
bun test test/runtime/session-tail.test.ts
bun test test/runtime/run-protocol.test.ts
bun test test/runtime/child-bridge.test.ts
bun test test/runtime/runner-interactive.test.ts
bun test test/runtime/interactive-reaper.test.ts
bun test test/runtime/tree-permit-authority.test.ts
bun test test/integration/fake-adapter-runner.e2e.test.ts
```

이 focused 범위는 실제 cmux/tmux acceptance를 실행하지 않습니다. 따라서 이 변경에 대해 live cmux/tmux acceptance 통과를 주장하지 않습니다. 실제 multiplexer를 의도적으로 승인해 검증할 때만 위의 `PI_SUBAGENT_LIVE_TMUX` 또는 `PI_SUBAGENT_LIVE_CMUX` 명령을 사용합니다.

## 개발 의존성

클린 체크아웃에서도 `bun install --frozen-lockfile`만으로 타입 체크에 필요한 Pi API 패키지와 `typebox`를 설치합니다. 개발 의존성은 Pi `0.82.0` 및 호환되는 `typebox` 버전에 정확히 고정되어 있으며, `tsconfig.json`은 형제 Pi 설치 경로에 의존하지 않습니다.

배포 시 호스트 Pi와의 호환성 범위는 별도 peer dependency가 담당합니다. 특히 `@earendil-works/pi-coding-agent`의 production 최소 버전은 `>=0.80.10`으로 유지됩니다.

## 다이어그램 렌더링

Mermaid 원본과 렌더링 결과는 `docs/diagram/`에 함께 둡니다. SVG와 2x PNG는 모두 흰색 배경으로 생성합니다.

```bash
for src in docs/diagram/*.mmd; do
  stem="${src%.mmd}"
  bunx @mermaid-js/mermaid-cli \
    -p docs/diagram/puppeteer-config.json \
    -c docs/diagram/mermaid-config.json \
    -i "$src" -o "$stem.svg" -b white
  bunx @mermaid-js/mermaid-cli \
    -p docs/diagram/puppeteer-config.json \
    -c docs/diagram/mermaid-config.json \
    -i "$src" -o "$stem.png" -b white -s 2
done
```

## 프로젝트 구조

```text
index.ts                    — Pi 패키지 manifest가 참조하는 확장 진입점
src/core/                   — 에이전트 발견, 신뢰/경로 검사, 스키마, 체인 헬퍼, 이벤트 파싱, 공통 타입
src/runtime/                — 자식 runner, process-local scheduler와 durable tree permit/source ownership, cmux/tmux adapter, one-shot `pane-launch-broker.mjs`, 공통 interactive-pane backend, child bridge, lifecycle/broker protocol, session tail, inline 경로
src/ui/                     — subagent 도구 호출과 결과를 위한 TUI 렌더링
test/core/                  — 발견, 신뢰, 메타데이터, 체인 동작, 공통 타입 단위 테스트
test/runtime/               — runner, cmux/tmux/backend/bridge/protocol/reaper, 인증 전파, CLI 파싱 테스트
test/entrypoint/            — 공개 확장/도구 진입점 계약 테스트
docs/                       — 주제별 문서
docs/diagram/               — Mermaid 원본, 흰색 배경 SVG와 2x PNG
docs/guidelines/            — 문서와 에이전트 지침 작성 가이드
```

루트 `index.ts`는 의도적으로 그대로 둡니다. `package.json`의 Pi 패키지 manifest가 이 파일을 확장 진입점으로 참조하기 때문입니다. 내부 모듈은 `src/` 아래에 있고, 테스트는 같은 core/runtime 구분을 `test/` 아래에서 따릅니다.

## 개발 설계 문서

- [`cmux-pi-tui-design.md`](cmux-pi-tui-design.md) — legacy Zellij bridge를 제거하고 cmux/tmux 기반 실제 Pi TUI, V2 one-shot broker, session-backed result channel, orphan/recovery 방지와 opt-in acceptance runbook을 기록한 설계와 구현 기준
- [`pi-cmux-integration.md`](pi-cmux-integration.md) — `pi-subagent`와 `pi-cmux`의 역할 경계 및 운영 정책
- [`pi-cmux-presence-integration.md`](pi-cmux-presence-integration.md) — root-only generic presence producer, duplicated wire contract, replay/privacy/authority 경계와 focused 검증
- [`interactive-pane-layout-design.md`](interactive-pane-layout-design.md) — 구현된 `auto`/`split` layout의 설계·정적 테스트 범위와 live 검증 상태. cmux와 tmux `auto` smoke는 2026-07-20에 모두 **PASS**했으며, tmux smoke는 제한된 3 top-level + parent/2 nested 범위다. 기존 tmux crash/reaper **PASS**는 별도 acceptance다.
- [`interactive-runtime-performance-design.md`](interactive-runtime-performance-design.md) — Linux/macOS transport 설계와 구현 상태. cmux control-socket v2, private lifecycle socket, strict `CompletionRecordV3`, healthy cmux inspect polling 제거, optional events hint와 stable-minimum gated `tmux -C`가 구현됐습니다. Windows는 forced-inline입니다.
- [`pi-subagent-hot-path-performance-design.md`](pi-subagent-hot-path-performance-design.md) — transport 설계 다음에 읽는 companion 문서. Phase 0A cache/preflight/UI/fork·async I/O, hardened lease, Phase 5 scheduler, Phase 6 exact tail/signature와 conservative Phase 7 reaper와 managed-child opt-in profile이 구현됐고 portable OS hard resource policy/default 전환은 남아 있습니다.
- [`pi-081-usage-accounting-design.md`](pi-081-usage-accounting-design.md) — Pi 0.81 foreground assistant/tool/summary usage persistence, interactive verified-final replay와 advisory preview의 구분, provider-backed installed-Pi acceptance, background 사용량 회계의 현재 한계·후속 upstream 요구
- [`tmux-window-naming-design.md`](tmux-window-naming-design.md) — tmux child window 이름과 Pi pane title의 역할을 분리하는 **미구현 제안**; 현재 runtime 동작이나 live PASS를 주장하지 않음

성능 설계에서 정상 run의 cmux backend `inspect()` polling 제거는 **Phase 2** 범위이고, gated `tmux -C` run의 polling 제거는 **Phase 3** 범위입니다. healthy lifecycle 경로의 주기 polling은 제거됐으며, durable completion, 약 2초 parent lease/child lease check, degraded/final exact inspection, startup reaper와 exact-target cleanup은 유지합니다.

이 문서는 구현 의도와 후속 평가 항목을 설명하며, 현재 동작의 최종 source of truth는 코드와 테스트입니다.

## 문서 작성 방식

`docs/guidelines/`의 progressive disclosure 접근을 따릅니다.

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 예외를 추가하기보다 모순을 제거합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.
