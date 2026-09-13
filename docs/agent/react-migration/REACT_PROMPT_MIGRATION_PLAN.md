# Reference Loader Prompt React 전환 계획

작성 기준: 2026-09-08

상태: P5 live cleanup check 사용자 확인; R0-R6 및 P10 cleanup 구현·자동 검증 완료

현재 Prompt shell의 P2–P4 구현과 자동 회귀 검증은 완료했다. React mount API는
`destroy()` 중심의 좁은 경계로 유지하고, 중복 teardown에서도 실제 unmount가
한 번만 일어나도록 한다. 이후 R0-R6에서 section body와 Subject/Shot card를
React로 이전했고, user-confirmed live cleanup check 뒤 P10 legacy branch
cleanup을 완료했다. 추가 live parity와 Guide 복구는 별도 확인 범위다.

이 문서는 ordinary Media React 전환 이후 진행할 Prompt editor shell 전환을
정의한다. H3 GUIDE/Timeline React 복구는 이 문서의 범위가 아니다.

## 1. 현재 경계

현재 ordinary Media UI는 `loader-react.tsx`가 담당한다.

- GUIDE-free References와 single-image Loader가 React로 렌더된다.
- `ReferenceLoaderController`는 저장 상태, history, upload, preview, ComfyUI
  transaction과 native player/editor host를 계속 소유한다.
- Prompt는 별도의 `REFERENCE_PROMPT`/`REFERENCE_PROMPT_DEFINITIONS` DOM widget이다.
- `ReferencePromptController`가 `PromptDocument`, serialization, 입력 이벤트,
  contenteditable, chip/caret, autocomplete, Subject/Shot draft를 소유한다.
- `extension.ts`가 Loader와 Prompt 사이의 reference/Shot 동기화를 연결한다.

따라서 다음 단계는 Prompt 데이터를 React로 복제하는 작업이 아니라, Prompt의
외곽 UI와 기존 native 편집 영역의 경계를 분리하는 작업이다.

## 2. 목표

Prompt panel의 선언적 shell을 React로 옮기되, 저장 계약과 입력 동작을 유지한다.

React가 처음 담당할 영역:

- Prompt toolbar와 제목/preset 표시
- Copy source, Copy compiled, Clear
- Raw/Structured 전환 버튼
- hint/status 표시
- Prompt workspace 및 native editor host의 배치

기존 controller가 계속 담당할 영역:

- `PromptDocument`의 유일한 canonical owner
- Raw/Structured parsing 및 compilation
- contenteditable 입력과 caret/selection
- mention chip와 tag highlighting
- `@`/`#` autocomplete picker
- IME composition
- Subject/Shot definition 및 Shot draft
- Prompt serialization/restore와 graph transaction

## 3. 범위에서 제외

이번 전환에서는 다음을 변경하지 않는다.

- H3 Guide 카드, Timeline, Start/End, Guide validation
- Prompt 저장 schema와 backend 계약
- Prompt 전용 global state library
- Tailwind 도입 또는 bundle chunk 분리
- `contenteditable` 내부의 전면 JSX 재작성
- image/trim editor 내부 구현

Guide 데이터가 있는 Loader는 계속 legacy Loader surface로 간다. Prompt React
전환이 Guide 지원을 의미하지 않으며, native H3 conditioning의 성공도 의미하지
않는다.

## 4. 목표 컴포넌트 경계

```text
ReferencePromptReactRoot
├── PromptToolbar
├── PromptStatus / PromptHint
├── PromptWorkspaceHost       (React workspace; Controller state boundary)
├── PromptPickerHost           (React picker; browser-native overflow scroll)
└── PromptDefinitionsHost      (별도 DOM widget의 React root)
```

`REFERENCE_PROMPT`와 `REFERENCE_PROMPT_DEFINITIONS`는 ComfyUI에서 별도 DOM
widget으로 생성되므로 첫 단계에서 하나의 DOM root로 합치지 않는다. React가
두 widget의 lifecycle을 우회해서 직접 소유하지 않도록 명시적인 host와 cleanup
경계를 둔다.

React는 전체 `PromptDocument`를 leaf component에 전달하지 않는다. Controller가
제공하는 작은 view snapshot과 action adapter를 root에서 사용하고, Controller는
canonical state와 editor command만 관리한다.

## 5. 구현 순서

### P0 — ordinary Media migration gate

새 Prompt 코드를 작성하기 전에 ordinary Media React slice를 live ComfyUI에서
확인한다.

- Nodes 2.0과 Legacy Canvas에서 Loader를 생성한다.
- caption focus, upload/drop, preview, playback host, resize를 확인한다.
- workflow/Snapshot restore와 node removal을 확인한다.
- Guide-free state만 React로 가고, Guide state는 legacy로 복원되는지 확인한다.

자동 테스트 통과만으로 ComfyUI DOM widget lifecycle이 검증됐다고 판단하지
않는다. live 환경을 사용할 수 없으면 이 검증을 미완료 상태로 기록하고, Prompt
변경은 별도 테스트 fixture에서 진행한다.

### P1 — Prompt controller contract 고정

작업 파일:

- `frontend/src/reference-loader/components/prompt-editor.ts`
- `frontend/test/reference-prompt.test.ts`
- `frontend/test/reference-prompt-v5.test.ts`
- `frontend/test/reference-loader-extension.test.ts`

다음 동작을 React 전환 전의 회귀 계약으로 고정한다.

- Raw/Structured 전환과 authoring text 보존
- `#tag` mention과 media reference 재연결
- Copy source와 Copy compiled의 차이
- Prompt Clear가 Media를 보존하는지 여부
- Subject/Shot 추가, 이름 변경, frame 처리
- autocomplete, caret, selection, IME composition
- serialize/restore와 legacy Prompt recovery
- 두 Loader/Prompt widget instance의 독립성

이 단계에서는 저장 형식이나 Prompt 의미를 변경하지 않는다.

### P2 — Controller view/action adapter 추가

`ReferencePromptController`에 React가 사용할 최소 API를 추가한다.

권장 형태:

- `getViewSnapshot()` — 현재 view, preset, source/compiled text, clear 가능 여부,
  hint 및 native host 상태를 반환한다.
- `subscribeView(listener)` — 문서, preset, view, hint 변경을 알린다.
- 명시적 action — `clear`, `toggleView`, `copySource`, `copyCompiled`, `setPreset`.
- native host mount/unmount API — workspace와 definitions root의 수명을 명시한다.

Snapshot은 controller의 현재 document에서 파생한다. React에 두 번째
`PromptDocument`나 별도 history를 만들지 않는다.

입력 중에는 React가 contenteditable subtree를 재생성하지 않는다. Controller는
입력 DOM을 읽어 canonical document를 갱신하고, React에는 필요한 외곽 상태만
발행한다.

### P3 — 영구 React Prompt root

신규 파일:

- `frontend/src/reference-loader/components/prompt-react.tsx`

수정 파일:

- `frontend/src/reference-loader/components/prompt-editor.ts`
- `frontend/src/reference-loader/extension.ts`

구현 규칙:

1. `createRoot`는 Prompt widget instance마다 한 번만 호출한다.
2. React는 toolbar/status/host 배치를 렌더한다.
3. native controller는 명시적으로 제공된 workspace/definitions host 안에서만
   편집 DOM을 관리한다.
4. React가 관리하는 root를 controller의 `innerHTML`로 덮어쓰지 않는다.
5. native host가 교체될 때는 drag listener를 정리한다.
6. `extension.ts`의 Prompt reference subscription과 Loader의
   `subscribePromptReferences` 계약은 유지한다.

처음에는 Subject/Shot definitions와 section body를 native host로 유지한다.
이 단계의 성공 기준은 Prompt shell의 React ownership이지 contenteditable의
React 재작성이나 Prompt schema 변경이 아니다.

### P4 — shell 이벤트 소유권 이전

React로 옮긴 toolbar action은 React handler가 직접 controller action adapter를
호출한다. 같은 버튼을 `prompt-editor.ts`의 delegated click handler가 다시
처리하지 않도록 한다.

반대로 다음 이벤트는 native host 안에 남긴다.

- input/change/composition/focusout
- contenteditable keydown/click
- mention picker interaction
- section/definition drag and drop

각 이벤트는 한 경로에서만 처리되어야 하며, copy/clear/toggle/preset 변경이 두
번 실행되지 않아야 한다.

### P5 — 통합 검증 및 live 확인

자동 검증:

- `bun run typecheck`
- Prompt 관련 frontend unit tests
- `bun run test:unit`
- `bun run build`
- `bun run lint`
- `git diff --check`

Prompt widget을 포함한 live 검증:

- Nodes 2.0과 Legacy Canvas에서 Prompt shell 렌더 및 높이 측정
- Raw/Structured 전환 중 caret와 입력 focus 유지
- autocomplete 위치와 chip identity 유지
- Prompt Clear/Copy/restore 동작
- Subject/Shot와 frame 변경의 serialization 유지
- Loader Media reorder가 Prompt ordinal과 mention에 반영
- workflow/Snapshot restore 후 Prompt와 Media의 독립성
- node removal 후 React root, native listeners, picker cleanup

## 6. 완료 조건

다음 조건을 모두 만족해야 Prompt shell 전환 완료로 본다.

- Prompt widget instance마다 React root가 하나만 존재한다.
- React가 Prompt document나 history를 복제하지 않는다.
- toolbar와 shell action이 한 번만 실행된다.
- contenteditable, caret, chip, autocomplete, IME 동작이 유지된다.
- Raw/Structured, Copy, Clear, preset, restore 계약이 유지된다.
- 별도 definitions widget의 lifecycle과 Subject/Shot 상태가 유지된다.
- Loader reference reorder와 Prompt mention 갱신이 계속 동작한다.
- 두 node instance가 서로의 Prompt 상태를 오염시키지 않는다.
- node 제거 시 React/native 리소스가 모두 정리된다.

## 7. 후속 범위

Prompt shell이 안정된 뒤에만 다음을 별도 계획한다.

- Prompt section body와 Subject/Shot card의 점진적 React 전환
- contenteditable/chip/autocomplete native island의 축소 여부 검토
- H3 Guide 카드와 Timeline Guide의 React 복구
- native H3 conditioning 및 live checkpoint 검증

Prompt shell 전환과 H3 Guide 복구를 같은 변경 단위에 넣지 않는다.

## 8. 장기 고려사항 — React-owned Prompt editor

현재 native Prompt editor는 migration 중의 명시적인 임시 경계다. React shell이
native host를 감싸는 것만으로는 `contenteditable`, caret/selection, chip,
autocomplete, IME, paste, undo 로직이 사라지지 않는다. 장기적으로 이 부채를
줄여야 할 때는 contenteditable 영역 자체도 React가 소유하는 `PromptEditor`
컴포넌트로 전환한다.

여기서 React 소유권은 매 입력마다 JSX의 `value`로 contenteditable subtree를
재생성한다는 뜻이 아니다. React는 editor lifecycle, commands, host, picker와
외곽 상태를 소유하고, 편집 surface는 uncontrolled DOM 또는 전용 editor
engine이 selection과 composition을 보존하는 방식으로 구현한다. 현재처럼
Controller와 React가 각각 Prompt document를 수정하는 두 번째 store는 만들지
않는다.

Prompt shell과 카드 외곽 전환이 끝난 뒤 editor surface를 React-owned로 옮길
때의 세부 순서는 다음과 같다.

1. 일반 텍스트 section body 하나를 React `PromptEditor`로 옮기고, 기존
   `PromptDocument` serialization과 graph transaction을 유지한다.
2. atomic media/Subject/Shot chip과 source/compiled 변환을 추가한다.
3. autocomplete, Enter/Backspace, paste, IME composition, selection 복원을
   차례로 이전한다.
4. Raw/Structured, restore, undo, workflow/Snapshot 및 두 Prompt instance
   독립성의 parity를 확인한다.
5. live ComfyUI 검증이 끝난 뒤에만 기존 native editor event/render 경로를
   삭제한다.

전면 React editor는 현재 Prompt shell migration이나 H3 Guide 복구에 섞지
않는다. 요구사항이 계속 커져 직접 만든 controlled contenteditable의 유지비가
커질 때 전용 editor model/engine 도입을 별도 결정하며, 그 전까지는 native
editor에 새 기능을 계속 쌓지 않고 이 문서의 후속 범위로 분리한다.

## 9. 권장 후속 React 마이그레이션 순서

Prompt shell 전환 이후의 작업은 다음 순서로 진행한다. 각 단계는 이전 단계의
검증 결과를 baseline으로 삼으며, 두 개 이상의 큰 React 전환을 하나의 변경
단위에 넣지 않는다.

### 9.1 P5 — Prompt shell live gate 닫기

먼저 현재 shell 전환이 실제 ComfyUI 환경에서도 안정적인지 확인한다.

- Nodes 2.0과 Legacy Canvas에서 Prompt shell 렌더와 높이 측정을 확인한다.
- Raw/Structured 전환, caret/focus, autocomplete 위치, chip identity를
  확인한다.
- Clear/Copy/restore, Subject/Shot와 frame serialization을 확인한다.
- Loader Media reorder가 Prompt ordinal과 mention에 반영되는지 확인한다.
- 같은 Reference Loader 내부의 Media reorder만 허용하고, 다른 Reference Loader에
  드롭하면 target order와 Guide state가 변하지 않는지 확인한다.
- workflow/Snapshot restore 후 Prompt와 Media instance가 서로 독립적인지
  확인한다.
- node 제거 시 React root, drag listener, picker ref가 모두 정리되는지 확인한다.

이 단계가 끝나기 전에는 다음 UI 영역을 React로 옮기지 않는다. 자동화 테스트가
통과했더라도 live ComfyUI 동작과 lifecycle까지 검증된 것으로 간주하지 않는다.

### 9.2 P6 — Subject/Shot Definitions card shell

다음은 별도 `REFERENCE_PROMPT_DEFINITIONS` widget의 card shell이다. 이 위젯에
React root를 하나 만들고, Controller는 snapshot과 action adapter만 제공한다.

React가 소유할 영역:

- Definitions header와 Subjects/Shots subheader
- Subject/Shot 추가 버튼
- card toolbar, ordinal, tag input과 reorder/remove action
- Shot frame control과 현재 draft 상태
- Apply/Cancel 등 draft transaction action

각 definition body의 `contenteditable`, chip, autocomplete는 이 단계에서
native host로 유지한다. React가 rerender할 때 body subtree를 재생성하지 않으며,
Controller의 `PromptDocument`와 history를 두 번째 store로 복제하지 않는다.

card의 React `key`는 변경될 수 있는 `#tag`가 아니라 Subject/Shot의 안정적인
identity를 사용한다. Tag rename, reorder, remove, Shot frame 변경, draft
Apply/Cancel, serialization과 restore가 기존 계약과 동일해야 한다.

### 9.3 P7 — Prompt section card shell

Definitions card가 안정된 뒤 Prompt workspace의 section card 외곽을 옮긴다.

React가 소유할 영역:

- section header와 section label
- drag handle, remove/collapse 같은 외곽 action
- section color와 card layout
- native editor body를 연결하는 stable host

section body의 `contenteditable`, caret, chip, autocomplete, IME 이벤트는 계속
native host에서 처리한다. 이 단계의 핵심은 state 변경 때 workspace 전체를
`replaceChildren()`하지 않고, 이미 활성화된 editor host와 selection을 보존하는
것이다.

### 9.4 P8 — 일반 텍스트 editor surface 한 개

카드 shell이 안정된 후에만 일반 텍스트 section body 하나를 React-owned
`PromptEditor`로 시험한다. 처음부터 전체 section, chip, autocomplete를 함께
옮기지 않는다.

- React는 editor lifecycle, command, host 연결과 외곽 상태를 소유한다.
- 편집 surface는 uncontrolled DOM 또는 selection/composition을 보존하는
  전용 editor engine으로 구현한다.
- 매 입력마다 JSX `value`로 contenteditable subtree를 다시 만들지 않는다.
- canonical `PromptDocument`, serialization, graph transaction은 기존
  Controller 경계를 유지한다.

일반 텍스트 입력의 parity가 확인된 뒤에만 atomic media/Subject/Shot chip과
source/compiled 변환을 추가한다.

### 9.5 P9 — 편집 동작을 단계적으로 이전

다음 동작은 한 번에 모두 이전하지 않고 각각 regression test를 추가하면서
옮긴다.

1. autocomplete와 mention picker
2. Enter/Backspace 및 chip 경계 동작
3. paste와 text normalization
4. IME composition
5. selection/caret 복원과 focus 이동
6. undo/restore 및 workflow/Snapshot parity

각 단계에서 Prompt instance 두 개의 독립성, Subject/Shot serialization,
Raw/Structured 변환을 함께 확인한다.

### 9.6 P10 — native editor 경로 제거

P10 전에 남아 있는 editor surface의 React 이전은
[REACT_PROMPT_REMAINING_MIGRATION_PLAN.md](./REACT_PROMPT_REMAINING_MIGRATION_PLAN.md)에서
별도로 단계화한다.

React-owned editor와 기존 native editor의 동작이 동일하다는 자동화 및 live
검증이 끝난 뒤에만 기존 native event/render 경로를 삭제한다. 남아 있는 native
host가 있다면 해당 host의 소유자, cleanup, action dispatch 경계를 문서화한 뒤
다음 단계로 진행한다.

### 9.7 H3 Guide는 별도 트랙

H3 Guide card, Timeline Guide, native H3 conditioning과 checkpoint 검증은 위
Prompt migration과 같은 변경 단위에 넣지 않는다. Prompt editor migration의
live gate가 닫힌 뒤 별도 계획과 별도 runtime 검증으로 진행한다.

## 10. 공통 불변 조건

모든 단계에서 다음 조건을 유지한다.

- React와 Controller가 각각 Prompt document/history를 갖지 않는다.
- action은 React 또는 native 중 한 경로에서만 dispatch한다.
- React root는 widget instance마다 하나만 존재하며 destroy는 idempotent하다.
- stable host 밖의 `innerHTML`/`replaceChildren()`로 활성 편집 DOM을 덮어쓰지
  않는다.
- Prompt schema, source `#tag`, compiled output, graph transaction 계약을
  UI 전환과 분리한다.
- live ComfyUI 검증 전에는 기존 native 경로를 삭제하지 않는다.

## 11. P8 실행 기록 (2026-09-08)

- text-only section 중 하나만 stable identity로 React `PromptEditor`가 소유한다.
  contenteditable DOM은 uncontrolled로 유지하고, 입력/IME 종료 시 Controller의
  단일 PromptDocument에 반영한다.
- 다른 section body와 chip/autocomplete는 native host에 남긴다. React editor의
  input/keydown/composition 이벤트는 native delegated handler와 중복 처리하지
  않으며, reorder·preset·restore에서도 editor DOM identity를 유지한다.
- `bun run typecheck`, frontend 257개 테스트, `git diff --check`와 변경 파일
  포맷 검사를 통과했다. 실제 ComfyUI Nodes 2.0/Legacy Canvas live 검증은 아직
  수행하지 않았으므로 P8 live 완료로 표시하지 않는다.

## 12. 현재 구현 상태 (2026-09-08)

상위 계획의 P6-P9 순서를 다시 실행할 필요가 없도록 현재 코드 기준을
고정한다. `REACT_PROMPT_REMAINING_MIGRATION_PLAN.md`의 R0-R6에서 이미
모든 Structured section body, Raw editor, Subject/Shot definition body,
picker list, section entry와 drag/drop을 React ownership으로 이전했다.

- production `ReferencePromptController`에는 `legacyShell` option이 없으며,
  `extension.ts`는 기본 Controller와 React roots를 연결한다.
- P10에서 legacy toolbar/workspace/definition/picker renderer, delegated
  click/input/change/keydown/composition/drag branch, stale host adapter를
  삭제했다.
- picker DOM은 React가 소유하고, 목록 스크롤은 브라우저 기본 `overflow: auto`를
  사용한다. Prompt production path에는 wheel interception native island가 없다.
- `prompt-cards.ts`에는 React가 uncontrolled editor 초기 내용을 채우는 detached
  body builder만 남긴다. 삭제된 legacy card/definition shell builder는 재사용하지
  않는다.
- 사용자가 Nodes 2.0/Legacy Canvas live cleanup check 통과를 확인한 뒤 P10을
  진행했다. 이 실행에서는 live session을 독립 재실행하지 않았으므로 추가
  mount/resize/focus/IME 및 workflow parity는 별도 gate로 남긴다.

현재 다음 단계는 P6-P9 재작업이 아니라, 자동 검증 결과를 기준으로 live
ComfyUI parity를 별도 확인하고 H3 Guide/Timeline 트랙을 독립적으로 계획하는
것이다.
