# 변경 기록

## v20261004-1

- Shared `@pi/presence`를 immutable `v2-20261004-1`로 동기화했습니다. 기존 release와 peeled commit·V2 protocol·ABI는 같습니다.

- Pi 개발 의존성과 CI graph를 exact `1.0.2`로 동기화했다.
- `registerToolRenderer()`로 subagent 호출·결과 표시를 실행 등록에서 분리했다. 위임 깊이 제한에서도 저장된 호출을 표시하며 실행 권한·출력 계약은 변경하지 않는다.

## v20261001-1

- Pi 개발 의존성과 Bun CI의 전체 published graph를 exact `0.99.2`로 고정했다. `client`/`protocol` 대신 `codemode`/`mcp`와 runtime dependency `chord`를 포함한 8개 package graph를 검증한다.
- fork snapshot은 system prompt/tool delta, `context_edit`, accounting-only `usage`, retain-none compaction과 system checkpoint를 원본 그대로 보존한다. completion V3는 linked modern tail을 digest에 포함하며 기존 byte/entry/ID/identity 한계를 유지한다.
- Herdr `0.9.3`의 `events_lost`를 bounded fresh reconciliation/wake hint로 처리한다. single/shared stream 모두 payload authority가 없고 protocol 22는 변경하지 않는다.
- `subagent`에 bounded `outputSchema`/`structuredContent`를 추가했다. 사람용 text/details, usage와 오류 계약은 유지한다.
- shared `@pi/presence`를 이미 발행된 `v2-20261001-1`로 동기화했다. peeled commit과 V2 protocol/ABI는 기존 release와 같다.
- `resume_argv`는 추가하지 않았다. 실제 provider 및 live multiplexer 검증은 이 변경의 기본 CI 범위가 아니다.
