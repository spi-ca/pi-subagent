# 설정

이 패키지는 Pi의 GitHub 패키지 설치 방식으로 사용할 수 있습니다.

## GitHub 패키지로 설치

사용자 수준 Pi 설정 파일(`~/.pi/agent/settings.json`)에 설치하려면 다음 명령을 실행합니다.

```bash
pi install git:github.com/spi-ca/pi-subagent
```

Pi는 설정에 다음과 같은 패키지 항목을 추가하고 저장소를 `~/.pi/agent/git/github.com/spi-ca/pi-subagent` 아래에 클론합니다.

```json
{
  "packages": ["git:github.com/spi-ca/pi-subagent"]
}
```

프로젝트 수준 설정(`.pi/settings.json`)에 설치하려면 `-l`을 사용합니다.

```bash
pi install -l git:github.com/spi-ca/pi-subagent
```

특정 태그나 커밋으로 고정하려면 ref를 붙입니다.

```bash
pi install git:github.com/spi-ca/pi-subagent@<tag-or-commit>
```

## 위임 보호 장치

이 확장은 기본적으로 두 가지 런타임 보호 장치를 적용합니다.

### 깊이 제한

`--subagent-max-depth`는 하위 에이전트가 다른 하위 에이전트에게 다시 위임할 수 있는 깊이를 제어합니다.

- 기본값: `5`
- 메인 에이전트는 깊이 `0`에서 시작합니다.
- `currentDepth < maxDepth`인 동안 위임할 수 있습니다.
- 기본 깊이에서는 `0`, `1`, `2`, `3`, `4` 깊이가 위임할 수 있고, `5` 깊이는 위임할 수 없습니다.

다음 중 하나로 설정합니다.

- CLI 플래그: `--subagent-max-depth <n>`
- 환경 변수: `PI_SUBAGENT_MAX_DEPTH=<n>`

`n`은 0 이상의 정수여야 합니다.

예시:

```bash
# 기본 동작: 깊이 5 + 순환 방지 켜짐
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
# 최대 깊이를 3으로 설정하고 순환 방지를 끕니다. 권장하지 않습니다.
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

확장은 현재 환경에 따라 다음 우선순위로 실행 방식을 선택합니다.

1. `CMUX_WORKSPACE_ID`와 `CMUX_SURFACE_ID`가 모두 canonical UUID이면 `cmux-pane`
2. `TMUX`가 canonical socket/server/session 형식이고 `TMUX_PANE`이 canonical `%N`이면 `tmux-pane`
3. 그 외 환경에서는 `inline`

### Interactive pane layout

interactive pane의 layout policy는 다음으로 결정합니다.

```text
--subagent-pane-layout > PI_SUBAGENT_PANE_LAYOUT > auto
```

```bash
# 기본 auto를 명시
pi --subagent-pane-layout auto

# 기존 child별 오른쪽 split 호환 동작
PI_SUBAGENT_PANE_LAYOUT=split pi
```

지원 값은 **정확히 소문자** `auto`와 `split`뿐입니다. 공백, 대소문자 변형, alias는 유효하지 않습니다. 잘못된 CLI 값은 extension 초기화에서, 잘못된 환경 값은 해석 시 다음처럼 actionable error로 거부됩니다. backend launch 뒤 다른 layout이나 `inline`으로 조용히 fallback하지 않습니다.

```text
--subagent-pane-layout must be exactly "auto" or "split" (received ...).
PI_SUBAGENT_PANE_LAYOUT must be exactly "auto" or "split" (received ...).
```

해석된 값은 child 환경의 `PI_SUBAGENT_PANE_LAYOUT`로 명시적으로 전달되므로 nested child도 부모의 정책을 그대로 상속합니다.

| 값 | cmux | tmux |
| --- | --- | --- |
| `auto` (기본) | root sibling은 새 오른쪽 shared pane 하나의 surface를 공유한다. nested descendant는 정확한 source pane에 surface로 쌓인다. | child마다 parent와 같은 session의 detached window 하나를 만든다. |
| `split` | child마다 source surface 오른쪽에 split한다. | child마다 source pane 오른쪽에 split한다. |

`auto`의 cmux는 source root별 process-global coordinator가 foreground/background launch를 직렬화한다. detached V2 broker만 pre-commit allocation과 durable `allocation.json` publish를 수행하며, coordinator는 commit 뒤 strict layout record와 정확히 일치하는 allocation만 adopt/release한다. 종료·취소·reaper는 shared pane, tmux window 또는 session container를 넓게 닫지 않고 child의 정확한 surface/pane만 대상으로 한다.

### cmux pane

`cmux-pane`에는 Pi `0.80.10` 이상과 cmux CLI가 필요합니다. `auto`의 root 첫 child만 현재 surface 오른쪽에 focus를 이동하지 않는 split을 만들고, 뒤 root sibling은 그 pane에 surface를 추가합니다. nested auto child는 source surface가 속한 정확한 pane에 surface를 추가합니다. `split`은 매 child마다 기존 split을 수행합니다. cmux가 새 split에 먼저 여는 shell은 backend 잔여 상태입니다. durable commit 전에는 그 shell에 run directory, wrapper, task, session, child command 또는 capability authority를 넘기지 않으며, initial shell 자체를 pre-shell hardened로 간주하지 않습니다. commit과 parent gate 뒤에만 sanitized `respawn-pane`이 wrapper를 실행합니다.

- stdout/stderr를 renderer나 FIFO로 pipe하지 않습니다.
- 부모 결과는 child session JSONL과 lifecycle sidecar에서 읽습니다.
- child는 기본적으로 `parent-owned`이며 첫 `agent_settled` 뒤 종료됩니다.
- 부모 취소·session shutdown에서는 먼저 Escape를 보내고, grace period 뒤 surface를 닫습니다.
- 부모가 비정상 종료되면 2초 주기의 lease와 12초 stale threshold로 child가 orphan 상태를 감지합니다.
- stale run은 다음 root session 시작 시 leaf-first reaper가 다시 정리합니다.

cmux를 감지했지만 CLI 실행 또는 최소 Pi 버전 확인에 실패하면 조용히 다른 backend나 inline으로 바꾸지 않고 해당 subagent 실행을 오류로 반환합니다.

### tmux pane

`tmux-pane`에도 Pi `0.80.10` 이상과 tmux CLI가 필요합니다. `auto`는 source topology를 검증한 뒤 parent와 같은 session에 detached window를 child별로 만들며 parent window를 split하지 않습니다. `split`만 현재 `TMUX_PANE` 오른쪽에 detached split을 만듭니다. layout-aware production broker는 두 경우 모두 `-P -F`의 strict `session_id|window_id|pane_id|pane_pid` 네 필드 응답을 받고 staged gate verifier를 생성 command로 직접 실행합니다. `pane_id<TAB>pane_pid`는 legacy/direct adapter 전용입니다. verifier가 gate, session/window binding, pane/server fingerprint를 검증한 뒤에만 wrapper와 child Pi를 시작하며 lifecycle은 verifier 대기의 `idle`에서 wrapper `exec` 뒤 `running`으로 전이합니다.

- `TMUX`에서 socket path와 server PID를 추출하고, 생성된 `session_id`, `window_id`, `pane_id`, `pane_pid`와 함께 layout-aware launch record에 저장합니다.
- pane은 `%N` ID로 조회하되 stale reaper는 server PID와 `pane_pid` fingerprint가 모두 일치할 때만 중단·종료합니다.
- `list-panes`, `send-keys ... Escape`, `kill-pane`으로 lifecycle을 제어합니다.
- session JSONL, child bridge, parent lease, completion과 reaper는 cmux와 완전히 공유합니다.
- tmux server의 오래된 global environment 대신 parent가 계산한 child environment를 private `0600` artifact로 전달하며, 새 pane identity 값은 덮어쓰지 않습니다. 전달 allowlist와 arbitrary environment 제외 규칙은 아래 [Interactive provider 환경 전달](#interactive-provider-환경-전달)을 따릅니다.

현재 환경이 cmux와 tmux 안에 동시에 있으면 cmux가 우선합니다. tmux를 감지했지만 CLI 실행에 실패한 경우에도 조용히 inline으로 바꾸지 않습니다.

### Interactive provider 환경 전달

inline child는 부모의 provider 환경을 그대로 사용합니다. interactive child는 multiplexer의 오래된 global environment를 쓰지 않고, 아래 Pi `0.80.10` provider 환경만 private `0600` secret artifact로 전달한 뒤 wrapper가 source 즉시 삭제합니다. 값은 broker environment·argv·로그에 넣지 않습니다.

- Pi [`providers.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md)의 built-in API-key 변수 전체(예: `AWS_BEARER_TOKEN_BEDROCK`, `RADIUS_API_KEY`)
- Azure: `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`; Cloudflare: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`
- Bedrock/AWS: profile, access/session credential, region/default region, ECS container/IRSA credential 변수와 `AWS_BEDROCK_FORCE_CACHE`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, `AWS_BEDROCK_SKIP_AUTH`, `AWS_BEDROCK_FORCE_HTTP1`
- Vertex: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`; `PI_CACHE_RETENTION`
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`의 대소문자 variant와 `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`

그 밖의 임의 환경 변수는 interactive child에 전달하지 않습니다. private artifact가 삭제되기 전에도 secret/API key를 `PI_SUBAGENT_BROKER_RUNTIME`이나 다른 broker 설정에 넣지 마세요.

Zellij와 기존 JSONL/FIFO pane renderer 지원은 제거되었습니다.

### V2 broker runtime과 backend resolver

Interactive pane의 production launch는 `src/runtime/pane-launch-broker.mjs` one-shot broker를 사용합니다. resolver는 존재하는 regular file인지와 실행 가능한지만 확인하고, symlink와 shebang wrapper를 따라 canonical absolute path를 기록합니다. directory는 실행하지 않습니다.

```bash
PI_SUBAGENT_BROKER_RUNTIME=/path/to/node pi
```

runtime 순서는 비어 있지 않은 `PI_SUBAGENT_BROKER_RUNTIME`, 그 외 `PATH`의 `bun`, 마지막으로 `PATH`의 `node`입니다. cmux는 비어 있지 않은 `CMUX_BUNDLED_CLI_PATH`를 먼저 사용하고, 그 외 `PATH`의 `cmux`를 사용합니다. tmux는 `PATH`의 `tmux`를 사용합니다. 빈 설정값은 미설정과 같아서 해당 fallback을 계속 사용합니다.

interactive 실행에서 executable `PATH`는 사용자가 명시적으로 선택한 trust boundary입니다. 따라서 project-local shim, user-owned directory, symlink, shell script 또는 macOS application 경로를 provenance·owner·ancestor·native magic·codesign 정책으로 거부하지 않습니다. 선택된 canonical runtime/backend path는 immutable intent에 기록하고, parent와 reaper는 lifecycle 작업 직전에 그 **같은** 경로가 여전히 존재하고 실행 가능한지만 다시 확인합니다. run artifact root, marker, symlink, owner/mode, artifact containment, source/allocation binding 및 exact-target cleanup 검증은 별도로 그대로 유지됩니다.

runtime, broker entrypoint 또는 backend를 찾을 수 없거나 실행할 수 없으면 artifact나 broker를 만들지 않고 interactive run을 오류로 끝냅니다. 이 오류는 inline fallback으로 바뀌지 않습니다. secret/API key를 `PI_SUBAGENT_BROKER_RUNTIME` 또는 다른 broker 설정에 넣지 마세요.

#### 문제 해결

- `Interactive pane mode requires an available broker runtime, broker entrypoint, and backend executable.`: 설정한 runtime 또는 resolver가 선택할 `PATH`의 `bun`/`node`, `cmux`/`tmux`가 존재하고 실행 가능한 regular file인지 확인하세요. symlink와 shebang shim은 지원됩니다.
- cmux/tmux 환경이 감지되었는데 실행이 실패함: 안전상 inline으로 자동 fallback하지 않습니다. backend executable 및 Pi `0.80.10` 이상을 확인하세요.
- Windows: interactive backend는 지원하지 않으며 automatic mode는 `inline`입니다.
- stale diagnostic directory: `possible-unrecorded-allocation` residual risk 또는 target absence 미확인일 수 있습니다. run artifact를 임의 삭제하거나 cmux surface를 이름으로 추측해 종료하지 마세요. live crash/cleanup acceptance 절차와 상태는 [`cmux-pi-tui-design.md`](cmux-pi-tui-design.md#12-acceptance-runbook)를 참고하세요.

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

이 승인 범위는 **프로젝트 에이전트 프롬프트만**입니다. 하위 Pi 프로세스는 프로젝트 안에서 항상 `--no-context-files --no-approve`로 시작하므로 `AGENTS.md`/`CLAUDE.md`, `.pi/settings.json`, extensions, packages, themes 또는 다른 프로젝트 코드를 이 승인만으로 로드하지 않습니다. 상속된 context-file/approval alias도 제거하고 canonical deny flag를 다시 추가합니다. 선택된 신뢰된 에이전트의 프롬프트는 확장이 직접 전달합니다. 별도의 전체 프로젝트 신뢰 채널은 현재 추론하거나 자동 승격하지 않습니다.

Pi의 일반적인 boolean 프로젝트 신뢰 상태는 충분한 근거로 보지 않습니다. Pi가 그 신뢰가 어떤 루트에 적용되는지 노출하지 않기 때문입니다.

## 내부 환경 변수

확장은 다음 내부 환경 변수를 관리하고 자식 프로세스에 전달합니다.

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_STACK` — 조상 에이전트 이름의 JSON 배열. 예: `["scout","planner"]`
- `PI_SUBAGENT_PREVENT_CYCLES`
- `PI_SUBAGENT_TRUSTED_PROJECTS` — 세션 중 임시 승인된 canonical 프로젝트 루트의 JSON 배열
- `PI_SUBAGENT_DENIED_PROJECTS` — 세션 중 임시 거부된 canonical 프로젝트 루트의 JSON 배열
- `PI_SUBAGENT_ORIGINAL_AGENT_DIR` — 부모 프로세스의 원래 에이전트 디렉터리
- `PI_SUBAGENT_INHERITED_API_KEY` — 부모 프로세스에서 상속한 API key 전달용 내부 값
- `PI_OFFLINE` — 하위 에이전트에서 업데이트 확인, 패키지 업데이트 확인, install/update telemetry 같은 Pi 시작 시 네트워크 작업을 건너뛰도록 설정되는 Pi 런타임 플래그
- `PI_SUBAGENT_RUN_STATE_DIR` — interactive pane run artifact root override. 기본값은 `${TMPDIR}/pi-subagent-runs-<uid>`입니다. root에는 immutable `state-root-marker.json`, 각 run에는 immutable `run-directory-marker.json`이 필요하며 둘 다 owner-only regular `0600` JSON marker입니다. 빈 private root만 초기화할 수 있습니다. marker 없는 기존 nonempty override/default root는 보수적으로 거부·보존하며 reaper가 검사·삭제하지 않습니다.
- `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_RUN_STATE_PATH`, `PI_SUBAGENT_RUN_COMPLETION_PATH`, `PI_SUBAGENT_PARENT_LEASE_PATH`, `PI_SUBAGENT_CHILD_SESSION_PATH`, `PI_SUBAGENT_RUN_OWNERSHIP` — parent와 child bridge 사이의 내부 lifecycle protocol
- `PI_SUBAGENT_LEASE_STALE_MS`, `PI_SUBAGENT_LEASE_CHECK_MS` — parent lease 만료·검사 간격의 내부 값
- `PI_SUBAGENT_BROKER_RUNTIME` — V2 broker runtime override. 비어 있지 않으면 해당 executable을 사용하고, 비어 있거나 미설정이면 `PATH`에서 `bun` 후 `node`를 탐색
- `PI_SUBAGENT_PANE_LAYOUT` — interactive pane layout의 상속된 resolved policy. 사용자 설정은 `auto` 또는 `split`의 정확한 소문자 값만 허용하며, CLI `--subagent-pane-layout`가 이 환경 변수보다 우선합니다.

다른 확장이 위임된 하위 에이전트 프로세스 안에서 실행 중인지 확인해야 한다면 `PI_SUBAGENT_DEPTH`를 확인하세요. `PI_SUBAGENT_DEPTH > 0`이면 "이 Pi 프로세스는 하위 에이전트"로 취급하면 됩니다.
