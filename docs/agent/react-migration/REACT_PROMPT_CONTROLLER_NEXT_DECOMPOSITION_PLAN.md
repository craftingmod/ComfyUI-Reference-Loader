# Reference Loader Prompt Controller 후속 분해 계획

작성 기준: 2026-09-14  
상태: C0~C4 경계 추출 후속 계획

## 1. 목적

현재 C0~C4 작업으로 `PromptStore`, `PromptEditorEngine`,
`ComfyPromptAdapter`, React bridge가 분리되었다. 그러나
`ReferencePromptController`에는 아직 Prompt 도메인의 변경 명령, Picker 상태,
snapshot projection, graph transaction 조정이 함께 남아 있다.

이 문서의 목표는 Controller를 무조건 여러 클래스로 쪼개는 것이 아니다. 다음 두
가지 책임을 분리해 Controller를 실제 compatibility facade에 가깝게 줄이는 것이다.

1. Prompt document를 변경하는 application command
2. `@`/`#`/`/` Picker의 query, option, activation

snapshot은 우선 순수 projection 함수로만 분리하고, drag/drop은 이 계획에서
별도 클래스로 추출하지 않는다.

## 2. 현재 판단

### 2.1 분리할 가치가 있는 이유

`prompt-editor.ts`는 약 2,000줄 규모이며 다음 변경 경로를 한 파일에서 직접
조정한다.

- `PromptStore` 변경과 body revision/epoch 갱신
- Shot draft와 Raw/Structured 전환
- Section/Subject/Shot 추가·삭제·이름 변경·순서 변경
- Picker query와 option activation
- snapshot 생성 및 React listener 통지
- graph `beforeChange`/`afterChange`, dirty canvas, render 재조정

이 상태에서는 새 Prompt 명령을 추가할 때 Store, graph transaction, snapshot,
React 통지를 한꺼번에 수정해야 한다. 기능별 contract test도 DOM과 ComfyUI node
mock에 불필요하게 의존하게 된다.

### 2.2 과분할을 피해야 하는 이유

다음 객체를 각각 새로 만들지는 않는다.

- `PromptLifecycle`
- `PromptNotification`
- `PromptDragController`
- 단일 구현만 가진 generic command/factory/interface

이런 객체는 책임을 실제로 소유하기보다 Controller의 private method와 상태를
여러 파일로 흩어 놓을 가능성이 높다.

## 3. 최종 소유권

| 경계 | 소유하는 것 | 소유하지 않는 것 |
| --- | --- | --- |
| `PromptStore` | canonical `PromptDocument`, parse/compile/serialize, 순수 document command | DOM, graph transaction, React snapshot |
| `PromptMutationCoordinator` | 변경 use-case, draft, body revision/epoch, graph transaction callback 조정 | DOM query, Picker option 목록, React listener |
| `PromptEditorEngine` | editor handle, flush, caret/IME 및 native editor event 경계 | canonical document, Picker query/목록 |
| `PromptPickerController` | Picker mode/query/options/index/anchor와 activation 조정 | canonical document 직접 소유, React root, ComfyUI widget |
| projection functions | Sections/Definitions/Picker view model 계산 | listener lifecycle, document mutation |
| `ReferencePromptController` | public compatibility API, 객체 조합, 최소한의 invalidate/notify 연결 | Prompt mutation 세부 구현, Picker 세부 구현 |

`PromptDocument`의 canonical owner는 계속 `PromptStore` 하나로 유지한다.
`PromptMutationCoordinator`는 document를 별도로 보관하지 않고 Store를 호출한다.

## 4. 단계

### D1 — Prompt mutation coordinator 추출

`ReferencePromptController`의 semantic write path를 먼저 이동한다.

이동 대상:

- `applyPromptBodyEdit`
- Section add/remove/reorder
- Subject/Shot add/remove/rename/reorder
- Shot draft의 frame 변경, apply, cancel, remove
- Raw draft apply와 Raw/Structured 전환
- `clear`, restore 후 body epoch/revision reset
- `#recordGraphChange`를 통한 transaction 경계

규칙:

- Store만 document를 변경한다.
- coordinator는 DOM을 읽거나 snapshot을 만들지 않는다.
- graph transaction과 dirty 알림은 주입된 좁은 callback을 사용한다.
- 변경 결과는 `changed`, `reason`, 필요한 reset 정보처럼 테스트 가능한 값으로
  반환한다.
- Controller는 결과에 따라 기존 render/notify 계약을 연결하는 동안만 조정한다.

contract test:

- 정상 변경은 graph transaction을 한 번만 연다.
- invalid/no-op/stale 변경은 document와 dirty 상태를 바꾸지 않는다.
- Shot draft apply/cancel과 Raw conflict의 기존 parity를 유지한다.
- definition 삭제 실패와 중복 tag 오류가 기존 hint 계약을 유지한다.

완료 기준:

- Controller에 document mutation algorithm이 남지 않는다.
- `PromptStore`가 여전히 유일한 canonical document owner다.
- 기존 Controller public API와 widget serialization은 변경되지 않는다.

### D2 — Picker controller 추출

Picker의 UI-independent state와 activation을 이동한다.

이동 대상:

- reference/subject/alias mode
- query filtering과 option index
- anchor/target 계산에 필요한 logical target
- ArrowUp/ArrowDown/Enter/Escape 처리
- reference, subject, shot, alias, create-subject activation

경계:

- caret와 editor handle은 `PromptEditorEngine`이 계속 소유한다.
- Picker controller는 선택 결과를 mutation coordinator 또는 editor handle에
  위임한다.
- React는 option을 렌더링하고 typed action만 호출한다.
- Controller는 Picker controller를 만들고 기존 public picker API를 forwarding한다.

contract test:

- 동일 query의 option 순서와 active index를 유지한다.
- disabled/empty/invalid target에서 activation하지 않는다.
- `@`, `#`, `/` 각각의 activation이 올바른 mutation/editor 경계로 간다.
- 서로 다른 Controller instance의 Picker state가 섞이지 않는다.
- destroy 뒤 listener, activation, late update가 실행되지 않는다.

완료 기준:

- Controller에 `#pickerReferences`, `#pickerSubjects`, `#pickerAliases`,
  `#pickerIndex`와 해당 query/activation algorithm이 남지 않는다.
- EditorEngine과 Picker controller가 caret/activation 책임을 중복 소유하지 않는다.

### D3 — snapshot projection의 순수 함수화

다음 private builder를 우선 side-effect 없는 함수로 바꾼다.

- sections snapshot
- definitions snapshot
- picker snapshot
- mention/definition label 및 visual projection

함수는 Store snapshot, reference snapshot, preset, locale, draft 정보를 인자로
받고 DOM이나 Controller private field에 직접 접근하지 않는다.

이 단계에서는 별도의 `PromptViewController`를 만들지 않는다. listener set,
cache invalidation, React subscription lifecycle은 Controller에 남겨 두고, 순수
projection만 독립적으로 테스트한다.

완료 기준:

- 동일 입력에 동일 snapshot이 반환된다.
- projection test가 DOM과 ComfyUI node 없이 실행된다.
- projection 추출로 호출 경로가 복잡해지면 이 단계의 추가 분리는 중단한다.

### D4 — facade 축소와 caller 전환

D1~D3의 caller를 순서대로 새 경계에 연결한다.

- React bridge는 Controller 내부 algorithm이 아니라 typed command를 호출한다.
- ComfyPromptAdapter는 widget lifecycle만 담당한다.
- Controller public method는 mutation/picker/coordinator forwarding과 기존 호환
  계약만 남긴다.
- 기존 private DOM render와 legacy compatibility branch는 모든 caller가 전환된
  뒤에만 삭제한다.

최종 Controller에는 다음만 남기는 것을 목표로 한다.

- Store, mutation coordinator, editor engine, picker controller 조합
- public API forwarding
- snapshot cache/listener의 최소 연결
- 외부 lifecycle에 대한 idempotent destroy

## 5. 실행 순서와 안전장치

1. D1을 먼저 수행한다. 모든 기능 변경이 결국 document mutation과 graph
   transaction을 거치므로 가장 큰 중복을 먼저 제거한다.
2. D1 contract test가 통과한 뒤 D2로 진행한다.
3. D3은 순수 함수 추출만 수행하고, listener/lifecycle 재설계는 하지 않는다.
4. 각 단계에서 public API와 workflow serialization을 유지한다.
5. 한 단계의 변경이 live ComfyUI 검증을 어렵게 만들면 다음 단계로 진행하지
   않고 해당 경계의 contract test와 restore/queue/destroy 검증을 먼저 보강한다.

## 6. 보존해야 할 계약

- canonical `PromptDocument` owner는 하나다.
- Lexical local undo/redo와 ComfyUI graph/workflow undo를 Store history로
  중복하지 않는다.
- source/compiled Prompt 변환과 v6 serialization을 바꾸지 않는다.
- graph transaction과 dirty notification의 호출 횟수를 유지한다.
- IME, caret/selection, paste, 마지막 문자, restore 후 local history 경계를
  유지한다.
- Prompt widget 두 개의 상태와 Picker가 서로 섞이지 않는다.
- H3 Guide/Timeline conditioning은 이 계획에 포함하지 않는다.

## 7. 하지 않는 것

- 새 global state library 도입
- Prompt schema/backend contract 변경
- Controller 이름 변경만을 위한 cosmetic refactor
- drag/drop만을 위한 별도 Controller 생성
- snapshot listener를 위한 범용 event bus 도입
- live parity 전에 대규모 파일 이동

## 8. 완료 기준

- `ReferencePromptController`의 public API가 기존 contract test와 동일하게
  동작한다.
- mutation coordinator와 Picker controller에 독립적인 contract test가 있다.
- Store, EditorEngine, ComfyPromptAdapter, React bridge의 단일 ownership이
  유지된다.
- Controller에 남은 private code가 조합, forwarding, 최소 subscription 연결로
  설명된다.
- frontend/backend typecheck, unit/contract test, lint, build가 통과한다.
- live ComfyUI Nodes 2.0/Legacy Canvas에서 mount, restore, queue, focus/IME,
  widget rebuild, node removal을 확인한다.

## 9. 판단 기준

D1과 D2 이후에도 각 객체가 실제 책임을 소유하지 않고 단순 forwarding만 늘어나면
분해를 중단한다. 목표는 파일 수를 늘리는 것이 아니라 Prompt 변경과 Picker
동작의 소유자를 명확히 하고, Controller를 외부 호환 facade로 만드는 것이다.
