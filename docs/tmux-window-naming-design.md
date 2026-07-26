# tmux window 이름과 Pi pane title 정책 제안

> **상태:** 제안 — 미구현. 이 문서는 현재 runtime을 근거로 한 설계/구현 계획이다. 아래 정책, 코드 변경, 테스트, live 검증은 아직 완료되었다고 주장하지 않는다. 2026-07-26 기준 `src/runtime/pane-launch-broker.mjs`는 여전히 고정 `-n subagent:broker` label을 사용하고, `src/runtime/tmux.ts`의 `buildTmuxDiagnosticTitle()`/`buildTmuxNewWindowArgs()`와 `src/runtime/runner.ts`의 `buildChildRuntimeTitle()`은 서로 다른 sanitization 규칙을 가진 별도 helper로 남아 있으며, `windowLabel` field는 `src/runtime/run-protocol.ts`/`src/runtime/tmux-control-protocol.ts`의 launch intent에 존재하지 않는다. 아래 §2는 이 미구현 상태의 근거를 기술하고, §3 이후는 여전히 제안이다.

## 1. 목표

`tmux-pane`의 `auto` 배치가 만드는 child window를 목록에서 빠르게 구분하되, 실행 중인 Pi의 상태는 pane/Pi title에서만 동적으로 보여 준다.

- tmux **window 이름**은 child 수명 동안 안정적인 짧은 식별자여야 한다.
- Pi **pane title**은 `ready`, `running`, `waiting`, `returning`, `failed` 같은 lifecycle 상태를 반영할 수 있어야 한다.
- task, prompt, cwd, 경로, 결과, credential은 어느 이름에도 포함하지 않는다.
- 이름은 UX/진단 정보일 뿐 allocation, completion, ownership, cleanup authority가 아니다.

이 문서의 window naming 변경은 `tmux-pane`에 한정한다. 공통 canonical helper 정렬로 특수문자가 포함된 cmux surface label의 sanitization 결과는 달라질 수 있지만, cmux의 title 형식·lifecycle 갱신·interactive layout 정책은 바꾸지 않는다.

## 2. 현재 동작 (근거: 현재 source)

### 2.1 cmux/tmux의 공통 managed title

`src/runtime/runner.ts`의 `buildChildRuntimeTitle()`은 agent 이름과 run ID 앞 8자를 조합해 `PI_SUBAGENT_MANAGED_TITLE`에 넣는다. interactive wrapper는 같은 파일의 `buildInteractivePaneWrapperScript()`에서 OSC 2로 초기 title을 설정한다.

```text
subagent:<agent>:<run-prefix>
```

`src/runtime/child-bridge.ts`는 `resolveRuntimeTitle()`로 이 환경 변수를 printable ASCII 1–96자로 다시 검증한다. UI가 있을 때 `session_start`, `agent_start`, `agent_end`, terminal 처리에서 Pi `ctx.ui.setTitle()`을 호출하며 다음 suffix를 붙인다.

```text
 · ready | running | waiting | returning | failed
```

따라서 현재 child Pi pane title은 lifecycle에 따라 변할 수 있다. `src/runtime/runner.ts`의 active interactive registry는 별도로 `surfaceTitle`을 만들고, `inspectInteractiveRunForUx()`에서 observed title과 정확히 비교해 `matching`, `changed`, `unavailable`을 계산한다. 이 expected value와 bridge가 쓰는 suffix title은 동일한 lifecycle contract로 모델링되어 있지 않다.

### 2.2 tmux `auto` window 이름

현재 layout-aware production broker인 `src/runtime/pane-launch-broker.mjs`는 `tmux-new-window` allocation에서 다음처럼 고정 label을 전달한다.

```text
tmux new-window ... -n subagent:broker ...
```

즉 같은 session에 detached child window를 만드는 `auto` 배치에서는 agent/run별 stable window 이름을 아직 제공하지 않는다. broker는 strict `session_id|window_id|pane_id|pane_pid` fingerprint를 parsing하고 durable allocation을 publish하지만, window label은 이 identity의 일부도 lifecycle authority도 아니다.

한편 `src/runtime/tmux.ts`에는 direct adapter용 `buildTmuxDiagnosticTitle()` 및 `buildTmuxNewWindowArgs()`가 있다. 이 helper는 `subagent:<sanitized-agent>:<run-prefix>`를 만들지만, 현재 production layout-aware broker의 `subagent:broker` label과는 다른 경로다.

### 2.3 `/subagents` UX

`index.ts`의 `/subagents details <run-id>`는 active run의 agent, backend/placement, ownership, target, focus/promote capability와 `managedTitle`/`titleState`를 표시한다. raw observed terminal title은 표시하지 않는다. 이 경계는 유지해야 한다.

## 3. 선택 정책 (제안)

같은 base label을 한 번만 만들고, window와 pane title의 역할을 명시적으로 분리한다.

| 표면 | 제안 이름 | 변경 시점 | 용도 |
|---|---|---|---|
| tmux window | `subagent:<agent-token>:<run-prefix>` | allocation 후 한 번 | stable navigation/`choose-tree` 식별자 |
| Pi pane title | `<window-label> · <state>` | bridge lifecycle event마다 | 현재 child 실행 상태 |
| `/subagents details` | base label과 managed-state 비교 결과 | exact target inspection 때 | sanitized diagnostic |

예시:

```text
window:     subagent:reviewer:a14f82c1
pane title: subagent:reviewer:a14f82c1 · running
pane title: subagent:reviewer:a14f82c1 · waiting
```

window 이름에는 lifecycle suffix를 붙이지 않는다. tmux window의 이름이 자주 바뀌면 status line, `choose-tree`, 사용자의 탐색 맥락이 흔들리고, user rename과 자동 rename의 구분도 어려워진다.

## 4. 이름 생성 및 sanitization (제안)

### 4.1 단일 canonical helper

`src/runtime/runner.ts`의 `buildChildRuntimeTitle()`을 단순히 복제하지 않는다. shared helper를 `src/runtime/tmux.ts` 또는 작은 runtime title module에 두고, runner·broker·direct adapter가 같은 **base label**을 사용하게 한다.

입력은 오직 다음이다.

- `agentName`
- `runId`의 앞 8자

출력 규칙:

1. prefix는 항상 `subagent:`다.
2. agent token은 ASCII 문자 `[A-Za-z0-9._-]`만 남기고, 나머지 연속 문자는 `-` 하나로 치환한다.
3. 앞뒤 `-`를 제거하고, 비어 있으면 `agent`를 사용한다.
4. run prefix는 run ID의 앞 8자를 사용하고 `[A-Za-z0-9_-]`만 허용한다. 비어 있으면 `run`을 사용한다.
5. 96자 한계에서는 고정 prefix, separator, 전체 run prefix와 가장 긴 lifecycle suffix(` · returning`) 공간을 먼저 예약하고 **agent token만** 축약한다.
6. 따라서 base label은 언제나 전체 run prefix를 보존하며, 모든 dynamic pane title은 정확히 `<base-label> · <state>` 형식과 96자 한계를 함께 만족한다.

이는 현재 `src/runtime/tmux.ts`의 `buildTmuxDiagnosticTitle()`과 비슷한 token policy를 canonical path로 삼되, `src/runtime/runner.ts`의 printable-space 보존 정책과 divergent output을 없애는 방향이다. exact maximum-length 계산과 run-prefix 보존 규칙은 helper와 unit test 한 곳에서만 정의한다.

### 4.2 privacy와 terminal safety

다음 값은 title/window name 입력으로 금지한다.

- task, prompt, tool argument, assistant output
- `cwd`, repository path, session path, wrapper path
- provider/API key, token, environment value
- user가 입력한 임의 tmux format string 또는 shell text

이름은 tmux argv의 개별 값으로만 전달한다. shell command 조합이나 OSC escape sequence에 raw agent text를 삽입하지 않는다. control character, ESC/OSC/CSI, newline, tab, bidi/control Unicode은 helper 이전에 제거/치환한다. tmux format expansion을 유발할 수 있는 `#(`, `#{...}`를 별도 실행 문자열로 만들지 않으며, canonical helper가 허용하지 않는 문자는 출력에 남지 않는다.

## 5. data flow와 최소 코드 변경 (제안)

```text
runner (agentName, runId)
  ├─ canonical base-label helper
  ├─ PI_SUBAGENT_MANAGED_TITLE=<base-label>
  ├─ wrapper initial OSC title=<base-label>
  └─ strict launch intent windowLabel=<base-label> (diagnostic only)

run-protocol.ts + tmux-control-protocol.ts
  └─ exact field validation + V3 intent digest binding

pane-launch-broker.mjs
  └─ tmux new-window -n <validated-windowLabel>
       └─ exact returned window/pane fingerprint → allocation record

child-bridge.ts
  └─ <base-label> + lifecycle suffix → ctx.ui.setTitle()

runner inspection + index.ts /subagents
  └─ compare only against expected managed-title forms; report sanitized state
```

### 5.1 `src/runtime/runner.ts`

- base label helper를 호출해 `PI_SUBAGENT_MANAGED_TITLE`, wrapper `surfaceTitle`, active registry의 expected base title을 같은 값으로 만든다.
- layout-aware tmux intent에 canonical `windowLabel`을 넣는다. 이 필드는 run identity나 allocation authority를 대체하지 않는 diagnostic field지만 loose optional field로 다루지 않는다. 현재 production runner는 항상 기록하고 broker는 canonical 형식을 strict하게 검증해야 한다.
- 이전 label-less artifact의 reaper/진단 호환성을 유지할 별도 legacy parser branch를 둔다. 새 production launch가 label 누락을 `subagent:broker`로 fallback하는 것은 허용하지 않는다.
- `inspectInteractiveRunForUx()`은 observed title이 base label 또는 base label + 허용 lifecycle suffix인 경우 managed title로 인식하도록 변경한다. 다른 title은 현재처럼 `changed`, 조회 실패/빈 title은 `unavailable`로 둔다.

### 5.2 `src/runtime/run-protocol.ts`와 `src/runtime/tmux-control-protocol.ts`

- `LayoutTmuxLaunchIntentV2`와 exact key parser에 canonical `windowLabel` field를 추가하고 값이 canonical helper의 출력 계약을 만족하는지 검증한다.
- V3 `LaunchIntentV3`에도 같은 field가 승격되도록 하며, 기존 intent artifact 전체의 SHA-256 digest binding이 label까지 포함하는지 protocol test로 고정한다.
- parent parser와 broker-local strict parser를 함께 변경한다. 한쪽만 field를 허용하거나 label을 digest 밖의 side channel로 전달해서는 안 된다.
- upgrade 중 남은 label-less V2/V3 artifact는 명시적인 legacy 진단/reaper branch에서만 읽는다. 새 allocation mutation authority에는 canonical label이 포함된 current intent가 필요하다.

### 5.3 `src/runtime/child-bridge.ts`

- `PI_SUBAGENT_MANAGED_TITLE`의 strict validation을 canonical base-label validation으로 맞춘다.
- 현재 lifecycle event의 state mapping은 유지한다. bridge만 dynamic Pi title writer이며 broker와 parent runner는 lifecycle마다 tmux rename을 시도하지 않는다.
- UI가 없는 child에서는 `ctx.ui.setTitle()`을 호출하지 않는 현재 fail-soft 조건을 유지한다.

### 5.4 `src/runtime/pane-launch-broker.mjs`

- `tmux-new-window`의 hard-coded `-n subagent:broker`를 canonical base label로 교체한다.
- broker가 base label을 받는다면 strict intent validation과 command environment/artifact boundary를 함께 갱신한다. task/prompt/secret env를 broker argv, minimal command environment, status/error evidence에 새로 넣지 않는다.
- returned `sessionId`, `windowId`, `paneId`, `panePid` validation과 allocation-first publish 순서는 바꾸지 않는다. 이름 실패 또는 rename race가 exact target cleanup 판단을 바꾸면 안 된다.

### 5.5 `src/runtime/tmux.ts`

- `buildTmuxDiagnosticTitle()`을 canonical helper로 대체하거나 wrapper로 남겨 direct adapter와 broker가 같은 output을 만들게 한다.
- `buildTmuxNewWindowArgs()`의 `-n`에도 동일 helper를 사용한다.
- pane inspection은 계속 `pane_id`, `pane_dead`, `pane_title`, `pane_pid`를 읽는다. window name을 pane fingerprint, close target 또는 absence 판단에 사용하지 않는다.

### 5.6 `index.ts`

- `/subagents details`는 raw observed tmux title/window name을 출력하지 않는다.
- 필요하면 현재 `managedTitle` 레이블을 “expected managed pane title base”로 명확히 하고, `titleState`가 suffix-aware comparison임을 설명한다.
- 별도 LLM tool schema나 title-management command를 추가하지 않는다.

## 6. lifecycle authority 분리 (제안)

| 책임 | authority | 이름과의 관계 |
|---|---|---|
| tmux allocation | broker + exact returned fingerprint | `-n`은 diagnostic input일 뿐 |
| child completion/lease | `src/runtime/child-bridge.ts` + durable sidecars | dynamic pane title은 hint일 뿐 |
| close/interrupt/reaper | committed allocation의 socket/server/pane/pane-PID fingerprint | title/window name을 lookup key로 사용 금지 |
| user diagnostic | runner active registry와 `/subagents` | sanitized expected form만 표시 |

특히 user가 tmux window나 pane title을 바꿔도 cleanup은 기존 exact fingerprint로 계속 판단한다. 반대로 title 관측 실패, title mismatch, automatic rename 실패는 completion failure나 retryable cleanup authority로 승격하지 않는다.

## 7. tmux automatic-rename 고려사항 (제안)

지원 tmux에서 `new-window -n <base-label>`은 명시적으로 이름을 지정한 새 window의 `automatic-rename`을 비활성화하는 경로로 사용한다. 별도 `set-option automatic-rename off` mutation은 추가하지 않는다. allocation publication 전에 mutation 단계를 늘리지 않고, 사용자의 전역·session option도 변경하지 않기 위해서다.

구현과 gated live test에서는 `new-window -n` 직후 returned exact `windowId`의 이름과 per-window `automatic-rename` 상태를 읽기 전용으로 확인한다. 지원 버전에서 이 전제가 성립하지 않으면 allocation-first 안전성을 보존하는 별도 설계를 다시 검토하며, 이름 안정화를 이유로 broad window search나 name-based rediscovery를 추가하지 않는다.

user가 이후 이름을 바꾸면 runner/bridge가 원래 window label을 복구하지 않는다. 이름 변경은 navigation label의 user override이며, pane/Pi title 관측 mismatch도 lifecycle 또는 cleanup error로 승격하지 않는다.

## 8. 테스트 계획 (제안)

테스트 추가는 이 설계의 완료 증거가 아니다. 아래 범위가 구현과 함께 필요하다.

### 8.1 unit

- `test/runtime/tmux.test.ts`
  - ASCII/공백/Unicode/control/escape/긴 agent/run 입력의 canonical base label
  - `buildTmuxNewWindowArgs()`가 label을 정확히 하나의 `-n` argv로 전달하고 task-like 문자열을 포함하지 않음
  - canonical session/window fingerprint parsing은 label과 독립적임
  - 가장 긴 lifecycle suffix에서도 전체 run prefix와 96자 bound가 함께 보존됨
- `test/runtime/child-bridge.test.ts`
  - canonical base label만 acceptance
  - `ready → running → waiting → returning/failed` suffix와 96자 bound
  - UI 부재 및 invalid title은 fail-soft
- `test/runtime/runner-interactive.test.ts`
  - active registry의 expected base title과 suffix-aware `matching|changed|unavailable`
  - raw title을 UX snapshot에 저장/출력하지 않는 경계
- `test/runtime/runner-auth.test.ts`
  - private child environment에 sanitized label만 존재하고 task/secret/control sequence가 포함되지 않음

### 8.2 broker/runtime integration

`test/runtime/pane-launch-broker.test.ts` 및 관련 protocol test에서 다음을 검증한다.

- `tmux-new-window` intent에서 broker가 agent/run-derived label만 사용한다.
- V2/V3 intent parser와 digest binding이 canonical `windowLabel`을 포함하고 label-less current production intent를 거부한다.
- `new-window -n` 뒤 exact returned `windowId`의 label/automatic-rename 관측은 allocation-first record, commit/cancel, staged gate, exact pane rollback semantics를 바꾸지 않는다.
- label/window rename은 source pane, unrelated window, completion sidecar, reaper target에 영향을 주지 않는다.

### 8.3 gated live tmux

기존 isolated tmux acceptance harness를 확장할 때만 실제 tmux mutation을 수행한다. 최소 시나리오는 다음과 같다.

1. `auto` top-level child 둘 이상이 서로 다른 stable window label을 가진다.
2. 각 child의 pane title은 lifecycle state로 변하고, window label은 변하지 않는다.
3. parent/source/sentinel window의 이름과 pane fingerprint는 보존된다.
4. child window의 user rename 및 automatic-rename option 상태를 각각 관측해, lifecycle/cleanup이 이름에 의존하지 않음을 확인한다.
5. complete, cancel, parent shutdown/reaper 뒤 exact child pane/window만 사라지고 source/sentinel은 남는다.

실행 전에는 `bun run acceptance:dry-run`으로 gate를 확인한다. 실제 live execution은 명시적 opt-in 환경 gate가 있는 기존 acceptance command를 사용해야 하며, 이 문서는 live PASS를 주장하지 않는다.

## 9. rollout (제안)

1. **helper와 unit test:** canonical base label 및 suffix-aware inspection을 추가하되 broker label은 아직 기존값으로 유지한다.
2. **broker wiring:** strict validation과 broker fixture/integration coverage를 추가해 `tmux-new-window -n`을 base label로 전환한다.
3. **gated live verification:** isolated tmux server에서 `new-window -n`의 이름 및 per-window `automatic-rename` 상태와 cleanup/source preservation을 확인한다.
4. **documentation update:** 검증된 현재 동작만 `README.md`, `docs/interactive-pane-layout-design.md`, `docs/cmux-pi-tui-design.md`, `docs/pi-cmux-integration.md` 중 canonical 위치에 반영한다. 이 단계 전에는 완료/PASS 표현을 추가하지 않는다.

각 단계는 failure 시 기존 title/window naming을 silent fallback으로 바꾸지 않는다. title은 UX이므로 allocation safety를 희생해 강제하지 않으며, mutation uncertainty는 exact target recovery 규칙을 따른다.

## 10. 기각한 대안

### window 이름에 lifecycle suffix를 계속 갱신

tmux navigation label이 흔들리고, bridge/parent/broker가 여러 writer가 된다. dynamic 상태는 pane/Pi title만 담당하는 편이 명확하다.

### task 또는 prompt 요약을 window 이름에 포함

terminal scrollback, tmux status, process diagnostics에 민감한 텍스트가 노출될 수 있다. privacy와 output-injection 표면이 커지므로 기각한다.

### window 이름을 cleanup/rediscovery key로 사용

이름은 user/automatic rename으로 바뀔 수 있고 unique/stable authority가 아니다. tmux pane ID와 server/pane PID fingerprint를 대체할 수 없다.

### 별도 `automatic-rename off` mutation

전역 option은 사용자의 다른 window 설정을 바꾸고, per-window command도 allocation publication 전 mutation 구간을 늘리므로 모두 기각한다. 지원 tmux의 `new-window -n` 동작을 gated live test로 확인한다.

### pane title을 매 poll마다 parent runner가 강제 복구

user override를 방해하고 title I/O를 lifecycle authority처럼 만들며 race를 증가시킨다. bridge의 event-driven best-effort update만 사용한다.

## 11. 관련 현재 파일

- `src/runtime/runner.ts` — child 환경, wrapper OSC title, active-run expected title과 inspection
- `src/runtime/run-protocol.ts`, `src/runtime/tmux-control-protocol.ts` — strict V2/V3 intent field, parser와 digest binding
- `src/runtime/child-bridge.ts` — Pi lifecycle title suffix writer
- `src/runtime/pane-launch-broker.mjs` — production `tmux new-window` allocation과 fixed `subagent:broker` label
- `src/runtime/tmux.ts` — diagnostic title helper, new-window argv, pane inspection/fingerprint
- `index.ts` — `/subagents` details UX와 raw title 비노출 경계
- `test/runtime/tmux.test.ts`, `test/runtime/child-bridge.test.ts`, `test/runtime/runner-interactive.test.ts`, `test/runtime/runner-auth.test.ts`, `test/runtime/pane-launch-broker.test.ts` — 제안 테스트 위치
