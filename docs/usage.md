# 사용법

`subagent` 도구는 단일, 병렬, 체인, 백그라운드 작업 관리 네 가지 호출 형태를 지원합니다. 한 번의 호출에는 정확히 하나의 형태만 사용합니다.

기존 `agent`/`task`, `tasks`, `chain` 호출은 그대로 블로킹 실행으로 유지됩니다. 단일 모드는 한 실행의 결과 요약을, 병렬/체인은 작업·단계 라벨과 상태/오류 요약을 포함한 모드별 결과 래퍼를 반환합니다. 여기에 선택적 최상위 `background: true`를 추가하면 호출이 즉시 반환되고, 완료/실패/취소 결과는 나중에 자동 steer 메시지로 전달됩니다. 별도의 조회/취소 호출로 `status`와 `cancel`도 지원합니다.

모델 선택 우선순위는 호출별 `model` → 에이전트 파일 `model` → 부모 CLI 모델 오버라이드 → Pi 기본 모델입니다.

Herdr 관련 변경은 terminal backend, `auto` layout의 user-visible 배치와 내부 진단 채널에 한정됩니다. 공개 `subagent` **입력** schema/validation과 결과 envelope shape는 Herdr 이전 commit `7544439`와 동일합니다. 이미 병합된 Herdr 기능의 additive `details.terminalMode: "herdr-pane"` 외에 새 tool contract 변경은 없습니다. Herdr의 socket `agent.*`/metadata는 내부 presentation 채널이며 `pi-presence:update:v1`/`pi-presence:remove:v1`/`pi-presence:ready:v1` protocol과도 별개입니다.

호출 크기·동시성·백그라운드 보존/출력/종료 대기는 `subagent` 호출의 새 JSON 필드가 아닙니다. Pi CLI 플래그, 환경 변수 또는 `pi-subagent.json`의 열한 가지 한계 키로 설정하며, 이 설정은 기존 `agent`/`task`, `tasks`, `chain`, `action`과 선택 `background` 계약을 바꾸지 않습니다. 파일 경로·신뢰 조건·우선순위와 전체 mapping·기본값·검증은 [설정의 `pi-subagent.json` 파일 설정](./configuration.md#pi-subagentjson-파일-설정)을 참고하세요.

## 입력 검증

호출 인수는 실행 전에 원본 값 그대로 엄격하게 검증합니다.

- 지원하지 않는 `own enumerable` 필드는 최상위 객체, 최상위 `tasks[]` 항목, 순차 체인 단계, 병렬 체인 단계, 병렬 단계 내부 `tasks[]` 항목에서 거부합니다.
- 제공하는 `agent`, `task`, `id`, `model`, `cwd`는 공백만으로 이루어지지 않은 문자열이어야 합니다. 유효한 문자열은 검증 과정에서 자동으로 `trim`하지 않으므로 앞뒤 공백도 전달 값에 남습니다.
- 체인 `label`은 문자열이면 됩니다. 라벨은 표시와 중복 검사에서 앞뒤 공백을 제거하며, 빈 문자열이나 공백만 있는 라벨은 기존 호환성을 위해 허용하고 생성된 `step-N` 라벨로 대체합니다. 공백을 제거한 라벨은 서로 중복될 수 없습니다.

## 단일 모드

단일 모드는 하나의 집중된 작업을 위임할 때 사용합니다.

```json
{ "agent": "writer", "task": "Document the API", "model": "anthropic/claude-sonnet-4", "mode": "spawn" }
```

필수 필드:

- `agent`: 사용 가능한 에이전트 파일의 이름과 정확히 일치하는 하위 에이전트 이름
- `task`: 자식 에이전트에게 전달할 독립적인 작업 프롬프트

선택 필드:

- `mode`: `spawn` 또는 `fork`; 기본값은 `spawn`
- `cwd`: 자식 프로세스의 작업 디렉터리
- `model`: 이 호출에 사용할 선택적 모델 오버라이드. 에이전트 파일의 `model`보다 우선합니다.
- `background`: `true`면 즉시 반환하는 백그라운드 작업으로 실행합니다.

## 병렬 모드

병렬 모드는 서로 독립적인 작업을 동시에 실행할 때 사용합니다.

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect API routes" },
    { "agent": "security-reviewer", "task": "Review auth and secret handling", "model": "anthropic/claude-sonnet-4" },
    { "agent": "reviewer", "task": "Check maintainability risks" }
  ],
  "mode": "spawn"
}
```

동작:

- 기본적으로 호출별 최대 16개를 동시에 매핑합니다. Linux/macOS에서는 root parent와 모든 nested child가 공유하는 tree-wide `max-active` `ACTIVE`/`RESERVED` permit 범위 안에서 시작합니다. Windows는 tree-wide hard cap을 지원하지 않고 process-local scheduling으로 fallback합니다.
- 기본적으로 한 번의 호출에는 최대 50개 작업을 받습니다.
- 최상위 `mode`가 모든 작업에 적용됩니다.
- 각 작업 항목은 `{ agent, task, cwd?, model? }` 형태이며, `model`은 해당 작업에만 적용됩니다.
- `background`를 생략하거나 `false`로 두면 모든 작업이 끝난 뒤 부모 에이전트가 작업별 라벨과 성공/실패 요약을 묶은 병렬 결과 래퍼를 받습니다.
- `background: true`면 호출은 즉시 반환되고, 최종 결과는 나중에 steer 메시지로 도착합니다.
- 접힌 TUI 행에는 빠른 식별을 위한 한 줄 `Task:` 미리보기가 표시됩니다.

독립적인 조사, 리뷰, 탐색 작업에 사용하세요. 여러 에이전트가 같은 파일을 편집할 가능성이 있으면 사용하지 마세요.

## 체인 모드

체인 모드는 뒤 단계가 앞 단계의 결과에 의존할 때 사용합니다.

```json
{
  "chain": [
    {
      "label": "discovery",
      "type": "parallel",
      "tasks": [
        { "agent": "scout", "task": "Inspect local code" },
        { "agent": "researcher", "task": "Check external docs", "model": "openai/gpt-4.1" }
      ]
    },
    { "label": "plan", "agent": "planner", "task": "Create a plan from discovery outputs", "model": "anthropic/claude-sonnet-4" },
    { "label": "implement", "agent": "worker", "task": "Implement the plan" },
    {
      "label": "review",
      "type": "parallel",
      "continueOnError": true,
      "tasks": [
        { "agent": "reviewer", "task": "Review correctness" },
        { "agent": "security-reviewer", "task": "Review security" }
      ]
    }
  ],
  "mode": "spawn"
}
```

동작:

- 단계는 순서대로 실행됩니다.
- 기본적으로 한 번의 호출에는 최대 12개 단계를 받습니다.
- 한 단계는 순차 에이전트 단계이거나 병렬 그룹일 수 있습니다.
- 병렬 단계는 기본적으로 최대 8개 작업을 받고 호출별 동시성 기본값 16에서 실행합니다. Linux/macOS에서는 root parent와 모든 nested child가 공유하는 tree-wide `max-active` `ACTIVE`/`RESERVED` permit 범위도 적용됩니다. Windows는 tree-wide hard cap을 지원하지 않고 process-local scheduling으로 fallback합니다.
- 최상위 `mode`가 모든 단계와 작업에 적용됩니다.
- 첫 번째 이후의 각 단계는 이전 단계 요약을 현재 작업 앞에 전달받습니다.
- 실패한 단계가 있으면 기본적으로 체인을 중단합니다. 단, 해당 단계에 `continueOnError: true`가 있으면 계속 진행합니다. 이렇게 계속된 오류는 blocking error가 아니므로 뒤의 기본 `on_success` 단계도 실행될 수 있으며, `on_error`와 `on_completed_with_errors`도 각각 누적 상태에 따라 동시에 참일 수 있습니다.
- `condition`은 상호 배타적인 분기문이 아닙니다. `always`는 누적 상태와 무관하게 실행하고, `on_success`는 blocking error가 없을 때, `on_error`는 앞 단계에서 오류가 하나라도 있었을 때, `on_completed_with_errors`는 앞 단계가 완료+오류 상태를 만든 경우 실행합니다.
- `background`를 생략하거나 `false`로 두면 체인 완료 뒤 단계 라벨과 완료/실패/완료+오류 요약을 포함한 체인 결과 래퍼를 반환합니다.
- `background: true`면 호출은 즉시 반환되고, 최종 결과는 나중에 steer 메시지로 도착합니다.

순차 단계 필드:

- `type: "chain"` — 선택적 순차 단계 discriminator. 생략해도 같은 순차 단계입니다.
- `label` — 선택적 단계 이름. 라벨을 쓰는 경우 중복될 수 없습니다.
- `agent` — 하위 에이전트 이름
- `task` — 작업 프롬프트
- `cwd` — 선택적 작업 디렉터리
- `model` — 이 단계에 사용할 선택적 모델 오버라이드. 에이전트 파일의 `model`보다 우선합니다.
- `condition` — `always`, `on_success`, `on_error`, `on_completed_with_errors`
- `continueOnError` — 이 단계가 실패해도 뒤 단계를 계속 실행

병렬 단계 필드:

- `type: "parallel"`
- `label` — 선택적 단계 이름. 라벨을 쓰는 경우 중복될 수 없습니다.
- `tasks` — `{ agent, task, cwd?, model? }` 배열
- `condition` — `always`, `on_success`, `on_error`, `on_completed_with_errors`
- `continueOnError` — 하나 이상의 병렬 작업이 실패해도 뒤 단계를 계속 실행

## 백그라운드 실행 계약

`background: true`는 단일, 병렬, 체인 세 형태 모두에서 같은 의미를 갖습니다. 동시에 `running` 또는 `cancelling` 상태인 백그라운드 작업은 기본적으로 최대 16개까지 허용됩니다.

> When background is true, this tool returns immediately. Do not fabricate or summarize results before they arrive. Do not poll repeatedly, sleep, tail logs, or wait in loops. The result will be delivered automatically as a steer message. Continue only with independent work, or end your turn.

자동 steer 메시지와 `subagent({ action: "status", id })`에 포함되는 결과/오류 텍스트의 비신뢰 wrapper 형식, 기본 바이트 상한과 절단 규칙은 [에이전트의 백그라운드 결과 처리](./agents.md#백그라운드-결과-처리)를 참고하세요.

예시:

```json
{ "agent": "writer", "task": "Draft release notes", "background": true }
```

## Interactive lifecycle

interactive child는 parent-owned 고정 lifecycle로 동작합니다. 첫 정상 `agent_settled` 뒤 결과를 부모에 전달합니다. cmux/tmux 및 Herdr `split`은 기록된 exact surface/pane에 Escape를 요청한 뒤 grace period 후 닫습니다. Herdr `auto`는 인증된 child bridge의 cooperative `ctx.abort()`/`ctx.shutdown()`만 사용하며 parent `pane.send_keys`/`pane.close`/rollback/reaper mutation을 하지 않습니다. present/unknown/hung terminal은 recovery/manual cleanup과 late watcher로 보존하고 confirmed absence에서만 retire합니다.

## 상태 확인과 취소

백그라운드 작업은 다음 호출로 관리합니다.

```js
subagent({ action: "status" })
subagent({ action: "status", id })
subagent({ action: "cancel", id })
```

- `status`는 백그라운드 작업 목록 또는 특정 작업의 현재 상태를 조회합니다. 목록은 현재 프로세스 메모리 기준이며, 종료된 작업은 기본적으로 최대 20개/약 1시간 범위에서만 보존됩니다. history limit 또는 TTL을 0으로 설정하면 종료 기록은 즉시 pruning 됩니다.
- `cancel`은 실행 중인 작업에 중단을 요청하고 상태를 먼저 `cancelling`으로 표시합니다. 실제 하위 프로세스가 abort/오류로 종료되면 `cancelled`, 취소 요청 직전에 정상 완료했으면 `completed`로 확정될 수 있습니다.
- `cancel`에서 `id`를 생략하면 현재 실행 중인 모든 백그라운드 작업에 취소를 요청합니다.
- `status`에서 `id`를 생략하면 현재 프로세스가 기억하고 있는 작업 목록을 반환합니다.

### Parent TUI `/subagents`

root parent Pi에서는 LLM tool schema를 늘리지 않는 단일 slash command도 제공합니다.

```text
/subagents
/subagents list
/subagents doctor
/subagents cancel <full-id>
/subagents details <full-id>
/subagents focus <run-id>
/subagents keep <run-id>
/subagents promote <run-id>
```

`/subagents`는 TUI mode에서 항목이 있을 때 selector를 열고, 항목이 없거나 non-TUI이면 plain list notification을 표시합니다. `list`는 session-local foreground/background invocation, bounded recent 상태와 active interactive run을 표시하며 Herdr run에는 presentation-only transport/target/orphan-risk를 덧붙입니다. `cancel`은 invocation exact full ID만 받아 기존 AbortSignal lifecycle로 취소하며 prefix 추측은 하지 않습니다. `details`는 exact interactive run의 backend/placement/depth/elapsed/존재·exit/managed-title 상태, Herdr transport/target/orphan-risk와 256자 이하 sanitized public-result preview를 보여 줍니다. raw terminal title, task, prompt, cwd, socket, capability와 credential은 표시하지 않습니다. `focus`는 negotiated cmux `surface.focus` 또는 protocol-gated Herdr의 exact rebound pane만 사용합니다. Herdr는 socket/protocol과 terminal binding을 다시 검증한 뒤 exact `agent.get`, 정확히 한 번의 `agent.focus`, read-only identity post-check 순으로 수행하며 `pane.focus` fallback이나 mutation retry가 없습니다. expected-terminal CAS가 없으므로 read→mutation 잔여 race는 남고 focus는 user-initiated UX에만 사용합니다. Herdr `auto`는 shared pane/window이 아니라 child별 unfocused 새 tab의 root pane이며, `cancel` 뒤 present/unknown/hung이면 recovery/manual cleanup과 late watcher를 유지합니다. tmux는 safe caller-client authority가 없어 fail-closed하며, Herdr identity/protocol rebinding을 검증하지 못해도 fail-closed합니다. `keep`은 session shutdown까지 exact live target을 보존합니다. `promote`는 immutable allocation-digest marker로 user ownership을 넘겨 reaper target mutation에서 제외하며 `promoted`, `already-promoted`, `ownership-unknown`, `rejected`를 구분합니다. marker가 malformed/unreadable이면 run은 visible `ownership-unknown` 상태로 남고 UI가 cleanup authority unknown/revoked와 automatic cleanup 중지를 알립니다. `doctor`는 cmux/tmux의 새 command·topology probe 없이 terminal identity, layout, child policy, scheduler, active authority, session-local reaper 진단 code/count와 registry metadata를 진단합니다. Herdr에는 환경 구성, owner-only socket generation, protocol 19/20 ping, exact caller pane, matching agent를 순서대로 확인하는 read-only bounded readiness probe를 별도로 표시하며 ID·path·socket 값은 출력하지 않습니다. control readiness는 각 interactive launch에서도 다시 검증합니다. 정상적인 fork-source `retained`와 entry-cap debug 상태는 비동기 TUI 알림을 만들지 않습니다. `graph-entry-cap`은 reaper graph entry 상한 초과를 뜻하며, 이 경우 reaper의 **모든** mutation을 보류하고 durable state를 검사용으로 유지합니다. malformed fork-source는 세션당 warning 한 번, reconciliation 및 reaper 시작·완료 실패는 code별 error 한 번만 Pi notification으로 표시하며 private UUID·원본 진단 payload는 notification과 doctor 요약에서 제외합니다. non-UI mode에서는 debug를 제외한 모든 진단이, TUI shutdown 경로의 reconciliation 실패는 항상 식별자 배열별 count와 최대 20개 값, 최대 2,000자의 error detail로 제한한 stderr 로그를 남깁니다. Pi `notify`가 throw하면 TUI에서도 같은 진단이 동일하게 bounded된 stderr 로그로 대체 기록됩니다. footer는 event-driven으로 `subagents: ●<running> ◷<scheduler-queued> ◌<cancelling> ✓<completed> ✕<failed> –<cancelled>` 전체 아이콘/집계를 표시합니다.

### 선택적 generic presence

root parent는 같은 Pi process의 선택 consumer를 위해 `pi-presence:update:v1`을 발행하고 `pi-presence:remove:v1`으로 열린 retained observer 상태를 철회합니다. `pi-presence:ready:v1`은 consumer-less replay 요청과 consumer advertisement/응답에 함께 사용합니다. session 시작 시 producer는 listener를 설치한 뒤 `{ "version": 1, "sessionId": "…" }` strict consumer-less 요청을 정확히 한 번 발행합니다. `pi-cmux-presence`를 설치·로드했을 때만 그 package가 이를 소비해 UI를 갱신할 수 있으며, 설치하지 않아도 subagent 결과·취소·lease·reaper·cleanup은 같습니다. producer는 cmux CLI나 control socket, usage 추가 poll/query/timer/provider 호출을 사용하지 않습니다. 대신 검증된 finalized invocation의 token/cost aggregate만 invocation ID당 정확히 한 번 generic update의 `usage`에 반영합니다. usage 중복 방지 ID 기억은 세션당 서로 다른 invocation ID 최대 `4096`개이며, 포화 후에는 aggregate를 동결하고 새 usage를 반영하지 않습니다. context-percent, task, prompt, raw output, 경로, credential, raw title과 private target ID는 update/remove에 발행하지 않습니다.

`presence-summary-v1` capability를 ready advertisement로 명시한 **non-cmux consumer**에만 `pi-presence:summary:v1` companion event를 추가 발행할 수 있습니다. fixed V1 `pi-cmux-presence`는 summary를 소비·광고하지 않으며, 그 exact consumer ID의 capability 주장만으로는 summary를 활성화하지 않습니다. 이는 cmux update/remove/ready V1 contract를 고정하면서 다른 capable consumer의 선택 summary 지원을 유지합니다. summary는 정확히 `{version,sessionId,generation,sequence,source:{id},active,omitted}`와 선택 `waiting:{category:"queued"|"cancelling",count}`, `terminal:{id,agent,status:"completed"|"failed"|"cancelled",completedAt}`만 담는 strict/frozen observer DTO입니다. summary는 별도 sequence를 소비하지 않고 연결된 current/replay `update`와 같은 sequence를 사용하며, update와 cache를 먼저 함께 저장한 뒤 synchronous update emit이 수행됩니다. active는 최대 8개의 `{id,agent,status:"running"|"cancelling",category:"active"|"cancelling",startedAt}`이며 task/output/error/path/socket/Herdr ID는 포함하지 않습니다. generic v1 update/remove 및 기존 consumer 동작은 바꾸지 않습니다. producer는 초기 idle에는 event를 발행하지 않고 active·queued 집계 또는 새 terminal invocation에서 source를 엽니다. update/remove는 session/generation의 단조 증가 sequence fence를 공유합니다. parent의 idle `agent_settled`에서 aggregate가 quiescent이면 마지막 terminal update 뒤 remove하며, background·queued·interactive work가 남으면 quiescent snapshot까지 철회를 보류합니다. user ownership의 `detached` interactive surface는 active 집계에서 제외하지만 `kept`·`transferring`·`ownership-unknown`은 보수적으로 유지합니다. 새 parent `agent_start`는 이전 run의 보류 철회를 해제합니다. remove 전에 cached snapshot을 비우므로 이후 `ready`가 stale state를 replay하지 않으며, 다음 burst는 더 높은 sequence update로 다시 열립니다. terminal count는 UX recent history가 pruning된 뒤에도 session 동안 누적됩니다. `stop`, session shutdown, reload도 열린 상태의 best-effort remove를 시도합니다.

presence progress는 structured details와 호출 형태의 알려진 work count에서만 계산합니다. 단일 호출은 실행 중 `0/1`, 병렬은 `results`의 terminal 수/전체 작업 수, 체인은 terminal·skipped·failed·completed-with-errors stage 수/전체 stage 수를 사용합니다. terminal update에서는 active progress를 생략해 consumer가 progress 슬롯을 정리합니다. 동기 `pi.events` self-delivery에서는 producer가 자신이 발행한 바로 그 immutable consumer-less 요청만 무시하므로 self-replay하지 않으며, 그 request 동안 별도 consumer-bearing 응답이 오면 capability 진단과 passive routing hint는 계속 처리합니다. consumer-bearing advertisement 자체는 replay하지 않습니다. 나중에 시작한 consumer는 advertisement 뒤 자신의 consumer-less `pi-presence:ready:v1` 요청을 보내며, 그 요청과 legacy external consumer-less 요청만 열린 마지막 snapshot을 한 번 replay할 수 있고 replay `attention`은 항상 `none`입니다. 같은 session의 valid consumer가 광고한 `presence-remove-v1`은 `/subagents doctor`에서 진단할 수 있지만 consumer ID와 무관하고, 호환성을 위해 update/remove 또는 consumer-less replay를 gate하지 않습니다. `not observed`는 valid consumer response/advertisement를 관측하지 못했다는 뜻입니다. compliant v1 responder의 request/response와 나중 consumer의 request는 load-order race를 줄이지만, 이전 consumer는 요청에 응답하지 않을 수 있습니다. remove는 observer withdrawal일 뿐 cancellation이나 cleanup authority가 아니며 observer/UI 오류도 실행 상태나 lifecycle authority를 바꾸지 않습니다. remove를 모르는 이전 consumer는 이를 무시해 마지막 update를 기존처럼 retained할 수 있습니다. notification 의미와 exact `pi-subagent` remove 때 terminal baseline·보류 burst 초기화 및 parent fallback은 consumer가 소유합니다. wire contract와 child profile 경계는 [`pi-cmux-presence` presence 연동](./pi-cmux-presence-integration.md)을 참고하세요.

## 권장 패턴

- 코드베이스 정찰 뒤 계획이 필요하면 `scout -> planner`를 사용합니다.
- 로컬 사실과 외부 문서를 독립적으로 모을 수 있으면 `scout + researcher -> planner`를 사용합니다.
- 구현 뒤 검토가 필요하면 `worker -> reviewer + security-reviewer`를 사용합니다.
- 모든 작업이 독립적이면 최상위 병렬 모드를 사용합니다.
- 뒤 작업이 앞 작업의 요약을 필요로 하면 체인 모드를 사용합니다.

## 결과 가시성

각 하위 에이전트는 별도의 `pi` 프로세스에서 실행됩니다. cmux, tmux, Herdr에서는 실제 interactive Pi TUI가 표시됩니다. 기본 `auto` layout에서 cmux root sibling은 새 오른쪽 shared pane의 surface를 공유하고 nested descendant는 source pane에 쌓입니다. tmux child는 parent와 같은 session의 detached window를 각각 사용하므로 parent window를 split하지 않습니다. Herdr child는 parent focus를 유지한 별도 tab의 strict root pane을 하나씩 사용합니다. `--subagent-pane-layout split` 또는 `PI_SUBAGENT_PANE_LAYOUT=split`은 child별 기존 오른쪽 split 호환 동작입니다. 값의 우선순위·유효성·중첩 상속은 [configuration의 Interactive pane layout](./configuration.md#interactive-pane-layout)을 참고하세요.

child TUI stdout은 부모 결과 channel로 사용하지 않으며, 부모는 durable child session JSONL에서 새로 작성된 최종 assistant message와 usage만 읽습니다. fork의 상속 snapshot은 결과에 다시 포함되지 않습니다. interactive child는 첫 정상 `agent_settled` 뒤 종료됩니다. cmux/tmux과 Herdr `split`만 해당 child의 exact pane/surface를 닫으며, Herdr `auto`는 cooperative shutdown 뒤 confirmed absence 또는 수동 recovery를 기다립니다.

Interactive runtime의 broker/backend resolver 우선순위(`PI_SUBAGENT_BROKER_RUNTIME` → `PATH`의 `bun` → `node`, cmux는 app control socket v2 직접 사용, tmux는 비어 있지 않은 `TMUX_BIN` 뒤 `PATH`의 `tmux`)와 symlink/shebang shim 지원 범위는 [configuration의 V2 broker runtime과 backend resolver](./configuration.md#v2-broker-runtime과-backend-resolver)를 참고하세요.

interactive child의 provider credential/configuration은 inline과 같은 Pi `0.80.10` 지원 변수만 private `0600` artifact로 전달됩니다. `AWS_BEARER_TOKEN_BEDROCK`, `RADIUS_API_KEY`, Azure/Cloudflare/Bedrock/Vertex 설정, proxy/CA 변수의 정확한 목록과 arbitrary environment 제외 규칙은 [configuration의 Interactive provider 환경 전달](./configuration.md#interactive-provider-환경-전달)을 참고하세요. 별도 Phase 0 provider-live acceptance synthetic parent는 production child 환경을 바꾸지 않는 harness이며, explicit allowlist의 PATH/HOME/locale, proxy/CA와 명시 transport/harness 값만 받습니다. ambient `PI_SUBAGENT_*`, credential, shell/loader hook, arbitrary variable, multiplexer state는 전달하지 않습니다. 실패 root를 retain할 경우 raw error/output 대신 bounded private top-level `failure-summary.json` 하나만 남을 수 있습니다. recovery scrub은 valid checkpoint(있다면)와 valid summary 외 artifact를 보존하지 않으며, `cleanupProven`은 cell과 transport cleanup 모두가 증명됐을 때만 true입니다.

프로젝트 에이전트 승인 범위는 해당 에이전트 프롬프트뿐입니다. 프로젝트에서 실행되는 child Pi는 항상 `--no-context-files --no-approve`를 사용하므로 그 승인만으로 `AGENTS.md`/`CLAUDE.md`, `.pi/settings.json`, extensions, packages, themes 같은 프로젝트 코드를 로드하지 않습니다. 신뢰된 에이전트 프롬프트는 확장이 직접 전달합니다.

블로킹 실행에서 메인 에이전트가 받는 텍스트는 모드별 요약/결과 래퍼입니다: 단일은 한 실행 요약, 병렬은 작업 라벨과 성공/실패 요약, 체인은 단계 라벨과 완료/실패/완료+오류 요약입니다. 백그라운드 steer와 `status` 단건 조회의 결과/오류 텍스트 wrapper 형식과 바이트 상한은 [백그라운드 실행 계약](#백그라운드-실행-계약)을 참고하세요.

| 데이터 | 메인 에이전트 표시 | TUI 표시 |
| --- | --- | --- |
| 모드별 요약/결과 텍스트 | 예 | 예 |
| 하위 에이전트 본문 텍스트/도구 호출 | 아니요 | 예 |
| 토큰 사용량 / 비용 | 아니요 | 예 |
| 추론/thinking 단계 | 아니요 | 아니요 |
| 오류 메시지 | 실패 시 예 | 예 |

병렬/체인 TUI는 실행 중에도 Ctrl+O로 확장할 수 있습니다. 확장·접힘 모두 각 agent block에 수신된 usage와 model을 표시합니다. 실행 중 aggregate는 `Total so far`, 종료 뒤에는 `Total`이며 turns/input/output/cache/cost만 합산합니다. `ctx(last)`와 model은 agent별 값이므로 aggregate하지 않습니다. usage가 0이어도 알려진 model은 표시하며, 이 표시는 기존 child update와 기본 1초 병렬 heartbeat snapshot만 사용하므로 usage를 얻기 위한 추가 polling이나 query는 없습니다.

이 방식은 부모 컨텍스트를 깔끔하게 유지하면서도 TUI에서 자식 진행 상황을 확인할 수 있게 합니다. interactive child pane에서 사용자가 현재 turn을 Escape로 중단하면 이를 정상 완료로 오인하지 않습니다. cmux/tmux과 Herdr `split`의 부모 `cancel` 또는 session shutdown은 parent-owned exact pane/surface를 최종적으로 닫고, Herdr `auto`는 cooperative child shutdown 뒤 confirmed absence 또는 수동 recovery를 기다립니다.

## 사용량 회계

이 패키지의 Pi 최소 버전은 `>=0.80.10`이며, 사용량 회계는 Pi `0.81` 이상에서만 조건부로 적용됩니다. foreground(`background` 없음 또는 `false`)에서는 child assistant, nested tool, compaction, branch-summary generation usage를 모아 최종 `subagent` tool result의 top-level `usage`로 Pi 세션 총계에 전달합니다. interactive compaction의 `retainedTail` 재생분은 합산하지 않습니다. Background child의 완료 usage 회계는 명시적 비목표이므로 세션 총계에 포함하지 않으며, 완료 알림 뒤 새 부모 assistant 응답이 생성되면 그 부모 응답 자체의 usage만 일반 Pi assistant usage로 별도 집계됩니다. 범위와 acceptance 근거는 [Pi 0.81 subagent 사용량 회계](./pi-081-usage-accounting-design.md)를 참고하세요.

## 성능 작업 상태

현재 usage는 durable child session JSONL에서 얻어 TUI에 표시되는 값입니다. 상태는 다음처럼 구분합니다.

| 항목 | 현재 상태 |
| --- | --- |
| child usage/model TUI 표시 | 구현됨; 사용 가능한 snapshot만 표시 |
| usage를 얻기 위한 추가 poll/query/timer/provider 호출 | 미구현/금지 |
| periodic backend inspect polling 제거 | authenticated lifecycle socket과 durable `CompletionRecordV3`로 구현됨; lifecycle hint/terminal/degraded/final recovery에서는 completion JSON, session JSONL, wrapper status를 strict snapshot으로 계속 읽음 |
| cmux canonical control-socket adapter | 구현됨; production CLI fallback 없음 |
| cmux periodic inspect 제거와 tmux `-C` polling 제거 | healthy lifecycle cmux와 minimum gate를 통과한 tmux에서 구현됨; disconnect/degraded/final/reaper는 strict inspection 유지 |
| M0 local-child benchmark matrix | current-source-bound local evidence 생성됨; cmux/tmux transport는 `not-applicable` |
| Phase 0 gated provider live evidence | schema v4 two-tier capture가 완료됨. `routine-v1`은 총 5~6분, `cmux-concurrency-16-v1`은 약 8.2분으로 반복 관찰됐으며 SLA가 아님. source 변경 뒤에는 `test/fixtures/transport-performance-phase0-live-routine.json`과 `test/fixtures/transport-performance-phase0-live-concurrency.json`을 다시 생성하고 두 tier별 current-source verifier를 모두 통과해야 함 |

`bun run benchmark:phase0:preflight`은 non-mutating schema/runtime preflight이고 `bun run benchmark:phase0:verify`는 current-source-bound measured local evidence를 검증합니다. fixture 갱신은 고정 안전 workload만 실행하는 명시적 `bun run benchmark:phase0:record-local`로만 합니다. Phase 0 local, Phase 7 local, 그리고 두 live fixture는 하나의 generated evidence set으로 `sourceDirty`와 identity digest 양쪽에서 제외됩니다. 나머지 source/test/docs를 포함한 tracked/untracked content·mode는 현재 worktree와 대조합니다. 이 local evidence는 provider, cmux, tmux를 변경하지 않으며, layout 또는 crash/reaper acceptance의 historical PASS와도 별개입니다.

live preflight는 `bun run benchmark:phase0:live:preflight`로 수행합니다. provider-live는 caller `PATH`에서 Pi·tmux·cmux를 찾지 않으므로, native stable `>=0.81.1` Pi 및 canonical safe tmux/cmux executable의 절대 경로를 각 실행 앞에 `PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi`, `TMUX_BIN=/absolute/path/to/tmux`, `CMUX_BIN=/absolute/path/to/cmux`로 prefix해야 합니다. 이 환경 변수는 package script가 대신 설정하지 않습니다. Pi preflight generation은 private runtime root에 한 번 staged되어 각 credentialed cell이 그 staged native executable만 재검증·spawn하며, synthetic child runtime의 interpreter/backend resolution은 operator-sanitized `PATH`를 계속 신뢰하므로 trusted immutable entry만 포함해야 합니다. `routine-v1`은 `inline | tmux | cmux` × 다섯 workload × `activeRuns=1`, 즉 15 cells/15 provider children이며 반복 capture에서 총 5~6분이 관찰됐습니다. `cmux-concurrency-16-v1`은 `cmux` short-response `activeRuns=16` 한 cell/16 children이며 반복 capture에서 약 8.2분이 관찰됐습니다. 두 값은 SLA가 아닙니다. 모든 provider-backed record에는 `PI_SUBAGENT_PHASE0_LIVE=1`, `PI_SUBAGENT_PHASE0_LIVE_RECORD=1`, `--execute-live`, tier별 `--ack-provider-child-runs=15|16`가 필요하며, concurrency는 `PI_SUBAGENT_PHASE0_LIVE_CMUX16=1`과 `--ack-cmux-active-runs=16`도 필요합니다. fixed paths의 두 fixture를 각각 검증하려면 `bun run benchmark:phase0:live:routine:verify`와 `bun run benchmark:phase0:live:concurrency:verify`를, 둘을 함께 검증하려면 `bun run benchmark:phase0:live:verify`를 사용합니다.

routine만 `--max-cells=1..15` ordered-prefix checkpoint/resume을 허용합니다. resume root는 provider 실행 전에 claim되고 각 attempted cell 전 checkpoint가 terminalize되므로 one-use이며, recorded Pi version이 현재 preflight Pi version과 정확히 같고 source/tier/plan binding도 일치해야 합니다. backend version은 evidence나 resume continuity contract에 포함하지 않습니다. concurrency는 partial checkpoint/resume을 허용하지 않습니다. harness는 automatic retry를 하지 않습니다. routine/concurrency record 명령과 전체 규칙은 [transport 설계의 M0 harness 상태](./interactive-runtime-performance-design.md#m0-harness-상태)를 따릅니다. source/test/docs 변경은 **amend하지 않고** 먼저 commit하고, fixture를 regenerate한 뒤 생성물만 담은 fixture-only commit을 만드세요. fixture-only commit은 이전 effective source revision을 유지합니다. effective revision lookup에는 fixture를 제외한 source commit까지 도달 가능한 Git history가 필요합니다. fixture-only HEAD의 shallow/incomplete checkout은 fail closed하여 source revision lookup이 실패하고 HEAD를 source revision으로 취급하지 않으므로 CI에서는 full-history checkout을 사용해야 합니다. source 변경과 fixture가 섞인 commit은 revision을 전진시키므로 그 뒤 다시 regenerate하여 fixture-only commit을 새로 만들어야 합니다. 그 전의 fixture를 최종 검증 결과로 주장하지 않습니다. concurrency record는 명시적 수동 실행만 허용합니다.

Herdr pane title과 auto-tab label은 진단 정보일 뿐입니다. UI는 raw terminal title을 절대 노출하지 않고 managed title 상태(`matching`, `changed`, `unavailable`)만 표시합니다. 이동한 auto child는 자동으로 interrupt하거나 close하지 않습니다. exact terminal/socket authority를 다시 검증할 수 있으면 수동 focus는 계속 사용할 수 있습니다.
