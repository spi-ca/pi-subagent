# Pi 0.81 subagent 사용량 회계

> **상태:** 현재 구현.
>
> **Authority:** 이 문서는 현재 구현과 acceptance 근거의 authoritative source다.

**목적:** foreground `subagent` 사용량이 Pi canonical session accounting으로 전달되는 범위와, background의 의도적인 한계를 설명한다.

**범위 밖:** provider 청구서, child 자체 session의 총계.

## 1. 호환성 및 Pi 계약

이 패키지의 안정적인 Pi 최소 버전은 `>=0.80.10`이다. 사용량 회계 기능만 Pi `0.81` 이상에서 조건부로 사용한다. 따라서 `0.80.10` 이상 환경의 delegation/interactive lifecycle 지원 요구와 `0.81` accounting 지원 요구를 혼동하면 안 된다.

Pi `0.81`에서 foreground custom tool이 child 사용량을 부모 canonical session accounting에 넘기는 공개 경로는 **최종 `toolResult`의 top-level `usage`**다. Pi는 이 값을 session JSONL에 persist하고 session totals에 합산한다. 공개 API로는 완료 뒤 `toolResult` usage를 patch하거나 custom/steer entry의 usage를 canonical total에 넣을 수 없다.

이 문서의 Pi API 근거는 Pi `0.81.1`의 `docs/extensions.md`(custom-tool usage accounting), `docs/session-format.md`(`ToolResultMessage.usage`), `docs/rpc.md`(session totals)다.

## 2. Foreground 수집과 exact-once 처리

각 child `SingleResult`는 UI용 `UsageStats`와 별도로 `accountingUsage?: AccountingUsage`를 가진다. `src/core/accounting-usage.ts`는 안전한 non-negative 값만 합산하고 `totalTokens`를 `input + output + cacheRead + cacheWrite`로 재계산한다. 선택 `cacheWrite1h`·`reasoning`과 cost 항목도 보존한다.

| 경로 | 수집 대상 | 중복 방지 |
| --- | --- | --- |
| inline `src/core/runner-events.js` | assistant, nested `toolResult`, compaction, branch-summary generation usage | assistant overlap, `toolCallId`/안정 표현, summary entry ID; lifecycle의 식별됨/미식별됨 summary 표현은 semantic pairing으로 정확히 한 번만 계상 |
| interactive `src/runtime/session-tail.ts` | durable child session JSONL의 assistant, `toolResult`, compaction, `branch_summary` usage | session entry ID |

interactive tail은 compaction의 `retainedTail`을 이전 context 재생으로 취급해 읽거나 합산하지 않는다. persisted compaction/`branch_summary` entry 자체의 summary-generation `usage`만 entry ID별로 한 번 계상한다.

interactive preview는 사용량 authority가 아니다. `onUpdate`로 보이는 incremental assistant/tool/summary usage는 advisory이며, terminal V3 record가 parent-captured session `(dev, ino)`, offset, final entry ID 및 prefix digest를 검증할 때만 boundary까지 새 final result로 replay·계상한다. same-inode의 boundary 뒤 append는 포함하지 않고 replacement·truncation·duplicate ID·fatal UTF-8·budget 초과는 replay를 거부한다. generic failure boundary도 같은 검증을 통과하면 failure 이전의 usage를 final result에 반영할 수 있다. 현재 boundary-less V3은 status/recovery authority만 가지며 final drain하지 않으므로, 그 뒤 live tail bytes를 canonical accounting에 포함하지 않는다. 혼합 버전에서 rolling old parent는 capability를 협상하지 않으므로 새 child의 success boundary는 assistant-only이며 post-assistant linked metadata/summary usage를 replay하지 않고, failure는 boundary-less여서 exact replay도 하지 않는다. 정확한 capability/rolling 계약은 [interactive runtime 설계의 롤링 parent/child 호환성](./interactive-runtime-performance-design.md#롤링-parentchild-호환성)을 따른다.

`src/core/fork-session.ts`는 Pi `0.81`의 modern compaction checkpoint인 `retainedTail`만 있는 entry도 검증해 수락한다. fork source에는 `retainedTail`, `usage`, `details`, `fromHook` 및 `toolResult.usage`를 원형대로 보존한다. malformed payload나 끊어진 entry tree는 계속 fail-closed한다.

## 3. Pi persistence 범위

`index.ts`는 foreground invocation의 **최종** 결과에만 모든 child `accountingUsage`의 합계를 top-level `usage`로 붙인다. partial update와 `details.results`는 별도 top-level usage를 받지 않는다. interactive terminal 경로는 completion fence + parent ACK 뒤 capture한 검증 boundary의 final replay를 사용하므로, ACK 뒤 append된 preview/usage가 최종 `toolResult.usage`에 섞이지 않는다. 정상 완료뿐 아니라 final tool result가 반환되는 실패/취소에는 그때까지 **검증되어 replay된** partial usage가 포함될 수 있다. final result가 전혀 반환되지 않으면 Pi가 persist할 accounting entry도 없다.

| 실행 경로 | canonical session accounting |
| --- | --- |
| foreground / inline | assistant, nested tool, compaction, branch-summary usage를 최종 subagent `toolResult.usage`로 한 번 전달 |
| foreground / interactive | child JSONL에서 같은 범위를 모아 최종 subagent `toolResult.usage`로 한 번 전달 |
| background / inline 또는 interactive | launch result만 즉시 persist; completion usage는 canonical totals에 **의도적으로 포함하지 않음** |

background completion은 `sendMessage()` steer와 `status`로 알리고 결과를 compact한다. 이 채널은 canonical accounting이 아니며, background usage를 다음 foreground 호출에 전가하거나 raw session JSONL을 수정하지 않는다. completion 알림 뒤 새 부모 assistant 응답이 생기면 그 응답의 usage만 일반 Pi assistant usage로 별도 집계된다.

## 4. 검증 근거

단위·경로 테스트는 다음 파일에 있다.

- `test/core/accounting-usage.test.ts` — 정규화, 합산, finalization
- `test/runtime/runner-events.test.ts` — assistant/tool 및 lifecycle compaction/branch-summary pairing
- `test/runtime/session-tail.test.ts` — persisted summary entry ID와 `retainedTail` 미재생, identity-bound replacement/truncation rejection
- `test/runtime/completion-v3.test.ts`, `test/runtime/runner-interactive.test.ts` — verified final replay, generic failure boundary, boundary-less V3의 no-final-drain
- `test/entrypoint/index.test.ts` — modern fork compaction과 usage/details 보존
- `test/entrypoint/background-jobs.test.ts` — background compacting 및 session fence

provider-backed installed-Pi `0.81.1` acceptance의 최신 실행은 다음 명령으로 통과했다.

```bash
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE=1 \
PI_SUBAGENT_MANAGED_CHILD_LIVE_NESTED=1 \
PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE=/absolute/path/to/pi-0.81.1/pi/pi \
bun run acceptance:managed-child
```

이 acceptance는 managed inline child 하나에서 foreground `subagent` tool result와 nested `accountingUsage`의 `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` 다섯 base token field가 정확히 일치하는지 확인한다. 같은 다섯 값이 private parent session JSONL의 `toolResult`에 persist되고, `get_session_stats` RPC의 `input`, `output`, `cacheRead`, `cacheWrite`, `total` token totals에 정확히 반영되는지도 확인한다. `cost`, `cacheWrite1h`, `reasoning` 등 optional usage field는 이 acceptance의 비교 대상이 아니다. 성공 stdout JSON 계약에는 `"foregroundUsagePersistence":true`가 포함된다. private session directory는 test 종료 때 정리되므로 저장소에 retained report path는 없다.

## 5. Background 사용량 회계: 명시적 비목표

background completion 사용량 회계는 이 패키지에서 의도적으로 구현하지 않는 명시적 비목표이며, upstream 대기나 후속 요구가 아니다. completion usage는 canonical totals에 넣지 않고, 다음 foreground 호출, completion steer 또는 `status` 출력, raw parent session JSONL로 전가하지 않는다. private ledger나 external sink도 제안하지 않는다.

## 6. 관련 문서

- 호출과 foreground/background 사용자 계약: [`usage.md`](./usage.md)
- 개발 명령과 acceptance gate: [`development.md`](./development.md)
- 패키지 최소 Pi 버전: [`../package.json`](../package.json)
