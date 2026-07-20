# `pi-subagent`와 `pi-cmux` 연동 가이드

> 상태: 현재 동작과 권장 운영 정책
>
> 이 문서는 cmux 안에서 `pi-subagent`와 [`pi-cmux`](https://github.com/javiermolinar/pi-cmux)를 함께 사용할 때의 역할, 설정, 제한을 설명한다. interactive pane의 내부 protocol과 lifecycle 구현은 [cmux/tmux 기반 실제 Pi TUI 설계 및 구현](./cmux-pi-tui-design.md)을 참고한다.

## 1. 결론

두 패키지는 함께 사용할 수 있다. 별도의 package API로 직접 결합하기보다 다음처럼 역할을 나누는 구성이 안전하다.

| 구성 요소 | 역할 |
|---|---|
| `pi-subagent` | subagent 위임, child surface 생성·종료, 결과 수집, 취소, lease와 orphan 정리 |
| `pi-cmux` | 각 Pi surface의 sidebar, progress, log, 알림과 사용자가 요청한 cmux 작업 흐름 |
| cmux | PTY, workspace, surface와 split 제공 |

핵심 원칙은 **실행과 lifecycle은 `pi-subagent`, surface별 사용자 경험은 `pi-cmux`가 담당한다**는 것이다. `pi-subagent`는 `pi-cmux`의 내부 모듈이나 `cmux_open_terminal`을 launcher로 사용하지 않는다.

```text
parent Pi
├─ pi-subagent
│  ├─ cmux surface 생성 및 stable ID 추적
│  ├─ child Pi 완료·결과 수집
│  └─ cancel, lease, reaper
└─ pi-cmux
   └─ parent surface UX

managed child Pi surface
├─ pi-subagent child bridge
│  └─ agent_settled 기준 semantic completion
└─ pi-cmux
   └─ child surface sidebar/progress/log
```

## 2. 사전 조건

- Pi `0.80.10` 이상
- cmux 안에서 실행 중인 Pi
- `pi-subagent`와 `pi-cmux`가 Pi package로 설치된 환경

`pi-cmux`는 다음과 같이 설치할 수 있다.

```bash
pi install npm:pi-cmux
```

Pi가 이미 실행 중이면 package를 반영한다.

```text
/reload
```

`pi-subagent`의 cmux interactive mode는 `CMUX_WORKSPACE_ID`와 `CMUX_SURFACE_ID`가 모두 **canonical UUID**일 때만 선택된다. 공백, 부분 값, `*_ref` 또는 malformed 값은 cmux identity가 아니며 tmux 조건을 다시 평가한 뒤 inline으로 처리한다. `pi-cmux`도 같은 cmux 환경 정보를 사용하지만, 두 패키지 사이에 직접적인 런타임 API 의존성은 없다.

## 3. 자동으로 함께 동작하는 부분

전역 `~/.pi/agent/settings.json`에 `pi-cmux`가 package로 등록되어 있고 child가 같은 agent directory와 설정을 사용하면, `pi-subagent`가 실행한 child Pi도 일반적으로 `pi-cmux` extension을 로드한다. 따라서 별도 연동 코드를 추가하지 않아도 child surface에서 sidebar, progress와 log가 표시될 수 있다.

다음 경우에는 extension 자동 로드 또는 sidebar 활성화를 보장할 수 없다.

- 부모 Pi를 `--no-extensions`로 실행한 경우
- child가 다른 agent directory 또는 다른 settings를 사용하는 경우
- cmux workspace 환경 정보가 없는 경우

child tool allowlist와 제외 목록은 `cmux_open_terminal` 같은 도구의 사용 가능 여부에는 영향을 주지만, `pi-cmux` extension 자체의 로드나 sidebar 활성화 여부를 결정하지는 않는다.

`pi-cmux`의 sidebar status key는 기본적으로 surface ID를 포함하므로 여러 child surface가 동시에 실행되어도 서로 다른 status entry를 사용한다.

## 4. lifecycle 경계

두 패키지는 완료를 판단하는 목적과 시점이 다르다.

| 이벤트/주체 | 의미 |
|---|---|
| `pi-cmux`의 `agent_end` 처리 | 현재 agent run의 sidebar 최종 표시, flash와 알림 생성 |
| `pi-subagent` child bridge의 `agent_settled` 처리 | retry, compaction retry와 queued follow-up까지 끝난 one-shot child의 semantic completion 확정 |

`agent_end` 뒤에도 자동 실행이 남을 수 있으므로 `pi-subagent`는 이를 child 종료 신호로 사용하지 않는다. 반대로 현재 `pi-cmux`의 sidebar와 알림은 `agent_end`에서 갱신되므로, 표시상 완료가 `pi-subagent`의 최종 완료보다 먼저 보일 수 있다.

이 차이는 결과 수집이나 surface cleanup의 정확성을 해치지 않는다. lifecycle의 source of truth는 계속 `pi-subagent`의 child bridge와 completion sidecar다.

## 5. 권장 운영 정책

다음은 managed child 전용 환경 주입이 **향후 구현된 뒤** 적용할 권장 정책이다. 현재 적용되는 정책이 아니다.

```text
sidebar/progress/log     유지
child 완료 알림         비활성화 권장
child 완료 flash        비활성화 권장
cmux_open_terminal      managed child에서 제외 권장
```

병렬 child마다 `agent_end` 알림과 flash를 발생시키면 알림이 과도해지고, semantic completion보다 이른 완료 신호를 줄 수 있다. `pi-cmux`가 지원하는 관련 환경 변수는 다음과 같다.

```bash
PI_CMUX_NOTIFY_LEVEL=disabled
PI_CMUX_SIDEBAR_FLASH=disabled
PI_CMUX_SIDEBAR_SOURCE=pi-subagent
```

다만 **현재 `pi-subagent`는 부모의 `PI_CMUX_NOTIFY_LEVEL`, `PI_CMUX_SIDEBAR_FLASH`, `PI_CMUX_SIDEBAR_SOURCE` 설정을 managed interactive child의 private environment로 전달하지 않는다.** 따라서 부모 환경에 이 값을 설정해도 child 알림이나 flash를 억제하는 child 전용 설정이 되지 않는다. 부모 알림은 유지하면서 child 알림만 끄는 profile이나 환경 주입은 아직 구현되지 않았다.

현재 선택지는 다음과 같다.

1. 부모 알림과 flash도 필요하지 않으면 부모 실행 환경에서 전체적으로 비활성화한다. 이는 child 전용 억제가 아니다.
2. 부모 알림이 더 중요하면 현재 설정을 유지하되, child의 `agent_end` 알림이 최종 settled 완료보다 이를 수 있음을 감안한다.
3. **향후 제안된** child 전용 profile 또는 managed-child 환경 주입이 구현된 뒤에만 child에 권장 정책을 적용한다.

## 6. `cmux_open_terminal`과 관리 범위

`pi-cmux`는 Pi가 명시적으로 요청받은 TUI나 장기 실행 command를 split 또는 tab에서 열 수 있도록 `cmux_open_terminal` 도구를 등록한다. 부모 Pi에서는 유용하지만, managed child가 이 도구로 만든 surface는 `pi-subagent`의 run registry 밖에 있다.

그 surface에는 다음 lifecycle이 적용되지 않는다.

- parent cancel에 따른 종료
- parent lease가 없거나 stale할 때의 정리
- startup reaper의 orphan 정리
- nested run의 leaf-first cleanup

따라서 managed child agent에는 명시적인 tool allowlist를 사용하고 `cmux_open_terminal`을 포함하지 않는 방식을 권장한다. Pi의 `--exclude-tools cmux_open_terminal`도 도구를 비활성화하지만, 부모 실행에 적용하면 부모에서도 사용할 수 없고 현재 `pi-subagent`는 child에만 이 옵션을 자동 추가하지 않는다.

`pi-cmux`의 `/cmv`, `/cmh`, `/cmo`, `/cmt`, continue/review 계열 command도 사용자가 별도 surface를 만드는 기능이다. child에서 사용자가 이러한 command를 직접 실행해 만든 surface는 **user-owned/unmanaged surface**로 간주해야 한다.

## 7. 왜 `pi-cmux`를 backend로 재사용하지 않는가

`cmux_open_terminal`과 `pi-cmux` 내부 split helper는 사용자 작업 흐름을 위한 API다. `pi-subagent`가 요구하는 다음 lifecycle contract를 제공하지 않는다.

- 생성한 surface의 stable handle 반환과 지속 추적
- child session 및 typed completion protocol
- parent cancel과 nested cancellation
- parent lease와 startup reaper
- child 결과와 usage 수집

따라서 `pi-subagent`는 cmux CLI를 직접 감싸 surface를 생성하고 추적한다. 이는 기능 중복이 아니라 책임 분리다. `pi-cmux`의 비공개 내부 모듈을 import하거나 extension 간 암묵적 API에 의존하지 않는다.

## 8. 확인 절차

1. cmux 안에서 부모 Pi를 실행한다.
2. 부모 shell에 두 환경 변수가 있는지 확인한다.

   ```bash
   test -n "$CMUX_WORKSPACE_ID" && test -n "$CMUX_SURFACE_ID" \\
     && printf '%s\n%s\n' "$CMUX_WORKSPACE_ID" "$CMUX_SURFACE_ID" | grep -Ex '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
   ```

3. `pi-cmux` 설치 후 `/reload`를 실행한다.
4. `pi-subagent`로 짧은 작업을 실행한다.
5. 다음을 확인한다.
   - 새 cmux surface에 실제 child Pi TUI가 표시된다.
   - child surface의 sidebar/progress가 독립적으로 갱신된다.
   - 작업 완료 후 parent에 subagent 결과가 반환된다.
   - child surface가 닫히고 managed run artifact가 정리된다.
6. 취소 검증에서는 parent에서 실행을 취소한 뒤 child surface가 남지 않는지 확인한다.

sidebar가 보이지 않으면 다음을 확인한다.

- child에 `CMUX_WORKSPACE_ID`가 전달되었는가
- `PI_CMUX_SIDEBAR=0`이 설정되어 있지 않은가
- child가 `pi-cmux` package를 실제로 로드했는가
- parent와 child가 같은 Pi agent directory/settings를 사용하는가

현재 부모 Pi의 알림이 너무 많으면 부모 실행 환경의 `PI_CMUX_NOTIFY_LEVEL`과 `PI_CMUX_SIDEBAR_FLASH`를 먼저 확인한다. 이 설정은 managed interactive child 전용 제어가 아니다.

## 9. 현재 제한과 후속 개선안

아래 기능은 모두 현재 구현된 동작이 아니라 `pi-subagent`만 수정하는 후속 개선안이다. `pi-cmux`, Pi core와 cmux 자체는 변경하지 않고, `pi-cmux`가 이미 지원하는 환경 변수와 Pi extension API, cmux CLI만 사용한다.

대부분 기존 `{ agent, task }`, `tasks`, `chain` 호출 계약을 변경하지 않고 session-level 정책, 자동 동작 또는 slash command로 추가할 수 있다. 구현 전에는 아래 권장값을 현재 기본 동작으로 간주하면 안 된다.

### 우선순위가 높은 기능

#### managed-child launch policy (향후 제안)

`PI_CMUX_PROFILE=subagent` 같은 외부 profile을 새로 요구하지 않고 `pi-subagent`가 managed child의 private environment에 기존 `pi-cmux` 설정을 직접 주입하는 **향후 제안**이다.

```bash
PI_CMUX_NOTIFY_LEVEL=disabled
PI_CMUX_SIDEBAR_FLASH=disabled
PI_CMUX_SIDEBAR_SOURCE=pi-subagent
```

child Pi 실행 시 `cmux_open_terminal`도 제외한다.

```text
--exclude-tools cmux_open_terminal
```

이 제안이 구현된 뒤의 예상 결과는 다음과 같다.

- child sidebar, progress와 log 유지
- child 알림과 flash 억제
- LLM이 unmanaged terminal surface를 만드는 것 방지
- parent의 `pi-cmux` 설정 유지
- 기존 subagent 호출 계약 유지

session-level 정책을 선택할 필요가 있으면 다음 환경 변수를 제안한다.

```bash
PI_SUBAGENT_CMUX_CHILD_POLICY=managed  # 권장 정책 적용
PI_SUBAGENT_CMUX_CHILD_POLICY=inherit  # 기존 환경 그대로 상속
```

`pi-cmux`를 수정하지 않으므로 `/cmv`, `/cmh`, review/continue 등 child에 등록된 slash command까지 선택적으로 제거할 수는 없다. 사용자가 child TUI에서 해당 command를 직접 실행해 만든 surface는 user-owned/unmanaged로 취급한다.

#### 단일 `/subagents` 관리 command

slash command는 하나만 등록하고 overlay와 subcommand로 모든 관리 기능을 제공한다.

```text
/subagents                   관리 overlay 열기
/subagents list              실행 목록
/subagents doctor            integration 진단
/subagents focus <run-id>    surface로 이동
/subagents cancel <run-id>   실행 취소
/subagents keep <run-id>     완료 후 보존
/subagents promote <run-id>  사용자 소유로 전환
```

인자 없이 실행하면 실행 중이거나 최근 완료된 child를 selector로 보여 준다.

```text
> scout       running     1m24s
  reviewer    running       48s
  worker      completed     12s
```

가능한 action은 다음과 같다.

- 해당 cmux surface로 이동
- foreground/background 실행 취소
- 최근 progress와 결과 확인
- run ID, depth와 elapsed time 확인
- surface 존재 여부와 stale allocation 진단
- 명시적인 keep/promote 선택

`pi-subagent`가 가진 active run registry와 stable surface ID를 사용하며 `pi-cmux`의 API는 필요하지 않다. Pi의 `registerCommand()`와 `ctx.ui.custom()`을 사용하고 surface 이동과 검사는 cmux CLI로 수행한다. subcommand completion은 command 실행 편의를 위한 UI이며 LLM tool schema에 추가하지 않는다.

#### parent compact status와 dashboard

`pi-cmux` native sidebar를 확장하지 않고 parent Pi의 status 또는 widget에 전체 실행 상태를 표시한다.

```text
subagents: ●3 ✓1 ✕0
```

상세 화면이 필요하면 `/subagents`에서 다음 정보를 제공한다.

```text
Subagents  3 running · 1 done
● scout       01:24  reading
● researcher  00:48  searching
◐ reviewer    00:11  waiting
```

표시 후보는 다음과 같다.

- agent 이름
- `running`, `completed`, `failed`, `cancelling` 상태
- elapsed time
- foreground/background 구분
- delegation depth
- 현재 surface 존재 여부
- token/cost 합계

parent 화면을 과도하게 차지하지 않도록 기본 status는 한 줄로 유지하고, 상세 정보는 selector에서 보여 주는 방식을 우선한다. TUI-only status/widget이므로 LLM context를 소비하지 않는다.

#### surface title 설정

surface 생성 시 `pi-subagent`가 이미 가진 정보로 짧은 title을 설정한다.

```text
subagent:scout:a14f82c1
subagent:reviewer:39bc730e
```

표시 정보는 agent name, run ID prefix와 필요할 경우 depth로 제한한다. task, prompt, secret 또는 긴 경로는 title에 넣지 않는다. 실행 중 상태를 계속 title에 반영하면 cmux command 호출이 잦아질 수 있으므로 첫 구현은 생성 시 title 설정만 수행한다.

#### `/subagents doctor` integration health 진단

별도 `/subagent-doctor` command를 등록하지 않고 단일 관리 command의 subcommand로 제공한다.

```text
/subagents doctor
```

다음 항목을 한 번에 확인한다.

- 현재 terminal mode
- `CMUX_WORKSPACE_ID`와 `CMUX_SURFACE_ID`
- cmux CLI와 필요한 capability
- 현재 interactive layout과 child launch policy
- child에 주입할 `PI_CMUX_*` 값
- active run과 surface 대응 상태
- stale launch record와 reaper 상태
- managed/user-owned/unmanaged 구분

`pi-cmux` extension의 실제 로드 여부는 Pi가 노출하는 tool/command metadata로 확인 가능한 범위만 진단한다. 공개 정보만으로 확정할 수 없는 상태는 `확인 불가` 또는 `추정`으로 표시하고 로드됐다고 단정하지 않는다.

### 기본 LLM context 최소화 원칙

slash command는 command registry와 autocomplete에 등록되지만 기본 system prompt나 tool schema에는 포함되지 않는다. 따라서 command를 하나로 합치는 주된 목적은 command 목록과 사용자 interface를 단순화하는 것이며, model input token 감소 효과는 크지 않다.

기본 context 증가는 다음 원칙으로 방지한다.

1. 관리용 LLM tool을 새로 등록하지 않는다. `subagent_manage`, `subagent_doctor`, `subagent_focus` 같은 별도 tool schema를 추가하지 않는다.
2. 기존 `SubagentParams`에 layout, dashboard 또는 관리 field를 추가하지 않는다.
3. `/subagents` 사용 안내를 `before_agent_start` system prompt에 추가하지 않는다.
4. status와 activity를 `pi.sendMessage()`로 전달하지 않는다. custom message는 LLM context에 참여하므로 사용하지 않는다.
5. parent 표시에는 `ctx.ui.setStatus()`, `ctx.ui.setWidget()`과 `/subagents` overlay를 사용한다.
6. 영속적인 TUI-only 기록이 필요하면 `pi.appendEntry()`와 `registerEntryRenderer()`를 사용한다.
7. dashboard, surface와 doctor 상세 정보를 기존 `subagent` tool result에 항상 추가하지 않고 command가 호출될 때만 계산·표시한다.
8. child에서는 `cmux_open_terminal`을 제외해 불필요한 tool schema가 child model context에 들어가지 않게 한다.

현재 기본 context의 주요 비용은 slash command가 아니라 `subagent` tool schema와 `before_agent_start`에서 주입하는 agent 목록, depth/cycle guard다. 이번 개선안은 이 두 계약을 확장하지 않는다.

다음 기능은 TUI 또는 runtime 내부 상태만 사용하므로 기본 LLM context를 늘리지 않는다.

- managed-child 환경 변수와 tool 제외
- parent compact status/widget
- surface title과 cmux surface 이동
- active run registry와 private sidecar
- `/subagents` overlay와 doctor 화면
- keep/promote ownership metadata

### 후순위 기능

#### 최근 child activity 미리보기

선택한 child의 최근 이벤트만 parent widget 또는 `/subagents` 상세 화면에 표시한다.

```text
scout
  read src/runtime/runner.ts
  grep InteractivePaneHandle
  examining cancellation path
```

이를 위해 child bridge가 안전하게 축약한 progress event를 sidecar에 기록하고 parent가 읽는다. 전체 transcript나 tool output 전문은 복제하지 않고 다음 정보만 허용한다.

- tool 이름
- 안전하게 축약한 대상
- 현재 phase
- 마지막 갱신 시각

sidecar에는 기존 private artifact 권한, 크기 제한과 cleanup 정책을 적용한다. 데이터는 LLM context에 넣지 않고 TUI-only로 처리한다.

#### 완료 surface의 명시적 보존과 승격

기본 자동 cleanup은 유지하되 사용자가 실행 중인 child를 미리 보존 대상으로 지정할 수 있다.

```text
/subagents keep <run-id>
/subagents promote <run-id>
```

승격 시 해당 surface를 정상 cleanup과 startup reaper 대상에서 제외하고 ownership을 사용자에게 넘긴다. 완료 후 선택하도록 만들려면 cleanup grace period가 필요하고 lifecycle 및 orphan 정책이 복잡해지므로 가장 나중에 구현한다.

### 이번 범위에서 제외할 기능

`pi-subagent`만 수정한다는 원칙에 따라 다음 항목은 후속안에서 제외한다.

- `PI_CMUX_PROFILE=subagent` 추가
- `pi-cmux`의 tool 또는 slash command 등록 제어
- `pi-cmux` native sidebar에 parent dashboard 삽입
- `pi-cmux` notification renderer나 내부 module 재사용
- extension 간 공개 event contract
- `pi-cmux:surface-ready` 같은 신규 외부 event
- Pi core 또는 cmux 자체 수정

parent 집계 알림도 우선 구현하지 않는다. foreground 실행은 parent의 기존 `pi-cmux` 완료 알림과 중복될 수 있고, background completion은 steer 이후 parent run 알림과 겹칠 수 있기 때문이다. **향후 제안된** managed-child 알림 억제와 parent의 기존 알림을 먼저 적용 대상으로 삼는다.

다음 일반 기능은 이미 `pi-cmux`가 제공하므로 `pi-subagent`에서 중복 구현하지 않는다.

- 일반 command를 split/tab에서 실행
- zoxide directory 이동
- 수동 review session 생성
- continuation/handoff
- worktree 생성
- general-purpose cmux split command

### 추천 구현 순서

1. managed-child 환경 및 tool 정책
2. 단일 `/subagents` 관리 command와 `doctor` subcommand
3. parent compact status/widget
4. surface title 설정
5. activity preview
6. keep/promote

가장 효과가 큰 후속 조합은 managed-child policy, `/subagents`와 parent compact status다. interactive layout은 이미 구현되어 있으며, [다중 subagent interactive pane layout 설계](./interactive-pane-layout-design.md)의 정적 테스트 범위와 live 검증 상태를 따른다. cmux와 tmux `auto` smoke는 2026-07-20에 모두 **PASS**했지만, tmux는 제한된 3 top-level + parent/2 nested smoke 범위다. 기존 tmux crash/reaper **PASS**는 별도 acceptance이며 이 layout 검증을 대체하지 않는다.

## 10. 관련 문서

- [cmux/tmux 기반 실제 Pi TUI 설계 및 구현](./cmux-pi-tui-design.md): interactive pane protocol, session tail, completion, lease와 reaper
- [다중 subagent interactive pane layout 설계](./interactive-pane-layout-design.md): 구현된 cmux shared-pane/마지막 surface retire 정책과 layout 검증 상태 — cmux와 tmux `auto` live smoke 모두 2026-07-20 **PASS**(tmux는 제한된 smoke 범위)
- [사용법](./usage.md): subagent 호출과 terminal mode의 사용자 동작
- [설정](./configuration.md): terminal mode 감지와 관련 설정
- [`pi-cmux` README](https://github.com/javiermolinar/pi-cmux): 설치, command와 전체 환경 변수
