# 사용자 steer 대기 시 foreground subagent의 자동 background 전환 제안

> **상태:** 제안 — 미구현. 이 문서는 후속 작업의 설계와 구현 계획을 기록한다. 현재 runtime에는 steer 입력을 감지해 실행 중인 foreground invocation을 background로 전환하는 경로가 없다. 현재 foreground 호출은 완료까지 blocking하고, 명시적 `background: true` 호출만 즉시 반환한다. 아래에서 별도로 “현재 동작”이라고 표시한 부분을 제외한 정책·API·테스트는 아직 구현되었다고 주장하지 않는다.

## 1. 목표

사용자가 foreground subagent를 기다리다가 새 steering 메시지를 제출하면, 안전한 경우 실행 중인 child를 중단하거나 다시 시작하지 않고 해당 invocation을 background job으로 전환한다. 전환된 tool call은 job ID를 반환하고, 부모 agent는 queue된 사용자 steer를 처리하며, child의 최종 결과는 기존 background 완료 경로로 전달한다.

이 기능은 사용자가 새 steer를 보내지 않는 기존 foreground 호출의 blocking 의미와 명시적 background 호출의 완료 전달 의미를 유지해야 한다.

## 2. 현재 동작과 유지할 계약

현재 동작은 다음과 같다.

- foreground 호출은 child가 끝날 때까지 tool execution을 resolve하지 않는다. 부모 agent는 같은 turn에서 최종 결과를 처리한다.
- `background: true` 호출은 job ID를 즉시 반환하고, 완료 결과를 `deliverAs: "steer"`, `triggerTurn: true`로 부모에게 자동 전달한다.
- Pi는 agent가 실행 중일 때 일반 제출을 steer로, follow-up 제출을 별도 follow-up queue로 보낸다. steer는 현재 assistant turn의 tool call이 끝난 뒤 전달된다.
- `/subagents promote <run-id>`는 interactive surface의 durable ownership을 사용자에게 넘기는 별도 기능이다. 이 문서의 실행 모드 전환과 관계없으며 변경하지 않는다.

제안 기능을 구현해도 다음은 그대로 유지한다.

- steer가 없으면 foreground 결과·취소·usage·시간 순서는 현재와 같아야 한다.
- 명시적 `background: true`의 public tool schema, status/cancel, 결과 truncation, untrusted wrapping과 자동 steer를 변경하지 않는다.
- `SubagentParams`, JSON Schema, dashboard/presence protocol version, limit 기본값과 dependency를 변경하지 않는다.

## 3. 선택한 정책

### 3.1 전환 trigger

다음 조건을 모두 만족하는 입력에서만 전환을 한 번 시도한다.

- 실제 사용자 입력의 source가 `interactive`이거나, RPC `prompt` 요청이 `source: "rpc"`와 `streamingBehavior: "steer"`로 input event에 도달한다.
- `streamingBehavior === "steer"`다.
- 현재 session과 parent tool batch에 전환 가능한 foreground `subagent` invocation이 있다.
- invocation과 session이 settling, cancelling, shutdown 또는 reload 단계가 아니다.

input handler는 성공·실패와 관계없이 `{ action: "continue" }`를 반환해 원래 사용자 메시지와 Pi queue 의미를 보존한다.

다음 입력과 실행은 trigger에서 제외한다.

- `followUp`
- idle 상태의 일반 입력
- `source: "extension"`인 extension 주입 메시지
- explicit background job의 완료 steer
- `action: "status" | "cancel"` 호출
- 완료·실패·취소가 이미 확정된 invocation
- input event를 거치지 않는 extension/built-in command

Pi가 skill/template 입력을 input event 이후 확장하는 현재 순서는 구현 전에 지원하는 전체 Pi version 범위에서 다시 검증한다. 이 설계의 직접 확인 기준은 Pi 0.82.1이며, package의 전체 peer 범위에서 검증됐다고 아직 주장하지 않는다.

Pi RPC protocol의 전용 `steer` command는 `session.steer()`로 직접 queue되며 extension input event를 거치지 않는다. Pi core를 수정하지 않는 이 설계는 **RPC `prompt` + `streamingBehavior: "steer"` 경로만** trigger로 지원한다. 전용 RPC `steer`까지 같은 기능을 제공하려면 해당 queue admission을 관찰·intercept하는 공식 extension hook이 먼저 필요하다.

### 3.2 all-or-none 전환

한 parent tool batch에 foreground `subagent` 호출이 여러 개 있으면 전환 가능한 호출 전체를 하나의 batch로 취급한다. background slot과 tree permit transition을 모두 확보할 수 있을 때만 전부 전환한다. 일부만 background로 바꾸는 partial promotion은 허용하지 않는다.

같은 turn의 다른 extension 또는 built-in blocking tool은 이 기능이 resolve할 수 없다. 그런 tool이 남아 있으면 subagent 전환이 성공해도 사용자 steer 전달은 해당 tool이 끝날 때까지 지연될 수 있다.

### 3.3 capacity 부족 정책

다음 조건 중 하나라도 충족되면 전환하지 않고 모든 invocation을 foreground로 유지한다.

- 필요한 `maxBackgroundJobs` slot이 부족하다.
- parent를 다시 `ACTIVE`로 만들 tree-wide `maxActive` capacity가 부족하다.
- transition snapshot 이후 invocation 하나라도 settle 또는 cancel을 시작한다.
- session fence, permit authority 또는 ownership 상태를 안전하게 증명할 수 없다.

실패한 전환은 capacity를 기다리거나 자동 재시도하지 않는다. child를 abort·restart·detach하지 않고 기존 foreground 실행을 계속한다. 원래 사용자 steer는 Pi queue에 남아 foreground tool batch 완료 뒤 처리된다. 이후 사용자가 보내는 별도 steer는 당시 상태로 새로운 전환을 시도할 수 있다.

## 4. 왜 permit transition이 필요한가

Linux/macOS의 durable tree permit에서 foreground delegation은 parent lease를 `PARKED_WAIT`로 바꾸고 descendant가 capacity를 사용한다. background 실행은 parent와 child가 동시에 실행되므로 parent를 다시 `ACTIVE`로 만들 spare capacity가 필요하다.

따라서 전환은 기존 child lease를 제거하거나 새 child permit을 중복 취득하는 작업이 아니다. 하나의 durable CAS에서 다음을 만족해야 한다.

1. exact parent lease와 owner identity가 유효하다.
2. parent lease가 `PARKED_WAIT`다.
3. parent 활성화 뒤에도 `used <= maxActive`다.
4. parent lease만 `ACTIVE`로 바꾼다.
5. 이미 실행 중인 descendant lease는 그대로 유지한다.
6. 전환 이후 아직 시작되지 않은 parallel/chain 작업은 background authority에서 permit을 기다린다.

`maxActive`가 가득 찼으면 CAS는 상태를 변경하지 않고 실패한다. 특히 cap 1에서 child 하나가 실행 중이면 parent와 child를 동시에 활성화할 수 없으므로 전환하지 않는 것이 정상 동작이다. Windows의 process-local fallback도 같은 성공/실패 의미를 제공하되 durable authority가 있다고 주장하지 않는다.

shared foreground scope에 여러 invocation이 참여할 수 있으므로 scope manager는 현재 user 전체가 같은 all-or-none batch에 포함됐는지 검증해야 한다. 성공 후에는 기존 child settlement callback을 유지하면서 새 foreground delegation이 별도 scope를 만들 수 있도록 promoted scope를 정리해야 한다.

## 5. 제안 architecture

### 5.1 Foreground promotion coordinator

신규 `src/runtime/foreground-promotion.ts`가 session-fenced coordinator 역할을 맡는다.

- 활성 invocation을 `toolCallId`와 stable UX/job ID로 추적한다.
- background admission, promotion, settlement, cancellation과 shutdown을 하나의 transition mutex로 직렬화한다.
- explicit background 시작과 promotion이 `maxBackgroundJobs` slot을 경쟁할 때 같은 admission authority를 사용한다.
- durable permit commit 이전에는 staged job record와 slot을 rollback한다.
- durable commit 이후에는 partial rollback하지 않고 선택한 invocation 전체를 background 상태로 roll-forward한다.

제안 invocation 상태는 다음과 같다.

```text
foreground-running
  ├─ foreground-terminal
  ├─ cancelling → cancelled
  └─ promoting
       ├─ pre-commit failure → foreground-running
       └─ durable commit → background-running
                              ├─ completed
                              ├─ failed
                              └─ cancelled
```

### 5.2 Tool result와 child settlement 분리

현재 foreground path가 직접 `await runInvocation(...)`하는 구조를 다음 두 lifetime으로 분리한다.

- **tool-facing lifetime:** foreground 결과 또는 background 전환 acknowledgement 중 먼저 확정된 결과를 반환한다.
- **child lifetime:** 기존 scheduler handle, controller, fork source ownership, permit, interactive monitor와 pane cleanup을 실제 child settlement까지 유지한다.

개념적인 흐름은 다음과 같다.

```text
settlement = runInvocation(childSignal, ...)
acknowledgement = promotionGate

tool result = race(settlement, acknowledgement)
```

settlement가 먼저 linearize되면 기존 foreground 결과만 반환하고 background job을 만들지 않는다. promotion이 먼저 linearize되면 tool call은 stable job ID acknowledgement만 반환하고, 같은 `settlement` Promise를 background registry가 한 번만 finalize한다. Child를 새로 시작하지 않는다.

Promotion 이후에는 완료된 tool row에 late `onUpdate`를 보내지 않고 UX registry만 갱신한다. 원래 Pi tool signal의 abort forwarding도 해제해 부모 turn 취소가 전환된 child를 중단하지 않게 한다. 이후 취소 권한은 background job controller와 기존 status/cancel 경로가 가진다.

### 5.3 Existing background settlement adoption

Background helper는 “새 실행 시작”과 “이미 실행 중인 settlement 추적”을 분리한다. Promoted job은 기존 background 경로의 다음 기능을 재사용한다.

- session-generation fence
- status/cancel과 history pruning
- 결과 truncation과 untrusted output wrapping
- 완료·실패·취소 finalization
- `deliverAs: "steer"`, `triggerTurn: true` 완료 전달
- shutdown abort와 bounded settlement

Job ID, controller, original `startedAt`, progress와 preview를 유지하고 내부 진단용 `promotedAt`과 origin만 추가할 수 있다. 공개 tool parameter와 wire protocol에는 새 field를 추가하지 않는다.

### 5.4 UX와 dashboard 연속성

`SubagentUxRegistry`는 동일 ID의 실행 중 record를 `foreground`에서 `background`로 원자적으로 바꾸는 transition을 제공해야 한다. 시작 시각, 진행률, preview와 cancellation authority는 유지한다.

전환 자체는 terminal event가 아니다.

- aggregate completion을 발행하지 않는다.
- detached-surface event를 발행하지 않는다.
- presence attention을 완료로 바꾸지 않는다.
- 최종 settlement에서만 `kind: background` completion을 한 번 발행한다.

성공 시 TUI/RPC에 짧은 정보 알림을 표시할 수 있다. Capacity 또는 race 때문에 실패하면 child/task/path/raw error를 포함하지 않는 일반 warning만 표시하고, 활성 foreground가 없는 입력에는 알림을 만들지 않는다.

## 6. 입력 admission과 결과 순서

Pi input hook은 사용자 steer가 실제 queue에 삽입되기 전에 실행된다. Promotion acknowledgement가 input handler 안에서 즉시 foreground tool을 resolve하면, parent가 아직 비어 있는 steering queue를 보고 일반 continuation request를 시작할 수 있다. 매우 빠른 child가 끝나면 background completion steer까지 trigger 사용자 steer보다 먼저 queue될 수 있다.

따라서 구현에는 두 개의 순서 barrier가 필요하다.

1. **Queue-admission barrier:** permit과 background admission을 commit한 뒤에도 원래 foreground tool의 promotion gate를 바로 resolve하지 않는다. Input handler가 반환되고 해당 exact 사용자 steer가 queue에 들어갔음이 확인된 뒤 acknowledgement를 resolve한다. 그러면 첫 post-promotion assistant request가 원래 steer를 포함해야 한다.
2. **Completion-publication barrier:** promotion 직후 terminal settlement가 발생하면 background completion을 buffer하고, trigger 사용자 steer admission 이후에만 기존 background steer를 publish한다.

Timer, microtask 순서 또는 단순 `hasPendingMessages()` boolean을 exact admission authority로 사용하지 않는다. 다른 pending message와 trigger steer를 구분하지 못하기 때문이다.

지원 Pi version의 extension API에서 해당 exact post-enqueue barrier를 증명할 수 없다면 구현 blocker로 보고한다. 이 경우 “Pi core 수정 없음” 비목표를 유지하는 동안 기능을 완료한 것으로 간주하지 않으며, 일반 continuation이 먼저 나갈 수 있는 best-effort 동작으로 조용히 축소하지 않는다.

## 7. Cancellation, shutdown과 accounting

Race의 linearization 규칙은 다음과 같다.

- settlement가 먼저 확정되면 정상 foreground 결과를 반환한다.
- cancellation이 먼저 확정되면 promotion은 실패하고 기존 취소 결과를 따른다.
- promotion commit이 먼저면 이후 cancel을 background cancel로 처리한다.
- shutdown/reload가 먼저 fence를 닫으면 promotion은 아무 상태도 바꾸지 않는다.
- promotion이 먼저 commit되면 session shutdown은 기존 background 순서로 취소·drain하고 late steer를 session fence로 차단한다.

Foreground로 끝난 결과의 usage accounting은 현재 계약을 유지한다. Promoted tool result는 child보다 먼저 확정되므로 나중에 최종 usage를 그 tool result에 추가할 수 없다. 이 설계에서는 promoted invocation을 기존 background accounting과 같게 취급하며 canonical parent total에 부분·중복 usage를 추가하지 않는다. Background usage accounting 자체를 변경하는 일은 별도 범위다.

## 8. 구현 단계

### Phase 1 — coordinator와 settlement adoption

- foreground invocation registry와 state machine을 추가한다.
- tool-facing lifetime과 child settlement를 분리한다.
- 실행 중 Promise를 background registry가 인수하는 helper를 추가한다.
- explicit background와 promotion의 slot admission을 직렬화한다.

### Phase 2 — durable permit transition

- spare capacity를 즉시 검사하는 parent resume CAS를 추가한다.
- foreground scope의 promoted 상태와 child callback ownership을 정의한다.
- pending parallel/chain 예약이 background authority로 전환되는 mutable permit route를 추가한다.
- shared scope의 all-user, nested delegation과 Windows fallback을 검증한다.

### Phase 3 — input wiring과 ordering barrier

- `interactive` 및 RPC `prompt` 경로의 user steer만 감지하는 input handler를 추가한다.
- all-or-none `tryTransitionAll()`을 연결한다.
- exact trigger steer의 queue admission 뒤 promotion acknowledgement를 resolve하는 barrier를 구현한다.
- trigger user steer admission 뒤에만 completion steer를 허용하는 publication barrier를 구현한다.
- rapid multiple input을 transition mutex로 직렬화한다.

### Phase 4 — UX와 lifecycle 통합

- UX kind transition과 dashboard/presence 연속성을 구현한다.
- cancel, shutdown, reload, fork ownership을 coordinator에 연결한다.
- inline/cmux/tmux child가 전환 중 abort·restart·detach되지 않음을 검증한다.

### Phase 5 — acceptance와 문서 전환

- deterministic RPC acceptance harness를 추가한다.
- fake interactive adapter로 PID/target continuity와 exact cleanup을 검증한다.
- gated cmux/tmux live acceptance를 별도로 수행한다.
- 구현과 검증이 완료된 뒤에만 이 문서의 상태 및 사용자 가이드를 현재 동작으로 갱신한다.

## 9. 검증 계획

최소 정적/결정론적 검증 범위는 다음과 같다.

- steer가 없는 foreground와 explicit background의 기존 결과·취소·usage 회귀
- `interactive` 및 RPC `prompt`의 steer trigger와 follow-up/idle/extension/command 및 전용 RPC `steer` 제외
- single, parallel, chain 및 spawn/fork
- 같은 tool batch의 복수 foreground invocation all-or-none transition
- background slot exact-fit, 부족, 0, cancelling job 포함 계산
- tree permit spare-capacity 성공과 cap 부족 시 무변경 실패
- `maxActive=1`, nested parked parent와 active grandchild
- pending reservation route 전환
- settlement/promotion/cancel/shutdown/reload/repeated-steer race
- 실패 뒤 자동 재시도 없음과 이후 별도 steer의 fresh attempt
- child PID, scheduler handle, permit과 cmux/tmux target의 무중복·무재시작
- exact trigger steer가 첫 post-promotion assistant request에 포함됨
- acknowledgement 1회, final completion steer 1회, stale-session suppression
- status/cancel, truncation, untrusted wrapping과 history pruning
- promotion 후 late tool `onUpdate` 억제
- dashboard/presence가 같은 ID와 progress를 연속해서 유지

기본 완료 gate는 `bun run ci`다. 실제 cmux/tmux/provider acceptance는 명시적 gate 아래 별도로 실행하고, 실행하지 않았다면 통과했다고 주장하지 않는다. Source-bound performance fixture는 이 문서만 추가한 시점에는 재생성·검증된 것으로 주장하지 않는다.

## 10. 완료 기준

다음을 모두 만족해야 구현 완료로 판정한다.

- steer가 없을 때 현재 foreground 동작이 바뀌지 않는다.
- 충분한 slot과 permit이 있으면 선택된 invocation 전체가 한 번에 background로 전환된다.
- 전환 성공 시 child가 중단·재시작되지 않고 원래 steer가 부모에게 전달된다.
- 최종 결과는 기존 background status/history/steer 경로로 정확히 한 번 전달된다.
- slot/permit 부족 또는 race 실패는 partial state, child stop, 자동 재시도와 사용자 입력 유실을 만들지 않는다.
- follow-up과 extension 주입 입력은 전환하지 않는다.
- public tool schema, config key, protocol version, dependency와 limit 기본값이 바뀌지 않는다.
- single/parallel/chain, spawn/fork, nested permit, TUI/RPC `prompt`, cancellation과 session lifecycle 테스트가 통과한다.
- exact trigger 사용자 steer가 promotion acknowledgement 이후 첫 assistant request에 포함되고, 빠른 completion steer보다 먼저 처리된다.
- `bun run ci`가 통과하고, gated live 검증은 실제 실행 여부와 결과를 별도로 보고한다.

## 11. 비목표

- foreground 또는 explicit background의 기본 선택 정책 변경
- background 완료를 notify/next-turn 방식으로 변경
- Pi steering queue 또는 Pi core 수정
- extension input event를 거치지 않는 전용 RPC `steer` command 지원
- non-subagent blocking tool을 중단하거나 background로 전환
- `/subagents promote` interactive ownership transfer 변경
- capacity 부족 시 대기 또는 자동 재시도
- cross-session durable background history
- background usage accounting 확장
- `maxActive`, `maxBackgroundJobs` 기본값 변경
- OS process reparenting 또는 실행 중 pane ownership detach
