# 변경 기록

## v20261013-1

- 실행 중인 단일 background child에 정확한 전체 job ID로 `action: "steer"` 지시를 보낸다. 최대 512 UTF-8 바이트의 한 메시지만 접수하며 awaited `turn_end`에서 기존 실행의 컨텍스트에 반영한다. ACK는 inbox 접수일 뿐 모델 적용·수행을 보장하지 않으며 자동 재시도·주기 polling·새 prompt 실행은 없다.
- `report_to_parent`로 단일·병렬·체인의 실행 중 leaf가 direct parent에 짧게 보고한다. 부모가 고정한 agent·job·child 식별과 단계/작업 위치를 표시하고, child 실행당 4회 시도·부모 세션당 32개 예약 ledger 및 취소·소유권·세션 fence를 적용한다.
- 보고 자체는 모델 실행을 시작하지 않는다. Pi `1.2.0`에서는 `nextTurn`의 대기 보고가 다음 사용자 또는 최종 완료 알림의 custom-message 실행에서 한 번 소비될 수 있다. custom 실행에도 에이전트 안내를 유지하고 시작 중 큐잉·취소를 실제 host의 오프라인 회귀로 검증한다.
- Pi 개발 의존성·lockfile·현재 CI graph를 exact `1.2.0`으로 갱신하고 현재 graph의 `chord`를 제거했다. Shared `@pi/presence`를 immutable `v2-20261013-1`로 동기화하며 V2 protocol·runtime API·ABI는 유지한다.
- 실제 provider·multiplexer 검증은 자동 CI와 별도의 opt-in 작업이다.

## v20261009-1

- Pi 개발 의존성과 현재 CI graph를 exact `1.1.0`으로 동기화했다. shared `@pi/presence`는 immutable `v2-20261009-1`로 고정하며, peeled commit·V2 protocol·ABI는 기존 `v2-20261004-1`과 같다.
- Interactive child는 `agent_settled.aborted`를 반영해 앞선 assistant 응답이 완료됐더라도 취소 시 idle로 남아 재개할 수 있다. 구형 event는 마지막 assistant stop reason으로 fallback하며 completion/ACK proof·ownership·permit 해제 경계는 유지한다.
- Pi가 제공하는 유한한 0 이상의 `durationMs`를 최종 도구 결과의 `Execute`로 표시하고 partial 결과에서는 생략한다. background의 `Job elapsed`와 구분하며, 도구 카드의 `outputPad`는 Pi native shell에 맡겨 중복 padding을 추가하지 않는다.
- Pi `>=1.0.4`의 managed child와 MCP 도구가 없는 명시 allowlist에 `--no-mcp`를 적용한다. 기본 도구 선택의 MCP 상속과 명시 `mcp__...` 필터는 유지하며 replacement MCP extension까지 차단하는 보안 경계로 주장하지 않는다.

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
