# `pi-subagent`와 `pi-cmux-presence` presence 연동

> **상태:** generic presence lifecycle producer 구현됨

root `pi-subagent`가 process-local `pi.events`에 `pi-presence:update:v1`과 `pi-presence:remove:v1`을 발행하고 `pi-presence:ready:v1`을 송수신하는 **producer**를 구현했다. `pi-cmux-presence`는 설치·로드되었을 때 이를 선택적으로 소비하는 별도 package다. 두 패키지 사이에는 package dependency, socket/CLI 호출, lifecycle authority 공유가 없다.

`pi-cmux-presence`는 surface별 sidebar·log·사용자 command를 제공하는 [`pi-cmux`](./pi-cmux-integration.md)와도 다르며, 두 optional package는 함께 설치·로드될 수 있다. `pi-cmux`는 generic presence event consumer가 아니고, 어느 package도 다른 쪽의 설치 조건, lifecycle authority 또는 내부 API가 아니다. 이 문서는 `pi-subagent`가 복제해 구현한 wire DTO와 producer 경계를 설명한다. presence consumer의 canonical 입력 계약은 별도 `pi-cmux-presence` 저장소의 `docs/event-contract.md`가 소유한다.

## 1. 역할과 경계

| 구성 요소 | 역할 | 현재 경계 |
| --- | --- | --- |
| `pi-subagent` root parent | subagent 실행 상태를 generic presence update/remove로 투영하는 producer | root depth `0` session에서만 발행한다. `pi-cmux-presence`를 import하거나 의존하지 않는다. |
| `pi-cmux-presence` | update/remove를 검증해 cmux retained 상태 UI에 반영·철회할 수 있는 선택 consumer | consumer/UI일 뿐이며 `pi-subagent` 실행에 필요하지 않고 `pi-cmux`와도 강결합하지 않는다. |
| `pi-subagent` dashboard publisher | 기존 dashboard/aggregate/detached public event | presence와 별개 contract다. 자동 변환하지 않는다. |
| `pi-cmux` | 별도 surface UX extension | presence consumer의 소유자나 설치 조건이 아니다. |

`pi-subagent`가 presence를 생산할 때 cmux CLI를 실행하거나 cmux control socket을 열거나 mutate하지 않는다. `pi-cmux-presence`가 자체 Unix socket으로 UI를 갱신하더라도 observer 실패는 subagent 호출·결과·취소에 영향을 주지 않는다. interactive child surface의 allocation, completion, cancellation, lease, startup reaper 및 exact-target cleanup authority는 계속 `pi-subagent` lifecycle 구현에만 있다.

## 2. 채널과 root-session 동작

| 채널 | 방향 | 의미 |
| --- | --- | --- |
| `pi-presence:update:v1` | `pi-subagent` → 같은 Pi process의 선택 consumer | 열린 현재 session의 subagent 집계 snapshot |
| `pi-presence:remove:v1` | `pi-subagent` → 같은 Pi process의 선택 consumer | source의 retained observer 상태 철회 |
| `pi-presence:ready:v1` | producer ↔ 선택 consumer | consumer-less replay 요청과 consumer advertisement/응답 |
| `pi-presence:summary:v1` | `pi-subagent` → `presence-summary-v1` capability를 광고한 **non-cmux** consumer | 선택적이고 제한된 per-run 요약 |
| `pi-subagent:dashboard:v1` | `pi-subagent` → 외부 선택 consumer | 기존 active/dashboard contract |
| `pi-subagent:aggregate-completed:v1` | `pi-subagent` → 외부 선택 consumer | 기존 terminal invocation 알림 |
| `pi-subagent:detached:v1` | `pi-subagent` → 외부 선택 consumer | 기존 durable promotion 알림 |

presence producer는 root parent(depth `0`)의 `session_start`에서 session ID와 UX generation으로 시작하고 `session_shutdown`에서 listener를 해제한다. nested child는 producer를 만들지 않는다. 초기 빈 idle snapshot은 발행하지 않는 lazy producer이며, active·queued 집계가 생기거나 새 terminal invocation을 관측할 때만 source를 연다. session 전환 뒤 이전 실행의 active aggregate가 남아 새 source가 열리면 idle session-start에서 즉시 deferred settlement로 표시해 aggregate가 quiescent해지는 snapshot에서 철회한다. `update`와 `remove`는 같은 producer-owned generation/단조 증가 sequence fence를 공유한다.

`session_start`에서 producer는 먼저 session-scoped `ready` listener를 설치한 뒤, consumer 없이 정확히 `{ "version": 1, "sessionId": "…" }`인 immutable strict `ready` 요청을 한 번 발행한다. 이미 로드된 compliant v1 consumer는 그 요청에 자신의 consumer advertisement로 동기 또는 비동기로 응답할 수 있다. 나중에 시작한 consumer도 먼저 advertisement를 발행한 뒤, **자신의** consumer-less request를 한 번 발행해 현재 producer를 발견·replay시킨다. `pi.events`의 동기 self-delivery에서는 producer가 **자신이 발행한 바로 그 consumer-less request 객체만** 좁게 무시한다. request 도중 도착하는 별도 consumer-bearing 응답은 계속 처리해 capability 진단과 passive routing hint를 갱신하지만 replay는 일으키지 않는다. 이후 외부의 legacy consumer-less `ready` 요청도 계속 현재 상태를 replay한다.

같은 session/generation의 열린 마지막 update가 있을 때만 동일 session ID의 valid **consumer-less** `ready` 요청에 새 `sequence`를 붙여 replay한다. consumer-bearing advertisement는 현재 presence를 replay하지 않는 passive diagnostics/routing traffic이다. replay의 `attention`은 항상 `"none"`이며, 아직 snapshot이 없거나 이미 remove한 source이거나 session/generation이 다르면 아무 것도 발행하지 않는다. `ready.consumer.id === "pi-cmux-presence"`이고 capabilities에 `"cmux-status"`가 있을 때의 감지는 한 session에 한 번인 passive UI-routing hint일 뿐이다. 동일 session의 valid consumer advertisement에서 `"presence-remove-v1"`을 관측했는지는 consumer ID와 무관하게 session 동안 별도로 기억해 `/subagents doctor`의 `presence remove capability` 진단에만 표시한다. `not observed`는 valid consumer response/advertisement를 관측하지 못했다는 뜻이다. compliant v1 responder라면 이 request/response와 나중 consumer의 request로 load-order race를 줄이지만, 이전 consumer는 요청에 응답하지 않을 수 있다. 호환성을 위해 producer는 capability 관측 여부로 update/remove 또는 consumer-less replay를 gate하지 않으며 실행 policy, child profile, completion 또는 cleanup 권한을 바꾸지 않는다.

## 3. 복제한 `v1` wire contract

`src/integration/pi-presence-producer.ts`는 `pi-cmux-presence` dependency 없이 `v1` update/remove/ready parser와 DTO를 복제한다. update source는 다음 고정 값이며 remove source는 이 중 식별자만 사용한다.

```json
{ "id": "pi-subagent", "label": "Subagents", "kind": "agent-group" }
```

`update`에는 `version`, `sessionId`, `generation`, 증가하는 `sequence`, `source`, `state`, `counts`가 필수다. 선택 필드는 `progress`, `usage`, `attention`이다. `remove`는 정확히 `version`, `sessionId`, `generation`, 증가하는 `sequence`, `source: { id }`만 가지는 strict DTO다. update/remove/ready parser는 plain object와 exact key를 검사하고, untrusted 필드를 한 번 읽어 소유 DTO로 복사하며 getter/proxy 예외를 밖으로 전파하지 않는다. safe text는 1–96 Unicode code points이고 C0/C1 control 및 bidi·방향성 제어 문자를 거부한다. update는 `idle`/`waiting`/`running`/`success`/`error`/`cancelled` state와 0–1,000,000 count를 허용하며, 각 parser는 범위 밖 수치와 잘못된 중첩 shape를 거부한다.

producer는 usage를 얻기 위한 추가 poll/query/timer/provider 호출을 하지 않는다. 대신 검증된 finalized invocation의 token/cost aggregate를 invocation ID당 정확히 한 번 `update.usage`에 반영한다. usage 중복 방지 ID 기억은 세션당 서로 다른 invocation ID 최대 `4096`개이며, 포화 후에는 aggregate를 동결하고 새 usage를 반영하지 않는다. context percent는 계산·조회·추정하지 않는다. task, prompt, raw output, cwd/path, credential, raw title, socket/capability 또는 private cmux/tmux target ID도 update/remove payload에 넣지 않는다.

### 선택적 `summary:v1`

`ready.consumer.capabilities`에 정확히 `presence-summary-v1`이 광고된 **non-cmux consumer**가 있을 때만 producer는 `pi-presence:summary:v1`을 발행한다. fixed V1 `pi-cmux-presence` consumer는 summary를 소비하거나 이 capability를 광고하지 않는다. 따라서 그 exact consumer ID가 capability를 포함한 future-looking 또는 그 밖의 incompatible advertisement를 보내도 producer는 summary를 활성화하지 않는다. 이 명시적 비호환성은 cmux의 frozen V1 update/remove/ready contract를 유지하며, Herdr 등 다른 capable consumer의 선택 summary 지원은 바꾸지 않는다. 기존 generic `update:v1` DTO와 consumer 호환성은 이 capability로 바뀌지 않는다. summary는 별도 generic sequence를 소비하지 않고 연결된 current/replay update의 sequence를 공유하며, update와 summary cache를 먼저 함께 저장한 뒤 synchronous update emit을 수행한다. 같은 session/generation fence 안에서만 발행·replay되고 remove 뒤에는 재생하지 않는다.

summary는 정확히 `{version, sessionId, generation, sequence, source:{id}, active, omitted}`와 선택 `waiting`, `terminal`만 가진 strict/frozen DTO다. `active`는 최대 8개의 `{id, agent, status:"running"|"cancelling", category:"active"|"cancelling", startedAt}`이고, `waiting`은 `{category:"queued"|"cancelling", count}`, `terminal`은 `{id, agent, status:"completed"|"failed"|"cancelled", completedAt}`이다. `omitted`는 `max(0, update.counts.active - active[].length)`이며, 8개 제한으로 내보내지 못한 UX active뿐 아니라 summary `active[]`에 대응하지 않는 scheduler-only 또는 interactive-only active도 포함할 수 있다. scheduler queue가 있으면 `waiting:{category:"queued",count}`로, active snapshot이 cancelling뿐이면 `waiting:{category:"cancelling",count}`로 요약한다. text는 control/bidi 없는 최대 96 Unicode code point, timestamp는 non-negative safe integer, count는 0–1,000,000이다. task, output, error, path, socket, Herdr 식별자는 어떤 경우에도 포함하지 않는다. 이는 observer UI용이며 실행·취소·완료·cleanup 권한을 만들지 않는다.

## 4. 집계와 진행률

`update`는 session-local UX snapshot과 scheduler/interactive count만 사용한다.

- `active`는 process-local interactive run의 optional invocation ID와 현재 UX의 `running`/`cancelling` invocation ID를 **정확히** 대조한다. interactive ID가 현재 active invocation ID와 같으면 matched, ID가 없거나 terminal/없는 invocation ID면 unmatched다. `unmatchedInteractive + max(activeInvocationCount, scheduler.active, matchedInteractive)`로 계산하므로 managed `1/1/1`과 원 invocation이 active인 전환은 `1`, 오래 남은 run과 관련 없는 inline invocation은 `2`, 병렬 interactive child 둘은 `2`가 된다. 이 correlation ID는 runtime 메모리에만 있고 artifact나 presence wire payload에는 저장·발행하지 않는다. legacy count-only callback은 correlation을 제공하지 못하므로 모든 interactive run을 unmatched로 보수 처리한다.
- `queued`는 scheduler queue 수다.
- `completed`/`failed`/`cancelled`는 session 안에서 처음 본 terminal invocation ID만 누적한다. UX recent history가 pruning되어도 계속 유지한다. ID 기억은 4,096개, 각 presence count는 1,000,000으로 상한을 둔다. ID 기억이 포화되면 재전송으로 과대계산하지 않도록 새 terminal count를 동결한다.
- `active > 0`이면 state는 `running`이다. `active === 0`이고 `queued > 0`인 **queued-only** 상태는 `waiting`이다. 둘 다 없으면 가장 최근 terminal outcome에 따라 `success`/`error`/`cancelled`, terminal이 없으면 `idle`이다.
- attention은 invocation kind와 관계없이 새 terminal에 붙는다. foreground/background `failed → error`, foreground/background `completed → success`; `cancelled`은 `none`이다. 그 밖의 정상 update와 모든 replay도 `none`이다. consumer는 부모 Pi lifecycle과 terminal attention을 병합해 child 완료를 전체 응답 완료로 조기에 표시하지 않아야 한다.

progress는 추측한 작업량이 아니라 structured tool details와 invocation의 알려진 work count에서만 얻는다. 단일 호출은 active 동안 `0/1`을 내고 terminal update에서는 progress를 생략하며, 병렬 호출은 `details.results` 길이를 total로, `exitCode !== -1` result 수를 completed로 사용한다. 체인은 `chainStageCount`를 total로, `chainCompletedCount`·`chainSkippedCount`·`chainFailedCount`·`chainCompletedWithErrorsCount` 합계를 completed로 사용하며 total을 넘지 않게 제한한다. 여러 active invocation의 determinate progress는 합산해 `Subagents completed/total`로 표시한다.

root parent의 idle `agent_settled`에서 aggregate가 이미 quiescent(`active === 0`, `queued === 0`)이면 마지막 terminal update 뒤에 remove를 발행한다. background·queued·interactive work가 남아 있으면 settlement를 보류하고, 뒤 snapshot이 quiescent가 된 뒤에만 remove한다. user ownership으로 승격된 `detached` interactive surface는 aggregate active에서 제외하고 승격 직후 snapshot을 다시 발행해 보류 settlement가 quiescence를 관측할 수 있게 한다. `kept`·`transferring`·`ownership-unknown`은 보수적으로 active에 남긴다. 새 parent `agent_start`는 이전 parent의 보류 settlement를 해제해 새 run을 철회하지 못하게 한다. remove 전에는 terminal update가 먼저 발행되고, remove 직전에 cached current snapshot을 비워 동기 `ready`가 오래된 상태를 replay할 수 없다. 다음 burst는 더 높은 sequence의 update로 다시 열며 terminal count는 session 동안 누적된다. `stop`, session shutdown, reload/새 session 전환도 열린 상태의 best-effort remove를 시도한다.

## 5. 권한·child profile·기존 event의 분리

presence는 observer 출력이다. update/remove/ready listener, consumer socket 또는 UI 오류는 모두 best-effort로 격리되며 invocation registry, `CompletionRecordV3`, result replay, cancellation, lease, reaper, detached ownership 또는 cleanup 결정을 만들지 않는다. remove는 observer retained 상태의 철회일 뿐 cancellation이나 cleanup authority가 아니며, consumer가 완료 또는 철회를 표시해도 결과 수집이나 target close 권한이 생기지 않는다.

`PI_SUBAGENT_CMUX_CHILD_POLICY=managed`는 inherited extension을 제외하므로 inherited `pi-cmux-presence`도 child에 로드하지 않는다. `inherit` child의 extension loading은 parent의 generic root producer를 복제하지 않으며, 별도 child presence policy나 `PI_CMUX_PRESENCE_*` 전달은 제공하지 않는다. presence는 JSON/CLI/environment 설정 항목이 아니며, `pi-subagent.json`이나 `subagent` tool schema를 확장하지 않는다.

기존 `pi-subagent:dashboard:v1`, `pi-subagent:aggregate-completed:v1`, `pi-subagent:detached:v1`은 계속 독립 contract다. dashboard/aggregate/detached를 presence update로 변환하지 않고, detached promotion을 terminal completion으로 취급하지 않는다. 이 채널은 동일한 dashboard publisher의 shared session/generation/sequence fence를 유지한다. presence는 producer-own session/generation/sequence fence를 사용한다.

## 6. 별도 consumer 작업 범위

여기까지는 이 repository의 `pi-subagent` producer 구현과 검증 범위다. notification/flash, terminal burst와 parent lifecycle의 병합 같은 consumer 정책은 `pi-cmux-presence`가 소유하며 canonical consumer contract를 따른다. 특히 정확한 `source.id: "pi-subagent"` remove를 수락한 consumer는 누적 terminal baseline과 보류 terminal burst를 초기화하고, 보류된 parent attention이 있으면 producer payload를 복사하지 않는 local parent fallback을 자체 policy·capability gate로 처리한다.

remove를 모르는 이전 consumer는 event를 구독하지 않아 무시하므로 마지막 update를 session teardown까지 retained한 기존 sticky 동작을 유지할 수 있다. 이 호환성 및 consumer의 notification 의미는 `pi-subagent`의 event DTO·producer lifecycle·result collection·cancellation·cleanup authority를 바꾸지 않는다.

## 7. 검증 범위

`pi-subagent`에서 다음 focused test는 strict update/remove/ready parsing, producer-first/consumer-first ready request·response, frozen exact-self request 차단, advertisement의 zero-replay와 consumer-less request의 one-replay, multi-producer duplicate-amplification 차단, shared session/generation/sequence fence, lazy open, attention 없는 replay, `agent_settled` remove 및 queued/interactive deferred withdrawal, stale replay 차단, reload/session teardown withdrawal, queued-only `waiting`, foreground/background terminal attention, pruning 뒤 terminal 누적과 observer failure 격리를 확인한다.

```bash
bun test test/integration/pi-presence-producer.test.ts
```

추가로 `test/fixtures/presence-v1-consumer-profiles.json`과 deterministic fake event-bus harness는 fixed cmux V1(`presence-summary-v1` 없음)과 Herdr V1 + `presence-summary-v1` profile 각각에 대해 consumer-first/producer-first ready handshake, consumer-less replay, terminal update 뒤 remove 순서, summary sequence 경계, 그리고 producer source의 sibling import/socket/CLI/timer polling 부재를 확인한다. 이 fixture는 consumer 구현을 import하거나 socket을 열지 않는 **producer-only 결정적 증거**다.

```bash
bun test test/integration/presence-v1-compatibility.test.ts
```

`bun run ci`는 type check와 file isolation 전체 테스트를 실행한다. 테스트는 의도적으로 file-global Bun mock과 process global을 사용하므로 file isolation이 필수다. 두 deterministic 범위와 baseline CI는 별도 `pi-cmux-presence` package의 실제 소비 구현이나 live cmux E2E 조합을 증명하지 않는다.

별도 opt-in 교차 smoke는 다음처럼 실행한다.

```bash
bun run acceptance:cmux-presence:dry-run
PI_SUBAGENT_LIVE_CMUX_PRESENCE=1 \
PI_SUBAGENT_CMUX_PRESENCE_TRUST=1 \
bun run acceptance:cmux-presence
```

script는 live mutation gate나 dynamic-import trust gate를 대신 설정하지 않는다. live는 sibling `pi-cmux-presence`의 실제 entrypoint/consumer와 consumer의 Unix socket 검사를 동적으로 사용하지만 package dependency를 추가하지 않는다. 이 import는 trusted code 실행이므로 `PI_SUBAGENT_CMUX_PRESENCE_TRUST=1`을 별도로 요구한다. filesystem root부터 checkout까지 canonical ancestor가 실제 directory·no symlink·현재 uid/root 소유·non-group/world-writable인지 trust gate로 확인하고, 정확한 package name `pi-cmux-presence` 및 명시 allowlist의 `package.json`·`index.ts`·필요한 모든 `src/*.ts`를 same-handle/no-follow로 검증한 bytes만 private `0700` snapshot에 `0600` 파일로 stage한다. evidence에는 source 내용 없이 deterministic SHA-256 manifest summary만 남기며 mutable sibling path는 import하지 않는다. 이것은 local replacement 위험을 줄이지만 sandbox 또는 credential 격리가 아니며 trusted code는 여전히 full authority로 개발자 파일과 환경에 접근할 수 있다. canonical cmux caller와 caller-disjoint disposable workspace에서 고정 provider-free snapshot의 exact `pi-subagent` running status와 `remove` 뒤 strict `list-status` key 부재만 확인한다. 모든 cmux command는 timeout과 stdout/stderr byte cap을 적용하며 cap/timeout은 unknown failure다. native lifecycle/progress/notification/flash/log/feed/meta/auto-title/resume fallback 및 consumer profile toggle을 sanitize하고 key별로 복원한 뒤 sidebar만 사용한다. fake/synthetic Pi lifecycle, event bus, package loader를 사용하지만 실제 consumer/socket/cmux status를 확인한다. 실제 Pi loader는 범위 밖이다. provider 호출, child Pi, prompt/task/raw output/credential 전송, 일반 Pi session 및 consumer의 전체 notification policy는 범위 밖이다. malformed `list-status`, producer stop, consumer shutdown, environment/socket/caller proof 또는 reconcile된 singleton workspace close proof 실패는 absence/cleanup 성공으로 간주하지 않고 private evidence root를 남긴다. 인접 sibling checkout이 없으면 `PI_SUBAGENT_CMUX_PRESENCE_ROOT=/absolute/path/to/pi-cmux-presence`에 canonical absolute path를 명시한다.

관련 구현 근거:

- `index.ts` — root-only session wiring과 UX/scheduler observer 연결
- `src/integration/pi-presence-producer.ts` — duplicated `v1` DTO parser와 observer-only update/remove/ready producer
- `test/integration/pi-presence-producer.test.ts` — remove lifecycle를 포함한 focused contract test
- [`pi-cmux` 연동 가이드](./pi-cmux-integration.md) — optional `pi-cmux` UX와 legacy dashboard contract
