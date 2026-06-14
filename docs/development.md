# 개발

이 저장소는 하위 에이전트 오케스트레이션을 위한 Pi 확장 패키지입니다.

## 저장소

공식으로 내보낸 저장소:

<https://github.com/spi-ca/pi-subagent>

## 준비 사항

- `package.json`의 `packageManager` 필드와 맞는 Bun
- `tsconfig.json`이 참조하는 형제 Pi 패키지를 제공하는 Pi 체크아웃 또는 설치 레이아웃

## 명령

```bash
bun install
bun run check
bun test --pass-with-no-tests
bun run ci
```

`bun run ci`는 타입 체크와 테스트를 실행합니다.

## 개발 가정

이 패키지는 보통 기존 Pi 설치 내부에서 개발합니다. 타입 체크는 `tsconfig.json`을 통해 `../../npm/node_modules/@earendil-works/...` 같은 형제 Pi 패키지 경로에 의존합니다.

체크아웃을 해당 레이아웃 밖으로 옮기면 `bun run check`를 실행하기 전에 Pi 패키지를 설치하거나 경로를 매핑해야 합니다.

## 프로젝트 구조

```text
index.ts                    — Pi 패키지 manifest가 참조하는 확장 진입점
src/core/                   — 에이전트 발견, 신뢰/경로 검사, 스키마, 체인 헬퍼, 이벤트 파싱, 공통 타입
src/runtime/                — 자식 프로세스 runner, CLI 상속, FIFO 헬퍼, pane renderer, Zellij lifecycle 헬퍼
src/ui/                     — subagent 도구 호출과 결과를 위한 TUI 렌더링
test/core/                  — 발견, 신뢰, 메타데이터, 체인 동작, 공통 타입 단위 테스트
test/runtime/               — runner, 인증 전파, FIFO, CLI 파싱, pane 렌더링 단위/통합 테스트
test/entrypoint/            — 공개 확장/도구 진입점 계약 테스트
docs/                       — 주제별 문서
docs/guidelines/            — 문서와 에이전트 지침 작성 가이드
```

루트 `index.ts`는 의도적으로 그대로 둡니다. `package.json`의 Pi 패키지 manifest가 이 파일을 확장 진입점으로 참조하기 때문입니다. 내부 모듈은 `src/` 아래에 있고, 테스트는 같은 core/runtime 구분을 `test/` 아래에서 따릅니다.

## 문서 작성 방식

`docs/guidelines/`의 progressive disclosure 접근을 따릅니다.

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 예외를 추가하기보다 모순을 제거합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.
