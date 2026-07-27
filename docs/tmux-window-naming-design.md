# 안정적인 tmux window 이름 설계 및 구현

> **상태:** 좁은 범위 구현 완료. `tmux-pane`의 `auto` 배치가 만드는 새 window는 agent와 run을 구분하는 안정적인 이름을 allocation 시 한 번 설정한다. strict V2/V3 protocol 검증과 non-live 단위·broker 테스트를 완료했다. 2026-07-27 isolated gated tmux title/window smoke에서 `new-window -n` 이름, effective `automatic-rename=off`, lifecycle title과 window 이름의 분리, user rename 보존, target 정리 뒤 source·sentinel 보존을 **PASS**했다. 이 smoke는 production runner/broker를 거치지 않고 공통 label builder와 wrapper 및 tmux를 직접 호출하므로 production-path live 증거는 아니다.

## 1. 목표와 범위

`tmux-pane`의 `auto` 배치는 parent와 같은 session에 child별 detached window를 만든다. 이 window를 tmux status line과 `choose-tree`에서 구분할 수 있도록 다음 이름을 사용한다.

```text
subagent:<agent-token>:<run-prefix>
```

예:

```text
subagent:reviewer:a14f82c1
subagent:worker:5d2e09ab
```

이번 구현은 **tmux window label만** 변경한다.

- 기존 Pi pane title과 `queued`, `ready`, `running`, `waiting`, `returning`, `failed` lifecycle suffix는 바꾸지 않는다.
- cmux surface title, layout, lifecycle 동작은 바꾸지 않는다.
- 이름은 navigation과 진단을 위한 hint이며 allocation, completion, ownership, cleanup authority가 아니다.
- task, prompt, cwd, 경로, 결과, credential은 이름에 포함하지 않는다.

## 2. 이름 계약

공통 구현은 `src/runtime/tmux-window-label.mjs`에 있다. `src/runtime/tmux.ts`의 direct adapter와 production launch intent가 같은 builder를 사용하고, `src/runtime/pane-launch-broker.mjs`가 같은 validator를 사용한다.

### 2.1 agent token

- printable ASCII가 아닌 문자가 입력에 있으면 전체 token을 `agent` fallback으로 바꾼다.
- 허용 문자는 `[A-Za-z0-9._-]`이다.
- 그 밖의 연속 문자는 `-`로 치환하고 앞뒤 `-`를 제거한다.
- 첫 문자는 영숫자여야 한다.
- 최대 24자이며 비어 있으면 `agent`를 사용한다.

### 2.2 run prefix

- run ID에서 같은 token 규칙을 적용한 앞 8자를 사용한다.
- 비어 있거나 non-printable 입력이면 `run`을 사용한다.
- validator는 label의 run prefix가 intent의 `runId`에서 계산한 값과 정확히 같은지 확인한다.

전체 label은 다음 정규형만 허용한다.

```text
^subagent:[A-Za-z0-9][A-Za-z0-9._-]{0,23}:[A-Za-z0-9][A-Za-z0-9._-]{0,7}$
```

따라서 control character, ESC/OSC/CSI, newline, tab, bidi control, Unicode, `#{...}`와 `#(...)` 같은 tmux format/injection 문자열은 canonical label에 남지 않는다. label은 shell 문자열 조합이 아니라 tmux argv의 `-n` 다음 단일 값으로 전달한다.

## 3. protocol과 broker 경계

### 3.1 current launch intent

`src/runtime/runner.ts`는 placement가 정확히 `tmux-new-window`일 때만 `windowLabel`을 생성한다.

- current V2/V3 `tmux-new-window` intent는 `windowLabel`을 반드시 포함한다.
- `tmux-split`, cmux placement와 legacy non-layout intent는 `windowLabel`을 거부한다.
- V3에서는 label이 immutable `launch-intent.json`의 일부이므로 기존 exact-byte SHA-256 digest chain에 자동으로 포함된다.
- label이 없거나 malformed이거나 `runId`와 맞지 않으면 broker allocation 전에 fail-closed한다.

label은 allocation record나 target fingerprint에 복제하지 않는다. 이름이 바뀌어도 source binding과 cleanup authority가 달라지지 않도록 하기 위해서다.

### 3.2 legacy recovery

기능 도입 전에 생성된 label-less V2/V3 `tmux-new-window` artifact는 read-only recovery/reaper 경로에서만 명시적인 compatibility option으로 읽는다.

- current parent publication과 broker mutation parser는 label-less new-window intent를 거부한다.
- stale-run reaper parser만 기존 exact allocation fingerprint를 해석하기 위해 compatibility option을 사용한다. current run finalization과 retained cleanup 판단은 strict parser를 유지한다.
- legacy fallback으로 `subagent:broker`를 다시 생성하거나 이름으로 target을 검색하지 않는다.

### 3.3 allocation

production broker는 allocation command에 다음 형태로 label을 한 번 전달한다.

```text
tmux new-window ... -t '<session-id>:' -n '<validated-windowLabel>' ...
```

이름은 `new-window` allocation과 함께 설정된다. broker는 이후 다음 작업을 하지 않는다.

- `rename-window`
- `set-option automatic-rename ...`
- window 이름 readback 또는 name-based lookup
- 사용자 rename 복구
- lifecycle별 window 이름 갱신

allocation 후에는 returned `session_id|window_id|pane_id|pane_pid`와 server generation만 durable authority가 된다. diagnostic 이름 확인을 위해 allocation publication 전 mutation/readback 단계를 추가하지 않는다.

## 4. pane title과 lifecycle

기존 child Pi title 형식은 유지한다.

```text
<agent> [depth=<n>;run=<run-prefix>] · queued
<agent> [depth=<n>;run=<run-prefix>] · running
<agent> [depth=<n>;run=<run-prefix>] · waiting
```

`src/runtime/child-bridge.ts`가 lifecycle event에 따라 pane/Pi title을 best-effort로 갱신한다. tmux window 이름은 그 event를 구독하지 않는다. 따라서 window navigation label은 안정적이고 pane title은 상태를 표현한다.

사용자가 window 또는 pane title을 바꿔도 runner나 broker가 강제 복구하지 않는다. title mismatch와 관측 실패도 completion 또는 cleanup failure로 승격하지 않는다.

## 5. 안전성과 authority 분리

| 책임 | authority | window label의 역할 |
|---|---|---|
| tmux allocation | broker가 받은 exact session/window/pane/PID fingerprint | allocation argv의 diagnostic input |
| child completion | child bridge와 durable completion artifact | 없음 |
| interrupt/close/reaper | socket/server generation과 exact pane/PID fingerprint | lookup key로 사용 금지 |
| 사용자 탐색 | tmux status line과 `choose-tree` | 짧고 안정적인 표시 이름 |

window는 여러 session에 link될 수 있고 사용자가 언제든 rename할 수 있으므로 이름을 identity나 ownership marker로 사용하지 않는다. broad window/session search, name-based rediscovery, `kill-window` fallback도 추가하지 않는다.

## 6. 검증 상태

다음 non-live 범위를 구현과 함께 검증한다.

- canonical label 생성: 빈 값, 특수문자, Unicode/control/escape/bidi, tmux format, 긴 입력
- direct adapter가 정확히 하나의 `-n <label>` argv를 전달하고 task-like run tail을 노출하지 않음
- V2/V3 current intent의 required field와 placement별 strict rejection
- legacy label-less artifact의 recovery-only parsing
- V3 label 변경이 exact digest chain을 무효화함
- broker가 missing/invalid/run-mismatched label에서 tmux command 전에 fail-closed함
- production broker가 고정 `subagent:broker`, rename, option mutation, name lookup을 사용하지 않음
- 기존 exact allocation publication과 rollback/cleanup semantics 유지

다음 focused 검증과 TypeScript check를 통과했다.

```bash
bun test test/runtime/tmux.test.ts test/runtime/run-protocol.test.ts \
  test/runtime/tmux-control-protocol.test.ts test/runtime/pane-launch-broker.test.ts \
  test/runtime/interactive-reaper.test.ts test/acceptance/live-title-smoke.test.ts
bun run check
```

2026-07-27 `PI_SUBAGENT_LIVE_TITLE_SMOKE=1 bun run title:live:tmux`도 isolated tmux server에서 다음을 **PASS**했다. 이 harness는 production runner/broker를 우회하므로 tmux semantics와 공통 helper/wrapper의 live 증거로만 사용한다.

1. canonical `new-window -n` 이름의 실제 관측
2. exact window의 effective `automatic-rename=off`
3. pane title의 `queued → running` 전환 중 window 이름 역할 분리
4. user rename이 lifecycle title 전환 뒤에도 보존됨
5. target 정리 전후 source·sentinel pane 보존

기존 gated tmux crash/reaper acceptance도 같은 날 `accept-219f0fc1-5d34-4665-85f1-409430aca6ce`로 **PASS**했지만 이 harness는 split allocation을 사용하므로 stable window naming 자체의 production-path 증거가 아니다. production runner/broker를 통한 single/multi-child stable label과 complete/cancel/reaper 조합은 아직 live PASS로 주장하지 않는다.

## 7. 의도적으로 제외한 변경

### pane title을 window label과 같은 base로 통합

window 탐색성 개선에 필요하지 않고 기존 depth/run 진단과 cmux 출력까지 바꿀 수 있어 제외했다. 두 표면은 역할이 다르므로 별도 helper와 형식을 유지한다.

### lifecycle suffix를 window 이름에 반영

navigation label이 계속 바뀌고 여러 writer 사이 race를 만들므로 제외했다. dynamic 상태는 pane/Pi title만 담당한다.

### task 또는 prompt 요약 포함

민감한 사용자 텍스트와 output-injection 표면을 tmux status와 진단으로 넓히므로 제외했다.

### 별도 automatic-rename mutation과 이름 복구

사용자 option과 rename을 침범하고 post-allocation mutation 구간을 늘리므로 제외했다. 지원 tmux에서 `new-window -n`의 실제 동작은 isolated gated live acceptance에서만 관측한다.

## 8. 관련 파일

- `src/runtime/tmux-window-label.mjs` — canonical builder와 validator
- `src/runtime/tmux.ts` — direct `new-window -n` argv와 compatibility helper
- `src/runtime/run-protocol.ts` — strict V2 intent와 recovery-only legacy parser option
- `src/runtime/tmux-control-protocol.ts` — V3 promotion과 digest-bound parsing
- `src/runtime/runner.ts` — `tmux-new-window` intent의 label 생성
- `src/runtime/pane-launch-broker.mjs` — strict broker validation과 allocation argv
- `src/runtime/child-bridge.ts` — 변경하지 않은 Pi lifecycle title writer
- `test/runtime/tmux.test.ts`
- `test/runtime/run-protocol.test.ts`
- `test/runtime/tmux-control-protocol.test.ts`
- `test/runtime/pane-launch-broker.test.ts`
- `test/runtime/interactive-reaper.test.ts`
- `test/acceptance/live-title-smoke.ts`
