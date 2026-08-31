# `pi-subagent` V2 presence producer

> **상태:** shared [`@pi/presence` protocol (v2-20260828-1)](https://github.com/spi-ca/pi-presence/tree/v2-20260828-1) 기반 producer

공유 채널, schema, consumer discovery/replay, generation·sequence fence와 registry lifecycle은 canonical [`@pi/presence` protocol (v2-20260828-1)](https://github.com/spi-ca/pi-presence/tree/v2-20260828-1)을 따른다. 이 문서는 그 위에 얹는 `pi-subagent` 투영만 설명한다.

## Root activation

root parent(depth `0`)만 `subagent` source producer를 활성화한다. nested child는 producer를 만들지 않는다. source는 idle에서는 열지 않고 active·queued work 또는 새 terminal을 관측할 때 열며, parent가 quiescent하게 settle하면 withdraw한다. presence는 best-effort observer이므로 consumer 또는 event-bus 실패는 실행, 취소, 결과 수집, lease, reaper, cleanup authority를 바꾸지 않는다.

## Aggregate projection

state는 bounded `subagents` aggregate(`running`, `cancelling`, `queued`, `completed`, `failed`, `cancelled`, `omitted`)와 검증 가능한 경우의 `progress.completed/total`만 투영한다. `running`과 `cancelling`은 invocation 단위인 UX registry를 기준으로 하며, 병렬 child 단위인 scheduler active 수와 서로 빼거나 합치지 않는다. exact interactive invocation ID는 UX에 아직 없는 invocation만 보강하고, scheduler active 수는 invocation identity가 전혀 없는 호환 fallback에서만 사용한다. `queued`는 scheduler queue 수다. public subagent input/result와 accounting은 바뀌지 않으며 usage는 presence projection에 넣지 않는다.

## Terminal mapping and dedupe

UX registry의 `completed`, `failed`, `cancelled` terminal만 shared terminal outcome으로 매핑한다. invocation ID는 process-local dedupe에만 쓰고 wire에 내보내지 않는다. 최신 bounded terminal window에서 처음 본 ID만 chronological order로 publish하며, 새 failed edge만 failure attention을 만든다. terminal은 live-only이며 retained state replay로 다시 publish하지 않는다.

## Privacy and consumer presentation

session/invocation ID, agent·task·label, timestamp, usage, path, raw output/error, socket/pane ID와 credential은 presence payload에 넣지 않는다. `pi-cmux-presence`, `pi-herdr-presence` 등 consumer는 동일 Pi process에서 이 observer projection을 선택적으로 표시할 수 있지만 UI notification, retained-state presentation, terminal handling은 consumer 책임이다. producer는 consumer package를 import하거나 socket, CLI, polling 또는 persistent connection을 만들지 않는다.

## Dependency and verification

`@pi/presence`는 runtime dependency와 lockfile에서 `github:spi-ca/pi-presence#v2-20260828-1`로 정확히 고정한다.

```bash
bun test test/integration/pi-presence-producer.test.ts
bun run check
bun pm pack --dry-run
```
