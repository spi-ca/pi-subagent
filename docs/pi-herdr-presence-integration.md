# `pi-subagent`와 `pi-herdr-presence` V2 연동

> **상태:** shared [`@pi/presence` protocol (v2-20260818-2)](https://github.com/spi-ca/pi-presence/tree/v2-20260818-2) 기반 producer; consumer UI는 별도 package 책임

`pi-subagent` root parent만 `subagent` source를 shared registry에 투영한다. shared protocol의 채널, schema, replay, fence와 registry lifecycle은 canonical [`@pi/presence` protocol (v2-20260818-2)](https://github.com/spi-ca/pi-presence/tree/v2-20260818-2)을 따른다.

producer projection은 bounded subagent aggregate와 검증 가능한 progress, 새 failure attention, live terminal outcome뿐이다. invocation/run ID는 local dedupe에만 사용하며 session ID, agent/task/prompt, output/error, path, usage, timestamp, socket/pane ID와 credential은 발행하지 않는다.

Herdr는 같은 Pi process에서 선택적으로 이를 표시하는 consumer다. retained state와 live terminal의 UI presentation은 Herdr consumer가 결정하며, consumer failure는 subagent 실행, 취소, 결과 수집, lease, reaper 또는 child cleanup을 바꾸지 않는다. `pi-subagent`는 Herdr socket, CLI, polling 또는 persistent subscription을 만들지 않고 child pane metadata와 generic parent presence를 혼합하지 않는다.

공개 `subagent` schema/result와 accounting은 바뀌지 않았다. focused producer test는 shared-registry lifecycle, terminal dedupe, privacy와 transport coupling 부재를 deterministic event bus로 확인한다. 실제 Herdr socket/UI는 consumer package의 별도 검증 범위다.
