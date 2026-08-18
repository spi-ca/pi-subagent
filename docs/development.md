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
bun test --isolate --pass-with-no-tests
bun run ci

# package file 목록에서 V2 broker entrypoint 확인
bun pm pack --dry-run
```

`bun run ci`는 타입 체크와 file isolation 테스트를 실행합니다. 테스트는 의도적으로 file-global Bun mock과 process global을 사용하므로 isolation이 필수입니다. `bun pm pack --dry-run` 출력에는 `src/runtime/pane-launch-broker.mjs`, `pi-subagent.schema.json`, `pi-subagent.detached-ownership.schema.json`가 포함되어야 합니다. opt-in acceptance는 production과 같은 deterministic runtime/backend resolver를 사용합니다. runtime path는 선택된 실행 명령이고 interpreter path는 native binary 또는 첫 shebang interpreter입니다. interactive preflight는 backend뿐 아니라 broker runtime/interpreter/entrypoint의 realpath·inode·metadata generation을 캡처하고 intent publish 및 broker spawn 직전에 다시 확인합니다. tmux는 canonical socket inode와 server PID start identity도 preflight와 publish 직전에 재검증합니다. env shebang과 Bun/Node를 `exec`하는 shell wrapper도 지원하므로 parent Pi의 `process.execPath`를 provenance로 신뢰하지 않습니다. live cmux/tmux는 명시적 environment gate가 필요합니다. cmux harness는 caller workspace를 disposable로 요구하지 않고, 자체 private workspace를 생성·정리합니다. 기본 push/schedule CI에는 포함하지 않으며 `.github/workflows/live-acceptance.yml`의 `workflow_dispatch`로만 tmux와 명시적 self-hosted cmux job을 실행합니다. 실제 multiplexer가 없는 CI에서는 `test/integration/fake-adapter-runner.e2e.test.ts`가 full `runAgent` completion/cancel/external-close/shutdown/reload를 검증합니다. broker acceptance에는 backend response 수신 뒤 `allocation.json` publish 전 exact STOP/kill window도 포함됩니다. live crash/reaper E2E는 reaper 직전 fixture의 실제 absent/zombie 상태와 해당 exact run ID의 `reaped` 결과를 증거로 요구하며, platform zombie liveness 판정은 parser/reaper 단위 테스트가 별도로 보장합니다. package tarball smoke는 isolated tarball의 pack/install/exact-module-import, strict `subagent` registration, bounded dashboard/aggregate `pi.events` probe와 두 public schema 포함만 확인하는 retained 실행 증거가 있고 full Pi session은 범위 밖입니다. 정적 harness/unit/package 기준은 executable **GO**다. 설계 문서에는 live cmux run `accept-929d0c06-51a6-45ca-8bfb-098d719e8171`과 tmux run `accept-e6670112-84e7-4e1a-8a3f-95f77a5bc3df`의 **PASS**가 기록되어 있지만, 그 private retained evidence는 저장소에 포함되지 않으며 현재 worktree에서 독립 재실행한 결과로 간주하지 않습니다. 상세 checkpoint·evidence·cleanup 규칙은 [`cmux-pi-tui-design.md`의 Acceptance runbook](./cmux-pi-tui-design.md#12-acceptance-runbook)을 따릅니다.

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
# cost 또는 cacheWrite1h/reasoning 같은 optional usage field는 검증하지 않는다.
# live tmux/cmux only when deliberately authorized. tmux commands use the
# explicit canonical executable rather than caller PATH.
TMUX_BIN=/absolute/path/to/tmux \
PI_SUBAGENT_LIVE_TMUX=1 bun run acceptance:tmux -- --keep
PI_SUBAGENT_LIVE_CMUX=1 bun run acceptance:cmux -- --keep
TMUX_BIN=/absolute/path/to/tmux \
PI_SUBAGENT_LIVE_TITLE_SMOKE=1 bun run title:live:tmux
PI_SUBAGENT_LIVE_TITLE_SMOKE=1 bun run title:live:cmux
# isolated mutating control-client stress probe (no provider call):
TMUX_BIN=/absolute/path/to/tmux \
PI_SUBAGENT_TMUX_CONTROL_STRESS_PROBE=1 bun run tmux:control-stress-probe
# development-only exact tmux 3.7a fixture; gate/probe/snapshot, fixture-owned cleanup,
# and provider-free staged Pi TUI startup only (no provider child is dispatched):
TMUX_BIN=/absolute/path/to/tmux-3.7a \
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi \
PI_SUBAGENT_REAL_TMUX_37A_FIXTURE=1 bun test test/acceptance/performance-phase0-live.test.ts
```

이 macOS arm64 gated test는 provider prompt/call 없이 staged Pi TUI의 `capture-pane -p` startup marker를 bounded poll한다. marker를 실제 capture에서 확인한 뒤에만 의도적 `Phase0CellFailure`를 주입하고 marker 관측을 독립적으로 assert하며, tmux server PID/start·socket generation에 결속된 teardown 뒤 server/socket root 부재를 확인한다. cleanup 증명이 실패하면 test도 실패한다.

### Phase 0 provider-live evidence (명시적 수동 record)

`benchmark:phase0:live:preflight`은 provider를 호출하거나 fixture를 읽지 않는 non-mutating 검사입니다. schema v4 live evidence는 두 tier만 지원합니다. `routine-v1`은 `inline | tmux | cmux` × 다섯 workload의 `activeRuns=1` 15 cells/15 children이며, 반복 capture에서 총 5~6분이 관찰됐습니다. `cmux-concurrency-16-v1`은 cmux `short-response`, `activeRuns=16` 한 cell/16 children이며, 반복 capture에서 약 8.2분이 관찰됐습니다. 두 값은 SLA가 아닙니다.

```bash
# non-mutating; fixture가 없더라도 실행 가능
bun run benchmark:phase0:live:preflight

# provider-backed record; scripts가 --execute-live, record gate, tier ack를 고정함
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi \
TMUX_BIN=/absolute/path/to/tmux \
CMUX_BIN=/absolute/path/to/cmux \
bun run benchmark:phase0:live:routine:record
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi \
TMUX_BIN=/absolute/path/to/tmux \
CMUX_BIN=/absolute/path/to/cmux \
bun run benchmark:phase0:live:concurrency:record

# fixed tier fixture paths의 current-source binding을 각각 검증
bun run benchmark:phase0:live:routine:verify
bun run benchmark:phase0:live:concurrency:verify
bun run benchmark:phase0:live:verify
```

provider-live는 caller `PATH`를 탐색해 Pi·tmux·cmux를 찾지 않으며, preflight는 **macOS arm64 native Pi profile만** 허용합니다. Pi version/auth/backend probe 또는 provider spawn 전에 selected canonical Pi generation을 `O_NOFOLLOW` descriptor로 다시 열고 path/generation을 재검증한 뒤, Mach-O 64-bit header의 CPU type이 정확히 `arm64`인지 확인합니다. Rosetta `x64`, universal Mach-O, ELF와 script를 모두 profile mismatch로 fail-closed합니다. operator는 native이며 stable `>=0.81.1`인 Pi executable과 canonical safe tmux/cmux executable의 절대 경로를 각각 `PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi`, `TMUX_BIN=/absolute/path/to/tmux`, `CMUX_BIN=/absolute/path/to/cmux`로 각 record 명령 앞에 명시적으로 prefix해야 합니다(패키지 script는 이를 설정하지 않습니다). Pi는 preflight generation의 canonical directory에서 검토된 macOS arm64 release profile인 `package.json`, `theme/{dark.json,light.json,theme-schema.json}`, `assets/clankolas.png`, `native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node`, `node_modules/@mariozechner/clipboard/{index.js,package.json}`, `node_modules/@mariozechner/clipboard-darwin-arm64/{package.json,clipboard.darwin-arm64.node}`, `photon_rs_bg.wasm`만 private staged native bundle로 한 번 고정합니다. 각 cell은 executable과 모든 asset의 identity·digest를 함께 재검증합니다. JSON은 parse, JS는 strict UTF-8, binary는 type별 size cap으로 검증하며, 모든 staged asset은 exclusive `0600` file입니다. `.node`는 Node의 `dlopen`에 filesystem execute bit가 필요 없으므로 `0600`을 유지합니다. 다른 file, symlink, directory tree, recursive copy 또는 future auto-discovery는 허용하지 않습니다. synthetic child runtime의 interpreter/backend resolution은 여전히 operator가 sanitize한 `PATH`를 신뢰하므로, `PATH`에는 trusted immutable entry만 넣어야 합니다. record에는 공통으로 `PI_SUBAGENT_PHASE0_LIVE=1`, `PI_SUBAGENT_PHASE0_LIVE_RECORD=1`, `--execute-live` 및 tier별 `--ack-provider-child-runs=15|16`가 필요합니다. concurrency에는 `PI_SUBAGENT_PHASE0_LIVE_CMUX16=1`과 `--ack-cmux-active-runs=16`도 필요합니다. 기록 대상은 고정된 `test/fixtures/transport-performance-phase0-live-routine.json` 및 `test/fixtures/transport-performance-phase0-live-concurrency.json`뿐입니다.

checkpoint schema는 v4입니다. routine의 `--max-cells=1..15` completed prefix만 resume할 수 있고, claim 뒤 각 provider cell 전에 terminalize되어 one-use입니다. resume은 recorded Pi version이 현재 preflight Pi version과 정확히 같고 source/tier/plan binding도 모두 일치할 때만 가능합니다. 이 continuity contract는 Pi version만 비교하므로 같은 version의 executable/theme bundle이 byte-identical하다는 보장은 하지 않습니다. backend version은 evidence나 checkpoint continuity claim에 기록하지 않습니다. concurrency partial resume과 automatic retry는 지원하지 않습니다. live synthetic parent는 명시 allowlist의 PATH/HOME/locale, proxy/CA와 명시 transport/harness 값만 받으며 ambient `PI_SUBAGENT_*`, credential, loader/shell hook, 임의 변수와 multiplexer state를 상속하지 않습니다. 실패 root를 retain할 때에는 raw diagnostic log 대신 top-level private `0600`의 bounded `failure-summary.json` 하나만 scrub 뒤 남을 수 있습니다. scrub은 default-deny이며 valid top-level checkpoint(있다면)와 valid summary 외 모든 파일·directory·symlink를 제거하고, 둘 다 없는 terminal root 또는 malformed summary면 root 전체를 폐기합니다. final summary overwrite가 증명되지 않으면 이전 summary가 남아 있어도 root를 폐기합니다. `cleanupProven`은 cell과 transport cleanup이 모두 증명된 경우에만 true입니다. fixture 유효성은 routine 및 concurrency current-source verifier가 모두 성공할 때만 판정합니다. source/test/docs 변경은 **amend하지 않고** 먼저 commit한 뒤 fixture를 regenerate하고, 그 생성물만 담은 두 번째 fixture-only commit을 만듭니다. fixture-only commit은 이전 effective source revision을 유지합니다. effective revision은 fixture를 제외한 source commit에 도달할 수 있는 Git history가 있어야 조회됩니다. fixture-only HEAD에서 history가 shallow/incomplete하면 fail closed하여 source revision lookup이 실패하며 HEAD를 source revision으로 취급하지 않습니다. CI checkout은 full history여야 합니다. source 변경과 fixture를 섞어 commit하면 effective source revision이 전진하므로, 그 commit 뒤 다시 regenerate하여 fixture-only commit을 새로 만들어야 합니다. 그 전의 fixture를 최종 검증 결과로 간주하지 않습니다. 세부 계약은 [`interactive-runtime-performance-design.md`](./interactive-runtime-performance-design.md#m0-harness-상태)를 따릅니다.

### Phase 7 reaper local benchmark

Phase 7의 non-mutating schema preflight, current-source fixture 검증과 고정 local baseline 기록은 다음 명령으로 실행합니다.

```bash
bun run benchmark:phase7:preflight
bun run benchmark:phase7:verify
bun run benchmark:phase7:record-local
```

기본 record는 실제 private 10,000-run filesystem과 100,000-node in-memory graph를 측정합니다. 실제 100,000-run filesystem 측정은 비용이 큰 명시적 opt-in이며 `PI_SUBAGENT_REAPER_BENCH_RUNS=100000 bun run benchmark:phase7:record-local`로만 실행합니다. 이 override 결과를 일반 baseline으로 남기려는 경우가 아니라면 checked-in fixture를 덮어쓰지 마세요.

### Generic presence producer 집중 검증

root-only producer는 shared [`@pi/presence` protocol (v2-20260818-2)](https://github.com/spi-ca/pi-presence/tree/v2-20260818-2)의 `subagent` projection만 생산한다. shared protocol grammar는 dependency 문서를 따르며, 이 repository의 aggregate, terminal dedupe, privacy와 consumer-transport isolation은 focused test로 확인한다. 새 session은 dashboard/presence observer를 등록하기 전에 process-local scheduler를 reset하므로, 즉시 전달되는 scheduler 구독이 이전 session의 queued/running 상태를 새 presence로 투영하지 않는다.

```bash
bun test --isolate test/integration/pi-presence-producer.test.ts test/entrypoint/index.test.ts
```

그 뒤 baseline은 `bun run ci`입니다. 이 deterministic 범위는 실제 consumer UI/socket 또는 live cmux/Herdr E2E를 증명하지 않는다.

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

클린 체크아웃에서도 `bun install --frozen-lockfile`만으로 타입 체크에 필요한 Pi API 패키지와 `typebox`를 설치합니다. Pi 개발 의존성은 `^0.82.0`으로 현재 0.82 patch line을 허용하고 lockfile이 실제 설치 버전을 고정하며, `typebox`는 exact pin합니다. `tsconfig.json`은 형제 Pi 설치 경로에 의존하지 않습니다.

Pi 관련 peer dependency는 host 설치를 막지 않도록 `"*"`로 유지합니다. interactive pane 실행에 필요한 Pi `>=0.80.10`은 peer range가 아니라 runtime version policy로 검사합니다.

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
src/runtime/                — 자식 runner, process-local scheduler와 durable tree permit/source ownership, cmux/tmux/Herdr adapter, one-shot `pane-launch-broker.mjs`, 공통 interactive-pane backend, child bridge, lifecycle/broker protocol, session tail, inline 경로
src/integration/            — `pi-cmux` 연동과 shared V2 root-only presence producer
src/ui/                     — subagent 도구 호출과 결과를 위한 TUI 렌더링
test/core/                  — 발견, 신뢰, 메타데이터, 체인 동작, 공통 타입 단위 테스트
test/runtime/               — runner, cmux/tmux/Herdr backend/bridge/protocol/reaper, 인증 전파, CLI 파싱 테스트
test/integration/           — presence producer, fake-adapter e2e 같은 통합 테스트
test/ui/                    — src/ui/ TUI 렌더링 테스트
test/entrypoint/            — 공개 확장/도구 진입점 계약 테스트
test/acceptance/            — opt-in live/package acceptance와 성능 벤치마크 harness
test/fixtures/              — cmux/tmux control 프로토콜과 layout 계약, 성능 baseline/live 등 고정 JSON fixture와 acceptance 전용 parent 헬퍼 스크립트 (`package.json`의 files와 여러 설계 문서가 직접 참조)
test/helpers/               — cmux control socket 관련 runtime 단위 테스트가 공유하는 fake server 헬퍼
test/release/               — package pack/release 스모크 테스트
docs/                       — 주제별 문서
docs/diagram/               — Mermaid 원본, 흰색 배경 SVG와 2x PNG
docs/guidelines/            — 문서와 에이전트 지침 작성 가이드
```

루트 `index.ts`는 의도적으로 그대로 둡니다. `package.json`의 Pi 패키지 manifest가 이 파일을 확장 진입점으로 참조하기 때문입니다. 내부 모듈은 `src/` 아래에 있고, 테스트는 같은 core/runtime 구분을 `test/` 아래에서 따릅니다.

## 개발 설계 문서

- [`cmux-pi-tui-design.md`](./cmux-pi-tui-design.md) — legacy Zellij bridge를 제거하고 cmux/tmux/Herdr 기반 실제 Pi TUI, V2 one-shot broker, session-backed result channel, Herdr fail-closed 점검, orphan/recovery 방지와 opt-in acceptance runbook을 기록한 설계와 구현 기준
- [`pi-cmux-integration.md`](./pi-cmux-integration.md) — `pi-subagent`와 `pi-cmux`의 역할 경계 및 운영 정책
- [`pi-cmux-presence-integration.md`](./pi-cmux-presence-integration.md) — shared V2 root-only presence producer, replay/privacy/authority 경계와 focused 검증
- [`pi-herdr-presence-integration.md`](./pi-herdr-presence-integration.md) — `pi-subagent` 관점의 shared V2 Herdr presence 경계와 검증 기준
- [`interactive-pane-layout-design.md`](./interactive-pane-layout-design.md) — cmux/tmux/Herdr의 구현된 `auto`/`split` layout, strict authority 경계와 정적 테스트 범위. cmux와 tmux `auto` smoke는 2026-07-20에 모두 **PASS**했으며, Herdr는 strict fake-socket/broker·protocol test 범위이고 tmux smoke는 제한된 3 top-level + parent/2 nested 범위입니다. 기존 tmux crash/reaper **PASS**는 별도 acceptance입니다.
- [`interactive-runtime-performance-design.md`](./interactive-runtime-performance-design.md) — Linux/macOS transport 설계와 구현 상태. cmux control-socket v2, private lifecycle socket, strict `CompletionRecordV3`, healthy cmux inspect polling 제거, optional events hint와 stable-minimum gated `tmux -C`가 구현됐습니다. Windows는 forced-inline입니다.
- [`pi-subagent-hot-path-performance-design.md`](./pi-subagent-hot-path-performance-design.md) — transport 설계 다음에 읽는 companion 문서. Phase 0A cache/preflight/UI/fork·async I/O, hardened lease, Phase 5 scheduler, Phase 6 exact tail/signature와 conservative Phase 7 reaper와 managed-child opt-in profile이 구현됐고 managed-child default 전환은 남아 있습니다.
- [`pi-081-usage-accounting-design.md`](./pi-081-usage-accounting-design.md) — Pi 0.81 foreground assistant/tool/summary usage persistence, interactive verified-final replay와 advisory preview의 구분, provider-backed installed-Pi acceptance, background completion usage 회계의 명시적 비목표
- [`tmux-window-naming-design.md`](./tmux-window-naming-design.md) — 구현된 stable tmux child window label, strict V2/V3 전달과 legacy recovery 경계; 2026-07-27 isolated title/window smoke는 PASS했지만 production broker 다중 child naming live scenario는 아직 주장하지 않음

성능 설계에서 정상 run의 cmux backend `inspect()` polling 제거는 **Phase 2** 범위이고, gated `tmux -C` run의 polling 제거는 **Phase 3** 범위입니다. healthy lifecycle 경로의 주기 polling은 제거됐으며, durable completion, 약 2초 parent lease/child lease check, degraded/final exact inspection, startup reaper와 exact-target cleanup은 유지합니다.

이 문서는 구현 의도와 후속 평가 항목을 설명하며, 현재 동작의 최종 source of truth는 코드와 테스트입니다.

## 문서 작성 방식

`docs/guidelines/`의 progressive disclosure 접근을 따릅니다.

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 예외를 추가하기보다 모순을 제거합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.

### Herdr 테스트 경계

Herdr 테스트에는 fake owner-only Unix socket을 사용하며 live mutating Herdr acceptance test는 실행하지 않습니다. 집중 검증 근거는 `bun test test/runtime/herdr.test.ts test/runtime/pane-launch-broker.test.ts test/runtime/interactive-reaper.test.ts test/runtime/runner-interactive.test.ts test/runtime/run-protocol.test.ts`입니다. protocol 19/20 workspace-scoped `layout.apply` 한 번(`tab_id` 없음, `focus: false`, root direct wrapper argv), strict `layout_apply.layout.root` 뒤의 `pane.get` terminal binding, `agent.get`/bounded `agent.wait`/single `agent.focus`, `pane.report_metadata`, 조용한 gate rejection, auto에서 `pane.send_text`와 parent mutation을 사용하지 않는 동작을 다룹니다. terminal `present|absent|unknown`, socket 교체와 legacy record fail-closed도 검증합니다. 현재 smoke는 non-mutating protocol-19 `agent.get`/`agent.wait`뿐이며 live focus 또는 metadata mutation을 주장하지 않습니다.
