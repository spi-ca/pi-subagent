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
| `tools` | 아니요 | 부모 CLI 도구 오버라이드, Pi 복원/기본 도구 순 | Pi `--tools`에 전달하는 전체 allowlist. 쉼표 목록 또는 YAML 배열 |

호출별 `model`이 파일의 `model`보다 우선합니다. 단일 호출은 최상위 `model`, 병렬은 각 task item, 체인은 순차 단계 또는 병렬 단계의 각 task item에 지정합니다. `thinking`을 생략하면 Pi `0.99.2`에서는 호출 시점 부모 세션의 `ctx.thinkingLevel`을 상속하고, 이전 호환 host에서는 부모 CLI 오버라이드와 Pi 기본값으로 fallback합니다.

## 도구와 권한

`tools`는 Pi `--tools`로 child에 전달하는 도구 선택입니다. Pi `1.1.0`에서 일반 이름만 지정한 `--tools`는 MCP 도구를 제거하지 않으므로, 이 패키지는 명시 allowlist에 `mcp__...`가 없으면 호환 host(`>=1.0.4`)에서 `--no-mcp`도 전달합니다. `codemode`만 추가해 MCP 전체가 우연히 열리는 것을 막습니다. MCP를 의도적으로 선택하려면 `inherit` profile에서 `read,codemode,mcp__docs__*`처럼 MCP 패턴을 명시하세요. 도구 선택은 sandbox가 아니며, hostile child를 격리하는 OS 보안 경계도 아닙니다. 편집 가능한 역할에는 필요한 도구만, `scout`·`reviewer` 같은 읽기 전용 역할에는 `read,find,ls,grep`를 우선 지정하세요. 변경 또는 명령 실행이 필요할 때만 `bash`, `edit`, `write`를 추가합니다.

Pi `1.3.0`의 fork/resume에서 명시적인 역할 `tools` 전체 allowlist는 transcript의 active tools 복원보다 우선합니다. 지원되는 background child에는 아래의 `report_to_parent`만 추가하며 일반 도구 allowlist는 넓히지 않습니다. 역할과 부모 CLI 모두 도구 선택을 생략하면 사용 가능한 도구 중 transcript의 system tool 선언을 복원할 수 있고, 복원 선언이 없을 때 Pi 기본값을 사용합니다. `inherit` profile의 `+name`/`-name` 선택은 복원된 목록 위에 적용됩니다. 읽기 전용 역할의 전체 목록을 이런 modifier로 바꾸지 마세요.

명시적 목록으로 nested delegation을 허용하려면 `subagent`도 넣어야 합니다. `PI_SUBAGENT_CMUX_CHILD_POLICY=managed`에서는 `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `subagent`와, verified stable Pi `>=1.1.0`에서 정확한 이름 `codemode`, `report_to_parent`만 추가로 허용합니다(`codemode`는 명시적 선택만). 임의 extension/MCP 이름, wildcard, `+`/`-` 도구 선택은 launch 전에 fail-closed합니다. 읽기 도구를 묶어 결과를 줄이는 역할은 다음처럼 선택할 수 있습니다.

```yaml
tools: read,grep,find,ls,codemode
```

에이전트의 `tools`가 부모 CLI fallback보다 우선하며, 선택을 생략하면 managed child에 codemode를 자동으로 추가하지 않습니다. `subagent`를 목록에 넣지 않으면 스크립트에서도 nested delegation을 호출할 수 없습니다. native `models`(classifier/image), session store와 temp output은 도구 allowlist 밖에 있으므로 이 목록을 OS sandbox나 no-network 보장으로 해석하지 마세요. 버전·owner metadata와 extension·신뢰 경계는 [설정](./configuration.md#managed-child-profile), 결과 처리 예시는 [사용법](./usage.md#codemode에서-사용)을 참고하세요.

## 컨텍스트와 통신

각 하위 에이전트는 별도 `pi` 프로세스에서 실행되고, 부모·형제와 live memory/state를 공유하지 않습니다.

| 모드 | child가 받는 내용 | 사용 시점 |
| --- | --- | --- |
| `spawn` | 에이전트 프롬프트와 `Task: ...` | 독립적이고 재현 가능한 작업 |
| `fork` | 현재 부모 세션 스냅샷, 에이전트 프롬프트, `Task: ...` | 이전 대화·파일 읽기·결정에 의존하는 후속 작업 |

Pi `0.99.2` fork는 현재 branch의 raw entry를 보존한다. 초기/변경 system message의 prompt section과 tool loadout, `context_edit`의 omission/replacement, accounting-only `usage`, retain-none compaction의 자기 ID와 complete system checkpoint를 유지하며 projected 메시지로 평탄화하지 않는다. 알 수 없는 entry, 잘못된 shape/link/target은 snapshot을 거부한다. child 결과 observer는 raw assistant 출력·usage만 수집하므로 context edit을 새로운 출력으로 해석하거나 system prompt를 결과에 넣지 않는다.

`spawn`이 기본값입니다. 블로킹 결과 래퍼, `background: true`, 상태 조회와 취소는 [사용법](./usage.md)을 참고하세요. 백그라운드 결과는 비신뢰 데이터로 처리하고, 자동 전달을 기다리는 동안 polling·sleep·대기 루프를 만들지 마세요.

### 실행 중 direct parent에 짧게 보고하기

지원되는 **`background: true` child**는 역할의 `tools`에 따로 명시하지 않아도 `report_to_parent`를 받습니다. 보고 본문 `message`는 공백만이 아닌 최대 **4096 UTF-8 바이트**이며, 문자 수나 JSON escaping 후 크기가 아닌 본문 바이트 수로 제한합니다. 초과·공백 본문 오류는 실제/최대 바이트 수를 알리되 본문은 노출하지 않습니다. 읽기 전용 allowlist에는 이 보고 도구만 추가하며 `subagent`·편집 도구·MCP·codemode를 자동으로 열지 않습니다. 도구 선택을 생략하면 Pi 기본/복원 도구를 그대로 두고 보고 도구만 보충합니다. 유효한 `--no-tools` 선택에는 추가하지 않으며, 역할의 명시적 도구 목록은 부모의 no-tools fallback보다 우선합니다.

Linux/macOS와 stable Pi `>=1.1.0`에서 단일·병렬·체인(병렬 단계 포함), inline·interactive, spawn·fork를 지원합니다. foreground에는 자동 추가하지 않습니다. 미지원 host/platform이나 인증 socket 준비 실패 시 자동 보고만 생략하고 작업은 계속합니다. 기존 방식으로 도구를 명시한 호출에는 호환성 오류가 반환될 수 있습니다. 알림에는 부모가 고정한 에이전트 이름과 leaf identity/위치가 표시됩니다. 부모→child steering은 별개이며 여전히 단일 background만 지원합니다. managed profile도 지원하며 `codemode`를 함께 선택하면 `tools.report_to_parent({message: "짧은 진행 상황"})`로 호출할 수 있습니다. 선택적 `kind`는 `progress`(기본값), `finding`, `question`, `blocked`만 허용합니다. `progress`는 전용 부모 UI status를 즉시 갱신하고 같은 child의 pending 값만 최신으로 교체합니다. 앱 소유 batch를 성공 turn 경계 또는 다음 사용자/custom 시작에 추가하되 모델 호출·continuation을 강제하지 않습니다. child별 16회/30초 sliding window와 전체 미확정 32개/직렬화 128 KiB 한도를 적용하며, 저장 확인 후 예산을 반환합니다. commit 전 상태는 reload·reset·종료에서 소실될 수 있습니다. 중요한 발견·질문·차단은 해당 kind를 명시하면 실행 중인 부모의 안전한 경계에 steer하거나 idle 부모의 custom run을 시작할 수 있습니다. sender identity는 종류와 무관하게 부모만 정합니다. ACK는 부모 API 알림 접수/제출이지 전달 완료나 모델의 읽음·답변·승인이 아닙니다. 동기 답변을 기다리지 말고 맡은 작업을 계속하세요. 자세한 제한과 전달 시점은 [부모에게 보고하기](./usage.md#child에서-direct-parent에-보고하기)를 참고하세요.

## 작성 원칙

- `description`은 짧고 구체적으로 쓰고 핵심 역할을 앞에 둡니다.
- 프롬프트는 역할 중심으로 유지하고, 전역 지침에 속하는 넓은 규칙은 피합니다.
- 역할별 품질·비용 요구가 분명하면 `model`과 `thinking`을 명시합니다.
- 특정 호출만 다른 모델이 필요하면 파일 대신 호출별 `model`을 사용합니다.
