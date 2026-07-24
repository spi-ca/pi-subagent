# `pi-subagent`와 `pi-cmux-presence` presence 연동

> **현재 상태: generic presence producer 구현됨.** root `pi-subagent`는 process-local `pi.events`에 `pi-presence:update:v1`을 발행하고, `pi-cmux-presence`는 설치·로드되었을 때 이를 선택적으로 소비할 수 있다. 두 패키지 사이에는 package dependency, socket/CLI 호출, lifecycle authority 공유가 없다.

`pi-cmux-presence`는 별도 패키지이며, surface별 sidebar·log·사용자 command를 제공하는 [`pi-cmux`](./pi-cmux-integration.md)와도 다르다. 이 문서는 `pi-subagent`가 복제해 구현한 wire DTO와 producer 경계를 설명한다. presence consumer의 canonical 입력 계약은 `pi-cmux-presence` 저장소의 `docs/event-contract.md`가 소유한다.

## 1. 역할과 경계

| 구성 요소 | 역할 | 현재 경계 |
| --- | --- | --- |
| `pi-subagent` root parent | subagent 실행 상태를 generic presence update로 투영하는 producer | root depth `0` session에서만 발행한다. `pi-cmux-presence`를 import하거나 의존하지 않는다. |
| `pi-cmux-presence` | update를 검증해 cmux 상태 UI로 반영할 수 있는 선택 consumer | consumer/UI일 뿐이며 `pi-subagent` 실행에 필요하지 않다. |
| `pi-subagent` dashboard publisher | 기존 dashboard/aggregate/detached public event | presence와 별개 contract다. 자동 변환하지 않는다. |
| `pi-cmux` | 별도 surface UX extension | presence consumer의 소유자나 설치 조건이 아니다. |

`pi-subagent`가 presence를 생산할 때 cmux CLI를 실행하거나 cmux control socket을 열거나 mutate하지 않는다. `pi-cmux-presence`가 자체 Unix socket으로 UI를 갱신하더라도 observer 실패는 subagent 호출·결과·취소에 영향을 주지 않는다. interactive child surface의 allocation, completion, cancellation, lease, startup reaper 및 exact-target cleanup authority는 계속 `pi-subagent` lifecycle 구현에만 있다.

## 2. 채널과 root-session 동작

| 채널 | 방향 | 의미 |
| --- | --- | --- |
| `pi-presence:update:v1` | `pi-subagent` → 같은 Pi process의 선택 consumer | 현재 session의 subagent 집계 snapshot |
| `pi-presence:ready:v1` | 선택 consumer → `pi-subagent` | 현재 snapshot의 replay 요청 및 passive consumer advertisement |
| `pi-subagent:dashboard:v1` | `pi-subagent` → 외부 선택 consumer | 기존 active/dashboard contract |
| `pi-subagent:aggregate-completed:v1` | `pi-subagent` → 외부 선택 consumer | 기존 terminal invocation 알림 |
| `pi-subagent:detached:v1` | `pi-subagent` → 외부 선택 consumer | 기존 durable promotion 알림 |

presence producer는 root parent(depth `0`)의 `session_start`에서 session ID와 UX generation으로 시작하고 `session_shutdown`에서 listener를 해제한다. nested child는 producer를 만들지 않는다. 같은 session/generation의 마지막 update가 있을 때만, 동일 session ID의 valid `ready` 요청에 새 `sequence`를 붙여 replay한다. replay의 `attention`은 항상 `"none"`이며, 아직 snapshot이 없거나 session/generation이 다르면 아무 것도 발행하지 않는다.

`ready.consumer.id === "pi-cmux-presence"`이고 capabilities에 `"cmux-status"`가 있을 때의 감지는 한 session에 한 번인 passive UI-routing hint일 뿐이다. 실행 policy, child profile, completion 또는 cleanup 권한을 바꾸지 않는다.

## 3. 복제한 `v1` wire contract

`src/integration/pi-presence-producer.ts`는 `pi-cmux-presence` dependency 없이 `v1` update/ready parser와 DTO를 복제한다. producer source는 고정된 다음 값이다.

```json
{ "id": "pi-subagent", "label": "Subagents", "kind": "agent-group" }
```

`update`에는 `version`, `sessionId`, `generation`, 증가하는 `sequence`, `source`, `state`, `counts`가 필수다. 선택 필드는 `progress`, `usage`, `attention`이다. producer는 `idle`/`waiting`/`running`/`success`/`error`/`cancelled` state와 0–1,000,000 count, 1–96자 안전 문자열만 허용한다. unknown key, control/bidi 문자, 범위 밖 수치, 잘못된 source/ready shape는 거부한다.

현재 producer는 `usage`를 **발행하지 않는다**. token, cost, context percent를 계산·조회·추정하지 않는다. task, prompt, raw output, cwd/path, credential, raw title, socket/capability 또는 private cmux/tmux target ID도 payload에 넣지 않는다.

## 4. 집계와 진행률

`update`는 session-local UX snapshot과 scheduler/interactive count만 사용한다.

- `active`는 invocation의 `running`/`cancelling` 수와 scheduler active 수 중 큰 값에 active interactive run 수를 더한다. scheduler 작업을 이중 합산하지 않는다.
- `queued`는 scheduler queue 수다.
- `completed`/`failed`/`cancelled`는 session 안에서 처음 본 terminal invocation ID만 누적한다. UX recent history가 pruning되어도 계속 유지한다. ID 기억은 4,096개, 각 presence count는 1,000,000으로 상한을 둔다. ID 기억이 포화되면 재전송으로 과대계산하지 않도록 새 terminal count를 동결한다.
- active 또는 queued가 있으면 state는 `running`이다. 그렇지 않으면 가장 최근 terminal outcome에 따라 `success`/`error`/`cancelled`, terminal이 없으면 `idle`이다.
- 새 terminal update만 `completed → success`, `failed → error`, `cancelled → info` attention을 낸다. 그 밖의 정상 update와 모든 replay는 `none`이다.

progress는 추측한 작업량이 아니라 structured tool details와 invocation의 알려진 work count에서만 얻는다. 단일 호출은 active 동안 `0/1`을 내고 terminal update에서는 progress를 생략하며, 병렬 호출은 `details.results` 길이를 total로, `exitCode !== -1` result 수를 completed로 사용한다. 체인은 `chainStageCount`를 total로, `chainCompletedCount`·`chainSkippedCount`·`chainFailedCount`·`chainCompletedWithErrorsCount` 합계를 completed로 사용하며 total을 넘지 않게 제한한다. 여러 active invocation의 determinate progress는 합산해 `Subagents completed/total`로 표시한다.

## 5. 권한·child profile·기존 event의 분리

presence는 observer 출력이다. update/ready listener, consumer socket 또는 UI 오류는 모두 best-effort로 격리되며 invocation registry, `CompletionRecordV3`, result replay, cancellation, lease, reaper, detached ownership 또는 cleanup 결정을 만들지 않는다. consumer가 완료로 표시해도 결과 수집이나 target close 권한이 생기지 않는다.

`PI_SUBAGENT_CMUX_CHILD_POLICY=managed`는 inherited extension을 제외하므로 inherited `pi-cmux-presence`도 child에 로드하지 않는다. `inherit` child의 extension loading은 parent의 generic root producer를 복제하지 않으며, 별도 child presence policy나 `PI_CMUX_PRESENCE_*` 전달은 제공하지 않는다. presence는 JSON/CLI/environment 설정 항목이 아니며, `pi-subagent.json`이나 `subagent` tool schema를 확장하지 않는다.

기존 `pi-subagent:dashboard:v1`, `pi-subagent:aggregate-completed:v1`, `pi-subagent:detached:v1`은 계속 독립 contract다. dashboard/aggregate/detached를 presence update로 변환하지 않고, detached promotion을 terminal completion으로 취급하지 않는다. 이 채널은 동일한 dashboard publisher의 shared session/generation/sequence fence를 유지한다. presence는 producer-own session/generation/sequence fence를 사용한다.

## 6. 검증 범위

`pi-subagent`에서 다음 focused test는 strict update/ready parsing, session/generation fence, attention 없는 replay, passive consumer hint, pruning 뒤 terminal 누적과 observer failure 격리를 확인한다.

```bash
bun test test/integration/pi-presence-producer.test.ts
```

`bun run ci`는 type check와 전체 테스트를 실행한다. 이 focused/unit 범위와 baseline CI는 별도 `pi-cmux-presence` package의 소비 구현이나 live cmux E2E 조합을 증명하지 않는다.

관련 구현 근거:

- `index.ts` — root-only session wiring과 UX/scheduler observer 연결
- `src/integration/pi-presence-producer.ts` — duplicated `v1` DTO parser와 observer-only producer
- `test/integration/pi-presence-producer.test.ts` — focused contract test
- [`pi-cmux` 연동 가이드](./pi-cmux-integration.md) — optional `pi-cmux` UX와 legacy dashboard contract
