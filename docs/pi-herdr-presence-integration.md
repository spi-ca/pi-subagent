# `pi-subagent`와 `pi-herdr-presence` 연동 상태와 후속 개발

> **상태:** `pi-subagent`의 backend-neutral presence producer와 Herdr child metadata 경로는 구현되어 있다. 핵심 기능은 거의 완성 단계지만, 실제 `pi-herdr-presence` consumer와의 교차·live 검증이 끝나기 전에는 연동 전체를 릴리스 완료로 판정하지 않는다.

이 문서는 **현재 `pi-subagent` 저장소 관점**에서 Herdr presence 연동의 구현 범위, 남은 개발과 검증 책임을 기록한다. consumer 구현 세부사항이나 cmux UX를 `pi-subagent`에 복제하지 않는다. generic wire 계약은 [`pi-cmux-presence` presence 연동 문서](./pi-cmux-presence-integration.md)를 따른다. 문서 이름에 cmux가 포함되어 있지만, 그 문서의 `pi-presence:update:v1`·`remove:v1`·`ready:v1`·선택 `summary:v1` producer 계약은 backend-neutral하다.

## 1. 완성도 판단

현재 구현은 다음 핵심 경계를 갖춘 상태다.

- root parent만 process-local generic presence producer를 만든다.
- active, queued, completed, failed, cancelled와 structured progress를 bounded snapshot으로 투영한다.
- update/remove와 선택 summary가 generation/sequence fence를 공유하고, ready는 같은 session 범위에서 discovery와 replay를 조정한다.
- stale replay와 remove 뒤 summary 재등장을 차단한다.
- observer 실패가 실행, 결과 수집, 취소, lease, reaper 또는 cleanup을 변경하지 않는다.
- Herdr child pane metadata는 generic parent presence와 별도 진단 채널로 유지한다.
- task, prompt, output, error 원문, path, socket과 private target ID를 generic presence에 넣지 않는다.
- Herdr 지원 때문에 공개 `subagent` 입력 schema를 변경하지 않는다.

따라서 남은 작업은 새로운 실행 기능보다는 **실제 consumer 호환성, source 공존·cleanup, load-order와 shutdown 검증**에 집중된다. 퍼센트 수치로 완료도를 고정하지 않으며, 아래 필수 검증이 통과하기 전에는 “통합 완료”나 “live 검증 완료”를 주장하지 않는다.

## 2. 현재 `pi-subagent` 소유 구현

### Generic parent presence

`src/integration/pi-presence-producer.ts`가 다음 process-local event를 생산한다.

| Event | 역할 |
| --- | --- |
| `pi-presence:update:v1` | 현재 subagent aggregate snapshot |
| `pi-presence:remove:v1` | retained observer state 철회 |
| `pi-presence:ready:v1` | load-order 독립 discovery, capability advertisement와 replay 요청 |
| `pi-presence:summary:v1` | non-cmux capability-gated bounded active/waiting/terminal companion |

이 채널은 cmux 또는 Herdr socket을 직접 호출하지 않는다. `pi-herdr-presence`는 package dependency 없이 같은 Pi process에서 이를 선택적으로 소비할 수 있다. fixed V1 `pi-cmux-presence`는 `summary:v1`을 소비·광고하지 않으므로, producer는 그 exact consumer ID의 `presence-summary-v1` capability 주장으로 summary를 활성화하지 않는다; 다른 capable consumer의 선택 summary 지원은 유지한다.

### 개별 Herdr child pane metadata

`src/runtime/herdr.ts`와 `src/runtime/child-bridge.ts`는 개별 Herdr child pane에 source-scoped 진단 metadata를 보고한다.

- source: `pi-subagent:<runId>`
- lifecycle: `ready`, `running`, `waiting`, `returning`, `failed`
- bounded latest-write-wins reporting
- TTL과 source-scoped clear
- pane identity/rebinding 검증

이 경로는 child pane의 presentation을 위한 것이며 Herdr agent lifecycle authority를 만들거나 release하지 않는다. 개별 child binding을 아는 `pi-subagent`가 계속 소유하고, parent aggregate consumer로 이전하지 않는다.

## 3. `pi-subagent`에 남은 필수 작업

### 3.1 실제 producer-consumer 교차 smoke

현재 producer 단위 테스트만으로는 sibling `pi-herdr-presence` parser와 runtime이 동일 wire contract를 실제로 수락하는지 증명할 수 없다. package dependency를 추가하지 않는 별도 opt-in acceptance를 마련해 다음 순서를 확인한다.

1. consumer advertisement와 consumer-less ready request
2. producer-first와 consumer-first load order
3. update 뒤 같은 `(generation, sequence)`의 summary
4. newer update가 이전 summary를 대체하는 동작
5. remove tombstone 뒤 stale update/summary 거부
6. generation 전환 뒤 이전 baseline 폐기
7. parent settlement와 background terminal burst의 순서
8. producer stop, consumer shutdown과 session reload의 state 철회

acceptance는 provider 호출이나 실제 subagent task 실행 없이 synthetic Pi lifecycle/event bus를 사용할 수 있다. 다만 “live Herdr 검증”을 주장하려면 별도 gate 아래 실제 sibling consumer entrypoint와 Herdr socket/UI 결과를 확인해야 한다. sibling checkout을 동적 import한다면 기존 cmux presence acceptance와 동등한 명시적 trust gate, canonical path 검증, timeout, 출력 cap과 cleanup 증거가 필요하다.

### 3.2 Parent/child metadata source 공존 검증

실제 Herdr 조합에서 다음 source가 동시에 존재할 수 있다.

- parent/local presence authority: `herdr:pi`
- child diagnostics: `pi-subagent:<runId>`

`pi-subagent` 측 교차 검증은 다음을 증명해야 한다.

- child clear가 다른 run 또는 parent metadata를 제거하지 않는다.
- child `applies_to_source`가 lifecycle authority를 획득하거나 release하지 않는다.
- TTL expiry와 명시적 clear가 중복되어도 다른 source에 영향이 없다.
- user pane 이동/rebinding 뒤 stale pane에 metadata를 쓰지 않는다.
- producer/session teardown과 child reporter close 순서가 달라도 source-scoped cleanup이 유지된다.

이 검증 때문에 generic presence DTO에 pane ID, socket path 또는 Herdr target을 추가하지 않는다.

### 3.3 계약 fixture drift 방지

producer와 consumer가 package dependency 없이 strict parser를 각각 소유하므로 contract drift를 조기에 잡아야 한다. 다음 중 하나를 선택한다.

- 저장소별 canonical fixture를 byte/shape 수준으로 교차 검증
- opt-in acceptance에서 실제 producer와 consumer parser를 함께 로드

공유 runtime package를 새로 도입하는 것은 별도 dependency·release 설계가 필요한 범위이므로 기본 후속안으로 삼지 않는다. fixture에는 task, output, credential, path, socket 또는 private pane target을 넣지 않는다.

### 3.4 검증 결과의 문서화

교차 smoke가 추가되면 이 문서에 다음을 구분해 기록한다.

- deterministic unit/fake event-bus 검증
- 실제 sibling consumer load 검증
- 실제 Pi loader 검증
- 실제 Herdr socket/UI 검증

한 단계의 통과를 다른 단계의 증거로 확대 해석하지 않는다. live 실행 날짜, 환경, gate와 cleanup 결과가 저장소에 재현 가능한 증거로 남지 않으면 현재 worktree의 PASS로 주장하지 않는다.

## 4. `pi-herdr-presence`가 소유할 후속 UX

아래 항목은 연동 완성도를 높이지만 `pi-subagent` 구현 책임은 아니다. 현재 generic event로 구현할 수 있으므로 producer나 tool schema를 확장하지 않는다.

- completed/failed delta를 사용한 bounded subagent 전용 terminal 알림
- parent가 idle이고 subagent만 동작할 때 `Subagents are working/queued/stopping`처럼 실제 주체를 나타내는 문구
- 기존 summary를 사용한 Herdr metadata title 개선
- parent active/idle과 terminal burst를 함께 고려하는 consumer-side 알림 정책
- 선택적인 read-only focus 확인을 통한 중복 성공 알림 억제

consumer는 agent 이름, invocation ID, task 또는 raw error를 Herdr notification text로 복사하지 않아야 한다. focus-aware 정책을 구현하더라도 polling이나 lifecycle authority로 확대하지 않는다.

## 5. 현재 범위에서 보류하는 기능

### Actionable child pane navigation

실패 알림에서 해당 child pane으로 직접 이동하려면 current pane binding과 invocation/run identity를 연결하는 새 계약이 필요하다. 현재 summary는 의도적으로 Herdr target을 전달하지 않는다. generic DTO에 target을 추가하거나 `pi-herdr-presence`에 실행 authority를 주지 않는다. 필요성이 확인되면 opaque navigation handle 또는 별도 Herdr 전용 observer event의 privacy, rebinding, expiry와 authorization을 별도 설계한다.

### Presence consumer의 취소 권한

presence update/remove/summary는 observer event다. consumer가 subagent 취소, pane close, reaping, result settlement 또는 ownership 변경을 수행해서는 안 된다. 이 권한은 계속 `subagent` tool action, `/subagents`와 `pi-subagent` lifecycle/control 경로가 소유한다.

## 6. 계약 변경 판단

### 공개 `subagent` tool call

변경하지 않는다. `presence`, `herdr`, `paneId`, `notify`, `metadata` 또는 consumer 선택 필드를 추가하지 않는다.

### Generic presence contract

위 필수 교차 검증과 consumer UX에는 새 필드가 필요하지 않다. 현재 선택 `pi-presence:summary:v1`을 확정할 때는 producer와 모든 해당 consumer의 parser, fixture와 문서를 함께 동기화해야 한다. 새 상태, parent-consumption 의미, navigation target을 추가하는 경우에만 새 버전 또는 capability 계약을 별도로 검토한다.

### Herdr protocol 사용

`pi-subagent`의 현재 child metadata 경로는 별도 내부 presentation channel이다. consumer가 focus-aware 알림을 선택하면 `pi-herdr-presence`가 read-only Herdr method를 추가로 allowlist할 수 있지만 `pi-subagent` tool 또는 generic presence 계약 변경은 필요하지 않다.

## 7. 완료 기준

다음 조건을 모두 충족해야 `pi-subagent` 관점의 Herdr presence 연동을 통합 완료로 판단한다.

- 기존 focused producer tests와 `bun run ci` 통과
- 실제 sibling consumer와 update/summary/remove/load-order 교차 smoke 통과
- parent/child metadata source 공존과 source-scoped cleanup 검증 통과
- malformed/stale/replayed payload가 lifecycle authority에 영향을 주지 않음
- provider/task/output/credential 없이도 deterministic acceptance를 재실행할 수 있음
- 실제 Herdr UI까지 주장할 경우 명시적으로 gated live evidence와 cleanup 증거가 있음
- 공개 `subagent` 입력 계약과 실행·취소·cleanup ownership이 변경되지 않음

현재 다른 세션이 이 저장소 구현을 동시에 진행 중일 수 있으므로, 검증과 상태 갱신 전에 최신 `git status`, 관련 diff와 실제 테스트 출력을 다시 확인한다. 이 문서의 상태 문구는 테스트 실행 증거를 대신하지 않는다.

## 8. 현재 검증 진입점

```bash
bun test test/integration/pi-presence-producer.test.ts
bun test test/runtime/herdr.test.ts
bun run ci
```

현재 package script에는 Herdr presence sibling acceptance가 별도로 정의되어 있지 않다. 후속 acceptance를 구현하기 전에는 존재하지 않는 명령이나 live PASS를 문서에 추가하지 않는다.

관련 코드와 문서:

- `src/integration/pi-presence-producer.ts`
- `src/runtime/herdr.ts`
- `src/runtime/child-bridge.ts`
- `test/integration/pi-presence-producer.test.ts`
- `test/runtime/herdr.test.ts`
- [`generic presence producer 계약`](./pi-cmux-presence-integration.md)
- [`Herdr 설정과 권한 경계`](./configuration.md#herdr-권한과-진단)
- [`사용 가이드`](./usage.md)
