# Reference Loader Prompt 남은 React migration 계획

작성 기준: 2026-09-08
상위 계획: [REACT_PROMPT_MIGRATION_PLAN.md](./REACT_PROMPT_MIGRATION_PLAN.md)

상태: R0-R6 자동 구현·검증 및 P10 legacy cleanup 완료; live ComfyUI parity는 사용자 확인 범위만 반영

## 1. 목적

이 계획이 시작될 당시 Prompt는 React shell과 native editor host가 함께
동작했다. 그 혼합 구조를 surface별 소유권 분리 단계로 해소했고, 현재
production path는 React shell과 Controller의 canonical state 경계만 남긴다.

이 문서는 다음 순서를 고정한다.

1. 남아 있는 editor surface를 React 소유로 이전한다.
2. Controller와 React 사이의 단일 action/state 경계를 유지한다.
3. 자동화 및 live ComfyUI parity를 확인한다.
4. 그 뒤에만 P10에서 legacy native 경로를 삭제한다.

## 2. 현재 기준

현재 production Prompt widget은 `createPromptReact()`가 외곽 shell을 렌더하며,
Controller에는 legacy shell 선택지가 없다.

현재 production 구조의 실제 분리는 다음과 같다. 상세한 node/event/cleanup
소유권은 [REACT_PROMPT_OWNERSHIP_LEDGER.md](./REACT_PROMPT_OWNERSHIP_LEDGER.md)에
고정한다.

| Surface                                                | 현재 소유자                               | 근거                                                       |
| ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| Prompt toolbar/status/workspace 배치                   | React                                     | `components/prompt-react.tsx`                              |
| 모든 Structured section body                           | React uncontrolled `PromptEditor`         | `PromptSectionSnapshot.editor === "react-text"`            |
| Raw editor                                             | React uncontrolled `PromptEditor`         | `renderReactRawEditor()`와 Controller raw parser           |
| Subject/Shot card와 body                               | 별도 React root                           | `prompt-definitions-react.tsx`, stable definition identity |
| `@`/`#` picker 표시                                    | React portal                              | `PromptPicker`와 picker snapshot                           |
| picker query/range/activation                          | Controller                                | picker state와 editor command                              |
| section entry와 drag/drop                              | React handler + Controller action adapter | `PromptSectionEntry`, `PromptSectionCard`                  |
| canonical document, serialization, history/transaction | Controller                                | `ReferencePromptController`                                |

P10 cleanup으로 legacy shell/host/event branch와 picker event interception은
제거되었다. Controller는 canonical state와 editor command만 유지하고, picker
목록은 브라우저 기본 `overflow: auto` 스크롤을 사용한다.

따라서 React migration의 대상은 Prompt document를 React에 복제하는 것이
아니다. React가 각 DOM surface의 render/lifecycle/event ownership을 가져오고,
Controller는 canonical state와 편집 command/editor engine을 계속 소유한다.

## 3. 목표와 비목표

### 목표

- 모든 Prompt editor surface에 대해 React 또는 명시적인 native-island 소유자를
  하나만 둔다.
- Structured 모든 section의 본문 편집을 같은 React editor surface로 통일한다.
- Raw/Structured 전환, `@` mention, `#` Subject/Shot, chip 경계, paste, IME,
  selection/caret, undo/restore를 기존 동작과 동일하게 유지한다.
- React root와 editor DOM identity를 유지해 focus와 selection을 보존한다.
- P10에서 삭제할 legacy branch와 React가 직접 소유할 surface를 구분한다.

### 비목표

- `PromptDocument`, serialization schema, compiled output 형식 변경
- React 내부에 두 번째 document/history/store 생성
- H3 Guide, Timeline, Start/End, native H3 conditioning 변경
- Media Loader React migration 또는 image/trim editor 내부 재작성
- contenteditable 내부를 매 입력마다 JSX `value`로 다시 만드는 controlled editor

## 4. 설계 불변 조건

1. `PromptDocument`와 history의 canonical owner는 Controller 하나다.
2. 하나의 사용자 action은 React 또는 native 중 한 경로에서만 dispatch한다.
3. React는 Controller snapshot을 `useSyncExternalStore`로 구독하고 명시적인
   action adapter를 호출한다.
4. 편집 중인 contenteditable subtree는 React rerender로 교체하지 않는다.
5. React-owned subtree 안에서는 Controller의 delegated handler가 조용히
   return해야 한다.
6. native island를 유지할 경우 host, listener, cleanup, action 경계를 문서와
   테스트에 남긴다.
7. 두 Prompt widget instance, workflow restore, Snapshot, queue, destroy가 서로
   영향을 주지 않는다.

## 5. 남은 migration 단계

### R0 — ownership ledger와 gate 고정

작업 전에 각 DOM node와 이벤트의 소유자를 표로 고정한다.

- `PromptSectionSnapshot.editor`의 `native` 사용 지점을 모두 나열한다.
- `mountSectionHosts`, `mountRawEditorHost`, `mountDefinitionHosts`,
  `mountPromptWorkspace`의 호출자와 cleanup을 확인한다.
- `#installEditableRootEvents()`가 처리하는 click/input/change/keydown/
  composition/drag 경로를 React-owned subtree별로 분류한다.
- 기존 P5/P6/P8 live gate가 닫히지 않았다면 P10 삭제를 시작하지 않는다.

완료 기준:

- 모든 active editor surface에 owner가 정확히 하나 있다.
- 삭제 후보와 유지할 native island가 구분된다.
- React/native event 중복을 재현하는 fixture가 있다.

### R1 — 모든 Structured section body 이전

현재 `react-text` 하나와 native body host가 섞인 구조를, 모든 Structured
section이 동일한 React editor component를 사용하도록 바꾼다.

- `PromptEditor`를 section 하나에만 묶지 않고 section title별 stable identity로
  mount한다.
- editor는 uncontrolled DOM으로 유지하고 입력 시 Controller command를 호출한다.
- section 추가/삭제/순서 변경에서도 현재 editor DOM과 focus를 불필요하게
  교체하지 않는다.
- 기존 `makePromptSectionBody()`의 text, mention, Subject/Shot tag rendering
  규칙을 React editor engine과 동일하게 유지한다.
- native section body host에만 걸린 delegated handler는 React editor를
  건드리지 않도록 명시적으로 차단한다.

회귀 기준:

- 여러 section에 동시에 입력할 수 있다.
- section reorder 후 source/compiled text와 focus가 유지된다.
- `@`, `#`, Enter, Backspace/Delete, paste, IME가 section별로 독립 동작한다.
- 두 Prompt instance의 picker와 selection이 섞이지 않는다.

### R2 — 편집 engine parity 확장

R1의 공통 React editor에 P9 동작을 모두 적용한다.

- `@` mention chip 삽입/삭제와 media reference rebinding
- `#` Subject/Shot autocomplete와 source tag 보존
- atomic chip 오른쪽 경계의 Backspace/Delete
- paste와 multiline normalization
- IME composition 시작/종료 및 마지막 문자 보존
- selection/caret 복원, picker 선택 후 caret 이동, focus 이동
- Raw/Structured 전환 전후의 document parity
- undo/redo, restore, Snapshot, queue 직전 serialization parity

이 단계에서 React component는 화면과 DOM lifecycle을 담당하고, Controller의
기존 tag scanner, rename, serialization, transaction 규칙은 재사용한다. 의미가
다른 새 parser나 React 전용 document를 만들지 않는다.

### R3 — Raw editor 이전

`mountRawEditorHost()`와 `#renderRawEditor()`가 관리하는 Raw editor를 React
host로 이전한다.

- Raw source 입력의 multiline/blank-line/HTML normalization을 보존한다.
- Raw view에서의 caret, paste, IME, clear, restore를 확인한다.
- Raw에서 Structured로 전환할 때 기존 recovery/legacy parsing 결과를
  Controller document에 한 번만 반영한다.
- Structured에서 Raw로 전환할 때 React section editor를 불필요하게 재생성하지
  않고 view snapshot만 바꾼다.

완료 후 `mountRawEditorHost()`는 production path에서 호출되지 않아야 한다.

### R4 — Subject/Shot definition body 이전

현재 React card shell 안에 남아 있는 native body host를 정리한다.

- card의 tag input, frame input, body, add/remove/reorder 버튼의 owner를
  React로 명확히 한다.
- tag 입력의 `#` prefix 정규화와 public `renameDefinition()` 재검증을
  유지한다.
- Subject/Shot body의 tag highlight, source text, Shot frame draft,
  Apply/Cancel/restore semantics를 유지한다.
- card reorder나 rename 시 body DOM identity와 active focus를 보존한다.

완료 후 `mountDefinitionHosts()`와 `#renderDefinitionBodies()`는 제거하고,
definitions card/body는 별도 React root가 소유한다.

### R5 — picker와 section interaction ownership 정리

Picker는 caret/Range와 강하게 연결되어 있으므로 state와 DOM 책임을 분리한다.

- React가 picker list, active option, empty/create state, keyboard presentation을
  렌더한다.
- Controller가 query 계산, anchor Range, option activation, document 변경을
  계속 소유한다.
- Arrow, Enter, Escape, outside click, IME/delete close behavior를 한 경로로
  처리한다.
- section entry, remove, reorder, drag/drop 이벤트도 React action adapter와
  Controller command 중 하나만 호출하도록 정리한다.
- React-owned picker/editor subtree에 대해 native delegated handler가 중복
  동작하지 않는지 확인한다.

### R6 — production path 전환과 cleanup 준비

모든 surface의 parity가 확인되면 production path를 React-only shell로 고정한다.

- `legacyShell` production option과 caller를 제거한다.
- React-owned subtree를 위해 남아 있는 native delegated branch를 삭제 후보로
  표시한다.
- `innerHTML`/`replaceChildren()`가 active React editor를 덮는 호출이 없는지
  확인한다.
- `destroy()`에서 React root, native island, Controller listener가 각각 한 번만
  해제되는지 확인한다.
- 삭제 전후로 DOM widget serialization index와 ComfyUI widget lifecycle이
  변하지 않는지 확인한다.

이 단계의 결과가 P10 진입 조건이다. 이 단계에서 legacy 코드를 아직 실제로
삭제하지 않고, production caller와 테스트 coverage를 먼저 닫는다.

## 6. P10 진입 조건

다음 조건을 모두 만족하기 전에는 기존 native render/event 경로를 삭제하지
않는다.

- 모든 Structured section body가 React surface 또는 명시된 native island다.
- Raw editor의 production native host 사용이 없어졌다.
- Definition body의 production native host 사용이 없어졌다.
- picker/drag/drop/section entry의 owner와 cleanup이 문서화되어 있다.
- React/native 중복 dispatch 회귀 테스트가 있다.
- frontend 전체 테스트, typecheck, format, lint, build가 통과한다.
- Nodes 2.0과 Legacy Canvas에서 다음 live 검증이 통과한다.
  - mount/resize/focus/IME
  - Prompt 두 instance 독립성
  - Raw/Structured 전환
  - workflow/Snapshot restore
  - queue 직전 serialization
  - node removal/destroy와 늦은 이벤트 차단

그 후 P10에서만 다음을 삭제한다.

- `legacyShell` 전체 render branch (완료)
- 더 이상 호출되지 않는 native section/Raw/definition render branch
- React-owned subtree를 위한 중복 delegated event branch
- 삭제된 host에 대한 stale mount/unmount adapter

## 7. 검증 순서

각 단계는 해당 surface의 focused test를 먼저 추가한 뒤 전체 검증을 실행한다.

```text
focused React/Prompt tests
  -> bun run typecheck
  -> bun run test:frontend
  -> bun run test:backend
  -> bun run fmt:check
  -> bun run lint
  -> bun run build
  -> git diff --check
  -> live ComfyUI Nodes 2.0 / Legacy Canvas
```

Windows에서 전역 `uv` cache 또는 pytest temp 권한 오류가 발생하면 저장소
내부의 repository-local cache/temp를 사용해 명령을 재실행하고, 권한 오류와
코드 실패를 구분해 기록한다.

## 8. 최종 원칙

P10의 목적은 Controller를 제거하거나 모든 편집 규칙을 TSX에 복사하는 것이
아니다. 목적은 **React가 모든 Prompt view surface의 소유자가 되고, Controller는
하나의 canonical state와 editor command 경계로 남는 것**이다.

따라서 native DOM이 최종적으로 일부 남더라도, 그것이 명시적인 native island이고
React와 소유권이 겹치지 않으면 migration 실패가 아니다. 반대로 native 경로가
남아 있지 않더라도 React와 Controller가 각각 document/history를 복제하면
migration 완료로 보지 않는다.

## 9. 구현 및 검증 기록 (2026-09-08)

| 단계                            | 결과                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 ownership ledger             | 완료. production surface, event path, mount/cleanup 경계를 [REACT_PROMPT_OWNERSHIP_LEDGER.md](./REACT_PROMPT_OWNERSHIP_LEDGER.md)에 기록했다.                                                                                    |
| R1 Structured section body      | 완료. 모든 section이 stable title key의 공통 uncontrolled React `PromptEditor`를 사용한다.                                                                                                                                       |
| R2 editor parity                | 완료. mention/chip deletion, `@`/`#` picker, paste stop, IME, caret, restore, source/compiled sync와 instance isolation fixture를 추가했다.                                                                                      |
| R3 Raw editor                   | 완료. Raw view가 React `PromptEditor`가 되었고 production `mountRawEditorHost()` 호출은 없다. Raw/Structured 전환은 Controller parser를 한 번만 사용한다.                                                                        |
| R4 Subject/Shot definition body | 완료. 별도 definitions React root가 card, fields, body와 draft actions를 소유하며 production `mountDefinitionHosts()`/`#renderDefinitionBodies()` path는 사용하지 않는다.                                                        |
| R5 picker/section interaction   | 완료. picker list와 empty/create state는 React가 렌더하고 Controller가 query/Range/insertion을 소유한다. section entry와 drag/drop/Alt reorder는 React action adapter를 사용하며, picker 목록은 브라우저 기본 스크롤을 사용한다. |
| R6 production path              | 완료. `extension.ts`는 기본 React Controller와 React/definitions root cleanup을 연결하며, legacy option/delegated branch는 P10에서 제거했다.                                                                                     |

자동 검증은 최신 코드에서 다음과 같이 통과했다.

- `bun run test:frontend`: 263 pass, 0 fail
- `bun run test:backend`: 196 pass, 1 pytest cache warning. 전역 uv cache와
  기존 temp root의 권한 오류를 피하기 위해 repository-local uv cache와 새
  `--basetemp`를 사용했다.
- `bun run typecheck`
- `bun run fmt:check`
- `bun run lint`
- `bun run build`
- `git diff --check`

사용자가 Nodes 2.0/Legacy Canvas의 live cleanup check가 통과했다고 확인한
뒤 P10 legacy render/event branch 삭제를 수행했다. 이 코드 검증 실행에서는
사용자가 Nodes 2.0/Legacy Canvas의 live mount/resize/focus/IME 및 workflow
parity 검증이 통과했다고 확인했다. P10 이후 유지한 것은 Controller의
canonical state/serialization이며, picker wheel interception은 제거되었다.
