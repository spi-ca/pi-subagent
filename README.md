# Pi Subagent

Pi에서 전문화된 하위 에이전트에게 작업을 위임하는 확장 패키지입니다.

저장소: <https://github.com/spi-ca/pi-subagent>

> Presence는 shared [`@pi/presence` protocol (v2-20260907-1)](https://github.com/spi-ca/pi-presence/tree/v2-20260907-1)을 사용하며, 네 extension이 동일한 `github:spi-ca/pi-presence#v2-20260907-1` release tag를 사용합니다.

## 제공 기능

- 단일 작업, 병렬 작업, 순차 체인을 `spawn` 또는 `fork` 컨텍스트로 위임합니다.
- 호출마다 모델을 선택할 수 있으며, 병렬·체인에서는 각 작업 항목의 `model`이 에이전트 파일 기본값을 덮어씁니다.
- `background: true`는 즉시 반환하고 최종 결과를 steer 메시지로 전달합니다.
- cmux, Herdr, tmux에서는 interactive child Pi TUI를 사용하고, 다른 환경에서는 inline으로 실행합니다. 자동 선택과 안전한 실패 경계는 [설정](docs/configuration.md#실행-환경)을 참고하세요.
- Linux/macOS에서는 root parent와 nested child를 합친 tree-wide active cap을 적용합니다. Windows는 process-local scheduler로 fallback합니다.
- 프로젝트 `.pi/agents`는 Pi가 현재 프로젝트를 신뢰한 경우에만 사용합니다.

## 설치

검토된 immutable release `v20260909-1`을 설치합니다.

```bash
pi install git:github.com/spi-ca/pi-subagent@v20260909-1
```

이 명령은 사용자 설정 `~/.pi/agent/settings.json`에 패키지를 추가하고 저장소를 `~/.pi/agent/git/github.com/spi-ca/pi-subagent` 아래에 클론합니다.

```json
{
  "packages": ["git:github.com/spi-ca/pi-subagent@v20260909-1"]
}
```

프로젝트 설정 `.pi/settings.json`에 설치하려면 `-l`을 사용합니다.

```bash
pi install -l git:github.com/spi-ca/pi-subagent@v20260909-1
```

개발 branch를 추적하는 설치와 설정 파일·CLI·환경 변수의 우선순위는 [설정](docs/configuration.md)을 참고하세요.

## 빠른 시작

먼저 사용자 에이전트 파일 `~/.pi/agent/agents/writer.md`를 만듭니다. 이 패키지가 기본 에이전트를 제공하지 않으므로, 사용할 에이전트는 직접 정의해야 합니다.

```markdown
---
name: writer
description: Technical writer and editor
tools: read,write
---

Improve documentation for clarity and accuracy.
```

Pi에서 첫 작업을 위임합니다.

```json
{ "agent": "writer", "task": "Rewrite README.md" }
```

`mode`를 생략하면 독립된 새 컨텍스트의 `spawn`이 기본값입니다. 현재 대화의 파일 읽기나 결정을 이어야 할 때만 `"mode": "fork"`를 추가하세요.

| 모드 | 전달되는 컨텍스트 | 적합한 작업 |
| --- | --- | --- |
| `spawn` | 에이전트 프롬프트와 작업 | 독립적이고 재현 가능한 작업 |
| `fork` | 현재 부모 세션 스냅샷, 에이전트 프롬프트와 작업 | 이전 대화·결정에 의존하는 후속 작업 |

단일·병렬·체인 호출, 모델과 `cwd` 지정은 [사용법](docs/usage.md)을 참고하세요.

### 백그라운드 작업

긴 작업에는 최상위 `background: true`를 추가할 수 있습니다.

```json
{ "agent": "writer", "task": "Draft release notes", "background": true }
```

이 호출은 즉시 반환합니다. 결과가 도착하기 전에 결과를 만들거나 요약하지 말고, 반복 polling·sleep·로그 tail·대기 루프를 사용하지 마세요. 독립 작업을 계속하거나 턴을 끝내면 완료·실패·취소 결과가 steer 메시지로 자동 전달됩니다. 현재 프로세스의 작업은 `subagent({ action: "status" })`와 `subagent({ action: "cancel", id })`로 확인·취소할 수 있습니다. 보존 범위와 결과 wrapper를 포함한 정확한 계약은 [백그라운드 실행](docs/usage.md#백그라운드-실행-계약)을 참고하세요.

## 실행과 신뢰 경계

명시적 `PI_SUBAGENT_TERMINAL_MODE`가 없으면 실행 환경은 **cmux → Herdr → tmux → inline** 순으로 선택합니다. terminal backend를 선택한 뒤 검증에 실패하면 다른 backend나 inline으로 조용히 바꾸지 않습니다. `PI_SUBAGENT_TERMINAL_MODE`, `auto`/`split` layout, Pi 최소 버전과 문제 해결은 [실행 환경](docs/configuration.md#실행-환경)을 참고하세요.

기본 보호 장치는 최대 위임 깊이 `5`, 순환 위임 방지, 호출 크기·동시성·백그라운드 한계입니다. 프로젝트 에이전트와 프로젝트 `pi-subagent.json`은 신뢰된 프로젝트에서만 읽습니다. 정확한 우선순위와 제한값은 [설정](docs/configuration.md)을 참고하세요.

## 문서

| 목적 | 문서 |
| --- | --- |
| 에이전트 파일 위치·frontmatter·도구 allowlist | [`docs/agents.md`](docs/agents.md) |
| 호출 형태, 입력 검증, 상태·취소 | [`docs/usage.md`](docs/usage.md) |
| 설치, 한계, 신뢰, terminal 환경 | [`docs/configuration.md`](docs/configuration.md) |
| 개발·검증·evidence 규칙 | [`docs/development.md`](docs/development.md) |
| 설계·연동 문서를 포함한 전체 목록 | [`docs/README.md`](docs/README.md) |

이 저장소 자체를 편집하는 코딩 에이전트 규칙은 [`AGENTS.md`](AGENTS.md)입니다.

## 로컬 개발

```bash
bun install --frozen-lockfile
bun run ci
```

일반 CI와 실제 terminal/provider를 사용하는 opt-in acceptance의 차이, evidence 해석과 실행 승인 규칙은 [`docs/development.md`](docs/development.md)를 참고하세요.

## 출처와 라이선스

이 패키지는 MIT 라이선스의 [`mjakl/pi-subagent`](https://github.com/mjakl/pi-subagent)를 기반으로 한 로컬 편집 가능한 포크에서 출발했습니다. [vaayne/agent-kit](https://github.com/vaayne/agent-kit)와 [mariozechner/pi-mono](https://github.com/badlogic/pi-mono)에서도 아이디어를 얻었습니다.

MIT 라이선스입니다. 상세 내용은 [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE)를 참고하세요.
