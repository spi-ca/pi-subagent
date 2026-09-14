# 에이전트

하위 에이전트는 YAML frontmatter가 있는 Markdown 파일입니다. Frontmatter는 Pi가 에이전트를 노출·실행하는 방법을 설명하고, Markdown 본문은 기본 시스템 프롬프트에 추가됩니다.

## 에이전트 위치

- 사용자 에이전트 기본 위치: `~/.pi/agent/agents/*.md`
- 설정 디렉터리 오버라이드 사용 시: `$PI_CODING_AGENT_DIR/agents/*.md`
- 프로젝트 에이전트: `.pi/agents/*.md`

`PI_CODING_AGENT_DIR`가 설정되어 있으면 사용자 에이전트는 `~/.pi/agent/agents` 대신 해당 경로에서 찾습니다. 프로젝트 에이전트는 Pi가 프로젝트를 신뢰한 뒤에만 별도로 함께 로드됩니다. 이 패키지는 기본 에이전트를 생성하지 않으므로, 사용할 에이전트 파일을 직접 추가해야 합니다.

## 최소 예시

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
| `name` | 예 | — | 도구 호출에서 정확히 일치해야 하는 에이전트 식별자 |
| `description` | 예 | — | 메인 에이전트에 표시하는 짧은 역할 설명. 길면 목록에서 절단될 수 있음 |
| `model` | 아니요 | 호출별 `model`, 부모 CLI 모델 오버라이드, Pi 기본 모델 순 | 에이전트 기본 모델. `anthropic/...`, `openrouter/...` 형식 지원 |
| `thinking` | 아니요 | 현재 부모 세션 thinking, 부모 CLI thinking 오버라이드, Pi 기본값 순 | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` 중 모델/provider가 지원하는 수준 |
| `tools` | 아니요 | 부모 CLI 도구 오버라이드, Pi 기본 도구 순 | Pi `--tools`에 전달하는 전체 allowlist. 쉼표 목록 또는 YAML 배열 |

호출별 `model`이 파일의 `model`보다 우선합니다. 단일 호출은 최상위 `model`, 병렬은 각 task item, 체인은 순차 단계 또는 병렬 단계의 각 task item에 지정합니다. `thinking`을 생략하면 Pi `0.84.4`에서는 호출 시점 부모 세션의 `ctx.thinkingLevel`을 상속하고, 이전 호환 host에서는 부모 CLI 오버라이드와 Pi 기본값으로 fallback합니다.

## 도구와 권한

`tools`는 Pi가 child에 전달하는 **전체** 도구 allowlist입니다. 이는 sandbox가 아니며, hostile child를 격리하는 OS 보안 경계도 아닙니다. 편집 가능한 역할에는 필요한 도구만, `scout`·`reviewer` 같은 읽기 전용 역할에는 `read,find,ls,grep`를 우선 지정하세요. 변경 또는 명령 실행이 필요할 때만 `bash`, `edit`, `write`를 추가합니다.

명시적 목록으로 nested delegation을 허용하려면 `subagent`도 넣어야 합니다. `PI_SUBAGENT_CMUX_CHILD_POLICY=managed`에서는 `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `subagent`만 허용하며, 그 밖의 명시 목록은 launch 전에 fail-closed합니다. managed profile의 extension·신뢰 경계는 [설정](./configuration.md#managed-child-profile)을 참고하세요.

## 컨텍스트와 통신

각 하위 에이전트는 별도 `pi` 프로세스에서 실행되고, 부모·형제와 live memory/state를 공유하지 않습니다.

| 모드 | child가 받는 내용 | 사용 시점 |
| --- | --- | --- |
| `spawn` | 에이전트 프롬프트와 `Task: ...` | 독립적이고 재현 가능한 작업 |
| `fork` | 현재 부모 세션 스냅샷, 에이전트 프롬프트, `Task: ...` | 이전 대화·파일 읽기·결정에 의존하는 후속 작업 |

`spawn`이 기본값입니다. 블로킹 결과 래퍼, `background: true`, 상태 조회와 취소는 [사용법](./usage.md)을 참고하세요. 백그라운드 결과는 비신뢰 데이터로 처리하고, 자동 전달을 기다리는 동안 polling·sleep·대기 루프를 만들지 마세요.

## 작성 원칙

- `description`은 짧고 구체적으로 쓰고 핵심 역할을 앞에 둡니다.
- 프롬프트는 역할 중심으로 유지하고, 전역 지침에 속하는 넓은 규칙은 피합니다.
- 역할별 품질·비용 요구가 분명하면 `model`과 `thinking`을 명시합니다.
- 특정 호출만 다른 모델이 필요하면 파일 대신 호출별 `model`을 사용합니다.
