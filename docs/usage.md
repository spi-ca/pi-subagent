# 사용법

`subagent` 도구는 단일, 병렬, 체인 세 가지 호출 형태를 지원합니다. 한 번의 호출에는 정확히 하나의 형태만 사용합니다.

## 단일 모드

단일 모드는 하나의 집중된 작업을 위임할 때 사용합니다.

```json
{ "agent": "writer", "task": "Document the API", "mode": "spawn" }
```

필수 필드:

- `agent`: 사용 가능한 에이전트 파일의 이름과 정확히 일치하는 하위 에이전트 이름
- `task`: 자식 에이전트에게 전달할 독립적인 작업 프롬프트

선택 필드:

- `mode`: `spawn` 또는 `fork`; 기본값은 `spawn`
- `cwd`: 자식 프로세스의 작업 디렉터리

## 병렬 모드

병렬 모드는 서로 독립적인 작업을 동시에 실행할 때 사용합니다.

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect API routes" },
    { "agent": "security-reviewer", "task": "Review auth and secret handling" },
    { "agent": "reviewer", "task": "Check maintainability risks" }
  ],
  "mode": "spawn"
}
```

동작:

- 하위 에이전트를 동시에 실행하며, 한 번에 최대 4개까지 실행합니다.
- 한 번의 호출에는 최대 8개 작업을 받을 수 있습니다.
- 최상위 `mode`가 모든 작업에 적용됩니다.
- 모든 작업이 끝나면 부모 에이전트가 결합된 결과를 받습니다.
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
        { "agent": "researcher", "task": "Check external docs" }
      ]
    },
    { "label": "plan", "agent": "planner", "task": "Create a plan from discovery outputs" },
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
- 한 번의 호출에는 최대 8개 단계를 받을 수 있습니다.
- 한 단계는 순차 에이전트 단계이거나 병렬 그룹일 수 있습니다.
- 병렬 단계는 자식 프로세스를 동시에 최대 4개까지 실행하고, 최대 8개 작업을 받을 수 있습니다.
- 최상위 `mode`가 모든 단계와 작업에 적용됩니다.
- 첫 번째 이후의 각 단계는 이전 단계 요약을 현재 작업 앞에 전달받습니다.
- 실패한 단계가 있으면 기본적으로 체인을 중단합니다. 단, 해당 단계에 `continueOnError: true`가 있으면 계속 진행합니다.

순차 단계 필드:

- `label` — 선택적 단계 이름. 라벨을 쓰는 경우 중복될 수 없습니다.
- `agent` — 하위 에이전트 이름
- `task` — 작업 프롬프트
- `cwd` — 선택적 작업 디렉터리
- `condition` — `always`, `on_success`, `on_error`, `on_completed_with_errors`
- `continueOnError` — 이 단계가 실패해도 뒤 단계를 계속 실행

병렬 단계 필드:

- `type: "parallel"`
- `label` — 선택적 단계 이름. 라벨을 쓰는 경우 중복될 수 없습니다.
- `tasks` — `{ agent, task, cwd? }` 배열
- `condition` — `always`, `on_success`, `on_error`, `on_completed_with_errors`
- `continueOnError` — 하나 이상의 병렬 작업이 실패해도 뒤 단계를 계속 실행

## 권장 패턴

- 코드베이스 정찰 뒤 계획이 필요하면 `scout -> planner`를 사용합니다.
- 로컬 사실과 외부 문서를 독립적으로 모을 수 있으면 `scout + researcher -> planner`를 사용합니다.
- 구현 뒤 검토가 필요하면 `worker -> reviewer + security-reviewer`를 사용합니다.
- 모든 작업이 독립적이면 최상위 병렬 모드를 사용합니다.
- 뒤 작업이 앞 작업의 요약을 필요로 하면 체인 모드를 사용합니다.

## 결과 가시성

각 하위 에이전트는 별도의 `pi` 프로세스에서 실행됩니다. 메인 에이전트는 각 하위 에이전트의 최종 assistant 텍스트만 받습니다.

| 데이터 | 메인 에이전트 표시 | TUI 표시 |
| --- | --- | --- |
| 최종 텍스트 출력 | 예, 전체 출력 | 예 |
| 하위 에이전트의 도구 호출 | 아니요 | 예 |
| 토큰 사용량 / 비용 | 아니요 | 예 |
| 추론/thinking 단계 | 아니요 | 아니요 |
| 오류 메시지 | 실패 시 예 | 예 |

이 방식은 부모 컨텍스트를 깔끔하게 유지하면서도 TUI에서 자식 진행 상황을 확인할 수 있게 합니다.
