# 변경 기록

## v20261004-2

- 기존 broker 테스트 하네스의 늦은 `close` 구독 race를 spawn 직후 completion 캐시와 protocol 22 event-checkpoint 회귀 테스트로 안정화했다. 실패 시 직접 소유한 process를 bounded 종료·reap한 뒤 fake server를 닫는다. 과거 CI 실패의 원인으로 확정한 것은 아니며 production 동작·보안 검증·기한은 변경하지 않는다.
- 현재 UID 소유 상태 root에 `0700`/`0750`을 허용하고 새 root를 `0750`으로 생성한다. 기존 root는 자동 chmod하지 않으며 run·권한 디렉터리 `0700`, 파일·marker `0600`과 소유자·symlink·ancestor 검증은 유지한다.

## v20261004-1

- Shared `@pi/presence`를 immutable `v2-20261004-1`로 동기화했습니다. 기존 release와 peeled commit·V2 protocol·ABI는 같습니다.

- Pi 개발 의존성과 CI graph를 exact `1.0.2`로 동기화했다.
- `registerToolRenderer()`로 subagent 호출·결과 표시를 실행 등록에서 분리했다. 위임 깊이 제한에서도 저장된 호출을 표시하며 실행 권한·출력 계약은 변경하지 않는다.
- 정상 completion-fence ACK 테스트의 시계를 제어해 CI 부하에 따른 타이밍 실패를 제거했다. 실제 ACK 검증·100ms 보안 기한·음성 테스트·runtime은 변경하지 않는다.

## v20261001-1

- Pi 개발 의존성과 Bun CI의 전체 published graph를 exact `0.99.2`로 고정했다. `client`/`protocol` 대신 `codemode`/`mcp`와 runtime dependency `chord`를 포함한 8개 package graph를 검증한다.
- fork snapshot은 system prompt/tool delta, `context_edit`, accounting-only `usage`, retain-none compaction과 system checkpoint를 원본 그대로 보존한다. completion V3는 linked modern tail을 digest에 포함하며 기존 byte/entry/ID/identity 한계를 유지한다.
- Herdr `0.9.3`의 `events_lost`를 bounded fresh reconciliation/wake hint로 처리한다. single/shared stream 모두 payload authority가 없고 protocol 22는 변경하지 않는다.
- `subagent`에 bounded `outputSchema`/`structuredContent`를 추가했다. 사람용 text/details, usage와 오류 계약은 유지한다.
- shared `@pi/presence`를 이미 발행된 `v2-20261001-1`로 동기화했다. peeled commit과 V2 protocol/ABI는 기존 release와 같다.
- `resume_argv`는 추가하지 않았다. 실제 provider 및 live multiplexer 검증은 이 변경의 기본 CI 범위가 아니다.
