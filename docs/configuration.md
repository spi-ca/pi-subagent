# 설정

이 패키지는 Pi의 로컬 편집 가능 확장 패키지로 사용할 수 있습니다.

## 로컬 패키지로 설치

사용자 수준 Pi 설정 파일(보통 `~/.pi/agent/settings.json`)에 패키지 디렉터리를 추가합니다.

```json
{
  "packages": [
    {
      "source": "~/.pi/agent/local-packages/pi-subagent",
      "extensions": ["+index.ts"]
    }
  ]
}
```

`source`에는 실제 체크아웃 경로를 넣습니다. Pi는 로컬 패키지 디렉터리를 직접 로드하므로 npm publish 단계가 필요하지 않습니다.

## 위임 보호 장치

이 확장은 기본적으로 두 가지 런타임 보호 장치를 적용합니다.

### 깊이 제한

`--subagent-max-depth`는 하위 에이전트가 다른 하위 에이전트에게 다시 위임할 수 있는 깊이를 제어합니다.

- 기본값: `3`
- 메인 에이전트는 깊이 `0`에서 시작합니다.
- `currentDepth < maxDepth`인 동안 위임할 수 있습니다.
- 기본 깊이에서는 `0`, `1`, `2` 깊이가 위임할 수 있고, `3` 깊이는 위임할 수 없습니다.

다음 중 하나로 설정합니다.

- CLI 플래그: `--subagent-max-depth <n>`
- 환경 변수: `PI_SUBAGENT_MAX_DEPTH=<n>`

`n`은 0 이상의 정수여야 합니다.

예시:

```bash
# 기본 동작: 깊이 3 + 순환 방지 켜짐
pi

# 중첩을 한 단계로 제한: main -> child -> grandchild
pi --subagent-max-depth 2

# 하위 에이전트 위임을 완전히 비활성화
pi --subagent-max-depth 0
```

### 순환 방지

`--subagent-prevent-cycles`는 현재 위임 스택에 이미 있는 에이전트 이름으로 다시 위임하는 것을 막습니다. `writer -> writer` 같은 자기 재귀와 `planner -> reviewer -> planner` 같은 순환을 방지합니다.

- 기본값: `true`
- CLI 플래그: `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles`
- 환경 변수: `PI_SUBAGENT_PREVENT_CYCLES=true|false`

```bash
# 깊이 3은 유지하되 순환 방지를 끕니다. 권장하지 않습니다.
pi --subagent-max-depth 3 --no-subagent-prevent-cycles
```

## 컨텍스트 모드

`subagent` 도구는 최상위 `mode` 옵션을 받습니다.

| 모드 | 동작 | 사용 시점 |
| --- | --- | --- |
| `spawn` | 하위 에이전트 프롬프트와 `Task: ...`만 전달합니다. | 위임 작업이 독립적일 때 |
| `fork` | 현재 부모 세션의 스냅샷과 `Task: ...`를 함께 전달합니다. | 위임 작업이 이전 대화, 파일 읽기, 결정 사항에 의존할 때 |

`mode`를 생략하면 `spawn`이 기본값입니다.

## 실행 환경

확장은 현재 환경에 따라 실행 방식을 선택합니다.

- Zellij 내부: `zellij-pane`
- Zellij 외부: `inline`

Zellij pane 실행에서는 pane 제목을 다음처럼 정합니다.

- 명시적 라벨이 있는 체인 단계: `label(agent)`
- 라벨이 없는 체인 단계: `step-N(agent)`
- 체인이 아닌 실행: `subagent-agent`
- 병렬 실행에서 구분이 필요할 때: ` #N` 접미사 추가

## 프로젝트 에이전트 신뢰

프로젝트 에이전트는 `.pi/agents/*.md`에 둡니다. 가장 가까운 `.pi/agents` 디렉터리를 소유한 정확한 canonical 프로젝트 루트가 신뢰된 뒤에만 사용할 수 있습니다.

주요 동작:

- 신뢰가 부여되면 프로젝트 에이전트가 이름 충돌에서 우선합니다.
- 신뢰되지 않은 프로젝트에서는 프로젝트 에이전트 메타데이터를 메인 프롬프트에 노출하지 않습니다.
- 숨겨진 프로젝트 에이전트 이름 충돌은 프로젝트가 신뢰되거나 충돌 에이전트 이름이 바뀔 때까지 차단됩니다.
- 프로젝트 루트 경계를 벗어나는 realpath를 가진 `.pi/agents` 디렉터리나 에이전트 파일은 발견 단계에서 거부됩니다.
- 새로 신뢰된 프로젝트 에이전트는 즉시 실행 가능해지며, 부모 프롬프트에 표시되는 하위 에이전트 목록은 다음 최상위 턴에서 갱신됩니다.

신뢰 근거는 다음에서 올 수 있습니다.

- 정확한 루트가 저장된 `trust.json` 항목
- 이 확장이 세션 중 추적하는 명시적 승인 또는 거부
- 현재 가장 가까운 프로젝트 에이전트 루트에 대한 명시적 `--approve` / `--no-approve`

Pi의 일반적인 boolean 프로젝트 신뢰 상태는 충분한 근거로 보지 않습니다. Pi가 그 신뢰가 어떤 루트에 적용되는지 노출하지 않기 때문입니다.

## 내부 환경 변수

확장은 다음 내부 환경 변수를 관리하고 자식 프로세스에 전달합니다.

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_STACK` — 조상 에이전트 이름의 JSON 배열. 예: `["scout","planner"]`
- `PI_SUBAGENT_PREVENT_CYCLES`
- `PI_SUBAGENT_TRUSTED_PROJECTS` — 세션 중 임시 승인된 canonical 프로젝트 루트의 JSON 배열
- `PI_SUBAGENT_DENIED_PROJECTS` — 세션 중 임시 거부된 canonical 프로젝트 루트의 JSON 배열

다른 확장이 위임된 하위 에이전트 프로세스 안에서 실행 중인지 확인해야 한다면 `PI_SUBAGENT_DEPTH`를 확인하세요. `PI_SUBAGENT_DEPTH > 0`이면 "이 Pi 프로세스는 하위 에이전트"로 취급하면 됩니다.
