# Pi Subagent

Pi에서 전문화된 하위 에이전트에게 작업을 위임하는 확장 패키지입니다. 단일 작업, 병렬 작업, 순차 체인을 모두 지원하며 컨텍스트 전달 방식과 실행 환경을 명확하게 제어할 수 있습니다.

저장소: <https://github.com/spi-ca/pi-subagent>

## 핵심 기능

- **전문화된 에이전트 위임** — 탐색, 계획, 구현, 리뷰처럼 역할이 다른 에이전트에게 작업을 맡길 수 있습니다.
- **컨텍스트 제어** — `spawn`은 새 컨텍스트로, `fork`는 현재 세션 컨텍스트를 복사해 실행합니다.
- **병렬 실행** — 서로 독립적인 작업을 여러 하위 에이전트로 동시에 실행합니다.
- **체인 실행** — 앞 단계의 요약을 다음 단계에 넘기며 순차 워크플로를 구성합니다.
- **실행 환경 자동 선택** — Zellij 안에서는 `zellij-pane`, 그 외 환경에서는 `inline`으로 실행합니다.
- **런타임 보호 장치** — 최대 위임 깊이와 순환 위임 방지로 재귀 실행 위험을 줄입니다.
- **프로젝트 에이전트 신뢰 확인** — `.pi/agents`의 프로젝트 로컬 에이전트는 명시적으로 승인된 뒤에만 사용합니다.

## 설치

Pi 설정 파일(보통 `~/.pi/agent/settings.json`)에 패키지를 추가합니다.

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

`source`에는 실제 체크아웃 경로를 넣습니다. 예를 들어 GitHub 저장소를 로컬로 받은 뒤 그 경로를 지정하면 됩니다.

```bash
git clone https://github.com/spi-ca/pi-subagent ~/.pi/agent/local-packages/pi-subagent
```

## 빠른 시작

에이전트는 YAML frontmatter가 있는 Markdown 파일로 정의합니다.

- 사용자 에이전트: `~/.pi/agent/agents/*.md`
- `PI_CODING_AGENT_DIR`를 설정한 경우: `$PI_CODING_AGENT_DIR/agents/*.md`
- 프로젝트 에이전트: `.pi/agents/*.md`

예시:

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
tools: read,write
---

You improve technical documentation for clarity, accuracy, and concision.
```

Pi 안에서 `subagent` 도구를 호출합니다.

단일 작업:

```json
{ "agent": "writer", "task": "Rewrite README.md", "mode": "spawn" }
```

병렬 작업:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect the local code structure" },
    { "agent": "reviewer", "task": "Review the documentation for gaps" }
  ],
  "mode": "spawn"
}
```

체인 작업:

```json
{
  "chain": [
    { "label": "discover", "agent": "scout", "task": "Summarize the codebase" },
    { "label": "plan", "agent": "planner", "task": "Create an implementation plan" }
  ],
  "mode": "spawn"
}
```

한 번의 호출에는 세 가지 형태 중 하나만 사용합니다: `agent`/`task`, `tasks`, `chain`.

## 주요 개념

### 컨텍스트 모드

| 모드 | 동작 | 권장 상황 |
| --- | --- | --- |
| `spawn` | 하위 에이전트 프롬프트와 `Task: ...`만 전달합니다. | 작업이 독립적이고 재현 가능해야 할 때 |
| `fork` | 현재 부모 세션 컨텍스트의 스냅샷과 `Task: ...`를 함께 전달합니다. | 이전 대화, 파일 읽기, 결정 사항이 필요한 후속 작업일 때 |

기본값은 `spawn`입니다.

### 실행 환경

확장이 현재 환경을 보고 자동으로 선택합니다.

- Zellij 내부: `zellij-pane`
- 그 외 환경: `inline`

### 위임 보호 장치

기본적으로 다음 보호 장치가 켜져 있습니다.

- 최대 깊이: `--subagent-max-depth` / `PI_SUBAGENT_MAX_DEPTH` (기본값 `3`)
- 순환 방지: `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles` / `PI_SUBAGENT_PREVENT_CYCLES` (기본값 `true`)

### 프로젝트 에이전트 신뢰

`.pi/agents/*.md`에 있는 프로젝트 에이전트는 해당 프로젝트 루트가 신뢰된 뒤에만 사용할 수 있습니다. 신뢰되지 않은 로컬 프롬프트가 부모 세션에 조용히 주입되는 일을 막기 위한 정책입니다.

## 문서

README는 진입점만 담고, 세부 내용은 주제별 문서로 나눕니다.

| 주제 | 문서 |
| --- | --- |
| 설치, 런타임 플래그, 신뢰 모델 | [`docs/configuration.md`](docs/configuration.md) |
| 도구 호출 형태와 예시 | [`docs/usage.md`](docs/usage.md) |
| 에이전트 파일 형식과 통신 모델 | [`docs/agents.md`](docs/agents.md) |
| 개발 워크플로와 프로젝트 구조 | [`docs/development.md`](docs/development.md) |
| 에이전트용 문서 작성 지침 | [`docs/guidelines/`](docs/guidelines/) |

## 로컬 개발

```bash
cd ~/.pi/agent/local-packages/pi-subagent
bun install
bun run ci
```

타입 체크는 이 체크아웃이 기존 Pi 설치 내부에 있고, `tsconfig.json`에서 참조하는 형제 Pi 패키지 경로가 존재한다고 가정합니다.

## 출처

이 패키지는 MIT 라이선스의 [`mjakl/pi-subagent`](https://github.com/mjakl/pi-subagent)를 기반으로 한 로컬 편집 가능한 포크에서 출발했습니다. [vaayne/agent-kit](https://github.com/vaayne/agent-kit)와 [mariozechner/pi-mono](https://github.com/badlogic/pi-mono)에서도 아이디어를 얻었습니다.

## 라이선스

MIT. 자세한 내용은 [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE)를 참고하세요.
