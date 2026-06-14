# 에이전트

하위 에이전트는 YAML frontmatter가 있는 Markdown 파일입니다. Frontmatter는 Pi가 에이전트를 어떻게 노출하고 실행할지 설명하고, Markdown 본문은 에이전트의 시스템 프롬프트가 됩니다.

## 에이전트 위치

- 사용자 에이전트 기본 위치: `~/.pi/agent/agents/*.md`
- 설정 디렉터리 오버라이드 사용 시: `$PI_CODING_AGENT_DIR/agents/*.md`
- 프로젝트 에이전트: `.pi/agents/*.md`

`PI_CODING_AGENT_DIR`가 설정되어 있으면 확장은 사용자/전역 에이전트 위치로 `~/.pi/agent/agents` 대신 `$PI_CODING_AGENT_DIR/agents`를 사용합니다. 프로젝트 에이전트는 신뢰 확인 뒤 별도로 함께 로드됩니다.

## 예시

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
thinking: medium
tools: read,write
---

You are an expert technical writer. Improve clarity, accuracy, and concision.
```

## Frontmatter 필드

| 필드 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `name` | 예 | — | 도구 호출에서 사용하는 에이전트 식별자입니다. 정확히 일치해야 합니다. |
| `description` | 예 | — | 메인 에이전트에게 표시되는 짧은 역량 설명입니다. |
| `model` | 아니요 | Pi 기본 모델 | 이 에이전트에 사용할 모델 오버라이드입니다. `anthropic/...`, `openrouter/...` 같은 provider 접두사를 지원합니다. |
| `thinking` | 아니요 | Pi 기본 thinking 수준 | Thinking 수준입니다: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `tools` | 아니요 | `read,bash,edit,write` | 이 에이전트에 활성화할 내장 도구의 쉼표 구분 목록입니다. |

참고:

- `model`은 여러 provider가 같은 모델 ID를 제공할 때 `provider/model` 문법을 사용할 수 있습니다.
- 역할에 예측 가능한 추론 예산이 필요하면 `thinking`을 명시적으로 설정하세요.
- `tools`는 내장 도구만 제어합니다. 확장이 비활성화되지 않았다면 확장 도구는 여전히 사용 가능할 수 있습니다.
- Markdown 본문은 Pi의 기본 시스템 프롬프트에 추가됩니다. 기본 시스템 프롬프트를 대체하지 않습니다.

## 좋은 에이전트 파일 작성법

- `description`을 구체적으로 적으세요. 부모 에이전트가 하위 에이전트 호출 여부를 결정할 때 사용합니다.
- 프롬프트는 역할 중심으로 유지하세요. 전역 에이전트 지침에 속하는 넓은 규칙은 피합니다.
- 편집 가능한 에이전트에는 필요한 도구만 부여하세요.
- `scout`, `reviewer`, `security-reviewer` 같은 역할에는 읽기 전용 도구를 우선 사용하세요.
- 역할별 품질 또는 비용 요구가 분명하면 `model`과 `thinking` 오버라이드를 사용하세요.

## 내장 도구 이름

일반적인 내장 도구:

- `read` — 파일 내용 읽기
- `bash` — 셸 명령 실행
- `edit` — find/replace 방식으로 파일 편집
- `write` — 파일 생성 또는 덮어쓰기
- `grep` — 파일 내용 검색
- `find` — glob 패턴으로 파일 찾기
- `ls` — 디렉터리 내용 나열

읽기 전용 에이전트에는 `read,find,ls,grep`를 사용하세요. 에이전트가 변경을 만들거나 명령을 실행해야 할 때만 `bash`, `edit`, `write`를 포함하세요.

## 통신 모델

각 하위 에이전트는 별도의 `pi` 프로세스에서 실행됩니다.

하위 에이전트는 부모 프로세스나 형제 하위 에이전트와 live memory/state를 공유하지 않습니다. `mode`가 선택한 컨텍스트만 받고, 최종 assistant 텍스트를 부모에게 반환합니다.

### `spawn` 모드

자식은 다음을 받습니다.

```text
[Subagent system prompt]

User: Task: ...
```

부모 대화 기록은 포함되지 않습니다.

### `fork` 모드

자식은 다음을 받습니다.

```text
[Forked parent session context]
[Subagent system prompt]

User: Task: ...
```

현재 세션 기록에 의존하는 작업에만 `fork`를 사용하세요.

## 스타터 에이전트

사용자 또는 프로젝트 하위 에이전트를 찾을 수 없으면 확장은 활성 사용자 에이전트 디렉터리에 `explorer`라는 스타터 에이전트를 만듭니다.

- 기본 위치: `~/.pi/agent/agents/explorer.md`
- `PI_CODING_AGENT_DIR` 설정 시: `$PI_CODING_AGENT_DIR/agents/explorer.md`

스타터 에이전트는 읽기 전용이며, 집중적인 코드베이스 탐색을 위한 것입니다. 기존 파일은 절대 덮어쓰지 않습니다.
