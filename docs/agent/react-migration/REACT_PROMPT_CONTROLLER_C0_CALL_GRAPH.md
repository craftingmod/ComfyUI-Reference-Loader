# Prompt Controller C0 호출 그래프와 계약

작성 기준: 2026-09-14  
기준 코드: `frontend/refine1-react`, `c4245da`

이 문서는 `REACT_PROMPT_CONTROLLER_DECOMPOSITION_PLAN.md`의 C0 결과다. 파일을
기계적으로 나누기 위한 목록이 아니라, canonical Prompt 문서와 React/ComfyUI
lifecycle의 실제 소유자를 고정하기 위한 inventory다.

## 1. 현재 소유권

```text
PromptStore
  PromptDocumentV6, v6 validation, serialization, source/compiled projection

PromptEditorEngine
  body editor handle registry와 flush
  React editor paste/blur/undo event ownership

ComfyPromptAdapter
  Prompt/Definitions widget callback과 node-scoped Prompt lifecycle
  preset/reference binding과 rendered widget root rebind

PromptReactBridge / PromptDefinitionsReactBridge
  React root, typed action mapping, idempotent unmount

ReferencePromptController
  Store, EditorEngine과 ComfyUI adapter를 연결하는 public facade
  ComfyUI graph transaction과 dirty notification을 포함한 command 조정
  body revision/epoch, Raw draft, Shot draft
  editor/picker imperative command
  React용 view/section/definition/picker snapshot

React Prompt/Definitions mount
  snapshot을 구독하고 DOM surface를 렌더링
  document/history를 보유하지 않음

ComfyUILifecycleBridge
  node별 widget/root/subscription 등록, 교체, 제거와 idempotent teardown
```

`PromptStore`는 C1의 첫 절편으로 도입되었다. Controller 내부의
`#documentV6` 이름은 외부 호환을 위해 남아 있지만 private accessor로 Store를
통해서만 읽고 쓴다. React 컴포넌트에는 `PromptDocumentV6` 저장 필드가 없다.

## 2. 호출 그래프

```text
registerReferenceLoader(app, api)
└─ getCustomWidgets()
   ├─ REFERENCE_PROMPT_DEFINITIONS
   │  ├─ lifecycle.disposePromptDefinitions(node)
   │  ├─ lifecycle.setPromptDefinitionRoot(node, root)
   │  ├─ controller.mountDefinitions(root)
   │  ├─ createPromptDefinitionsReact({ container, controller })
   │  └─ lifecycle.setPromptDefinitionsReactMount(node, mount)
   └─ REFERENCE_PROMPT
      ├─ lifecycle.disposePrompt(node)
      ├─ new ReferencePromptController(node, references, serialized, options)
      ├─ controller.mountDefinitions(definitionsRoot) [definitions가 먼저 생성된 경우]
      ├─ createPromptReact({ container: root, controller })
      ├─ node.addDOMWidget(...)
      │  ├─ options.getValue()      → controller.serialize()
      │  ├─ options.setValue(value) → controller.restore(value)
      │  ├─ widget.serializeValue() → controller.serialize()
      │  └─ widget.beforeQueued()   → controller.serialize()
      ├─ lifecycle.attachPrompt(node, controller, cleanup)
      └─ promptAdapter.bindReferences(node)
         ├─ Loader.subscribePromptReferences() → controller.refreshReferences()
         └─ controller.subscribeShots() → Loader.setPromptShots(...commands)

`extension.ts`의 Prompt widget factory는 `ComfyPromptAdapter`로 위임한다.
Adapter가 widget callback, React mount, preset/reference subscription과
node-scoped cleanup을 조합하고, extension은 Loader/H3 widget 조합만 유지한다.

React mount
├─ PromptReactRoot
│  ├─ controller.subscribeView/Sections/Picker()
│  └─ actions → controller public editor/state commands
└─ PromptDefinitionsReactRoot
   ├─ controller.subscribeDefinitions()
   └─ actions → controller public definition/editor commands

각 root의 `PromptReactBridge`/`PromptDefinitionsReactBridge`가
`useSyncExternalStore` 기반 React tree와 typed action mapping을 소유한다.

node.onRemoved()
└─ lifecycle.disposeNode(node)
   ├─ registered cleanup을 등록 순서대로 release
   │  ├─ Loader/H3 resource cleanup
   │  └─ Prompt subscription, React root, Controller cleanup
   └─ 남은 node-scoped resource를 idempotent fallback cleanup
```

## 3. Controller method 분류

### State와 projection

| public/private | 책임 |
| --- | --- |
| `getPromptBodySnapshot`, `applyPromptBodyEdit`, `validatePromptBodyParts`, `parsePromptBodyText` | Store 문서를 editor command가 읽고 갱신할 수 있는 body 계약으로 변환 |
| `rawDraftText`, `updateRawDraftText`, `#ensureV6RawSession`, `#applyV6RawDraft` | Raw 임시 입력과 v6 source parse 경계 |
| `document`, `shots`, `setShotFrame`, `setShotFrameDraft`, `removeShot`, `applyShotDraft`, `cancelShotDraft` | Prompt/Shot canonical 상태와 transient Shot draft |
| `serialize`, `restore`, `compiledPrompt`, `#copyPrompt` | workflow/widget 저장과 source/compiled 출력 |
| `clear`, `toggleView`, `setPreset`, `refreshReferences` | document view와 runtime reference projection 동기화 |
| `#v6BodyOwner`, `#replaceV6Body`, `#v6Definition`, `#definitionRecords` | v6 identity 기반 상태 조회/변환 |
| `#renameV6Definition`, `#moveV6Definition`, `#removeV6Definition`, `#addDefinition` | definition command를 graph transaction 안에서 실행 |

### Editor와 picker imperative 동작

| public/private | 책임 |
| --- | --- |
| `registerPromptBodyEditor`, `handlePromptBodyTrigger` | React rich editor handle과 picker target 연결 |
| `handleReactEditorInput/Keydown/Paste/Blur` | React-owned editor의 event ownership과 IME/undo guard |
| `handleReactSectionEntryInput/Keydown` | section entry alias picker와 section 생성 |
| `start/endSectionDrag`, `sectionDragOver`, `dropSection` | section drag/drop |
| `start/endDefinitionDrag`, `definitionDragOver`, `dropDefinition` | definition drag/drop |
| `movePicker`, `activatePickerOption`, `closePicker` | picker command |
| `#update*Picker`, `#placePicker`, `#insert*`, `#handlePickerKeydown` | query, anchor, activation의 imperative 부분 |

### React snapshot과 mount

`mountPromptWorkspace`, `unmountPromptWorkspace`, `mountDefinitions`,
`mountPickerElement`, `unmountPickerElement`는 native host 참조만 관리한다.
`get*Snapshot`과 `subscribe*`는 각각 React `useSyncExternalStore`의
controller-facing boundary다. snapshot은 canonical 문서의 복사본이 아니라
현재 Store 문서와 runtime reference를 투영한 값이다.

### ComfyUI 경계

Controller 안의 `#recordGraphChange`가 `node.graph.beforeChange/afterChange`를
감싸고, 각 상태 command가 `node.setDirtyCanvas(true, true)`를 호출한다.
widget 등록과 Prompt widget callback 조합은 `ComfyPromptAdapter`가,
node removal, rendered-root rebind, React root destroy는
`ComfyUILifecycleBridge`/Prompt adapter가 소유한다. Controller는 node를
직접 제거하거나 widget callback을 직접 교체하지 않는다.

## 4. 고정 계약

| 경계 | 입력 | 출력/효과 | 보존 조건 |
| --- | --- | --- | --- |
| Store → Controller | `PromptDocumentV6`, serialized v6, references | immutable document와 source/compiled projection; restore는 `document`와 `changed`를 반환 | v5/invalid restore는 기존 문서를 바꾸지 않고 issue만 표시 |
| React → Controller | typed action, body edit `{target, epoch, baseRevision, parts}` | command 결과 또는 snapshot invalidation | React가 document/history를 별도 보유하지 않음 |
| Controller → React | `PromptViewSnapshot`, `PromptSectionsSnapshot`, `PromptDefinitionsSnapshot`, `PromptPickerSnapshot` | subscribe callback | 두 instance의 session scope와 body identity가 섞이지 않음 |
| ComfyUI widget → Controller | `getValue`, `setValue`, `serializeValue`, `beforeQueued` | 동일 serialized Prompt state | widget serialization index와 v6 JSON 형식 유지 |
| node removal → lifecycle | node instance | root/listener/controller teardown | cleanup 순서와 반복 destroy가 안전함 |

## 5. destroy 순서

`ComfyUILifecycleBridge.disposeNode()` 안에서 Prompt cleanup이 실행되는 순서는
다음과 같다. Loader/H3 cleanup의 전역 순서는 widget 등록 순서에 따라 별도로
유지되며, Prompt의 순서를 이 목록으로 재배치하지 않는다.

1. node-scoped cleanup을 release한다.
2. Prompt subscription과 preset binding을 해제한다.
3. Prompt React root와 Definitions React root를 destroy한다. 각 mount의
   `destroy()`는 `root.unmount()` 후 container를 비운다.
4. 그 다음 `ReferencePromptController.destroy()`를 호출한다. Controller는
   listener, body handle, picker, drag state, Store를 정리한다.
5. bridge의 나머지 node-scoped cleanup은 각 resource owner의 등록 순서와
   fallback 정리 규칙에 따라 실행된다.

각 단계는 bridge의 cleanup set, mount의 idempotent destroy, controller의
`#destroyed` guard에 의해 두 번 실행되어도 외부 상태를 다시 변경하지 않는다.

## 6. 자동 검증 매핑

- `frontend/test/reference-prompt-controller-contract.test.ts`
  - Prompt resources가 Controller보다 먼저 destroy되는지와 반복 teardown
  - widget value/serialization/restore/queue callback이 Adapter와 한 Controller로
    수렴하는지
- `frontend/test/reference-prompt-editor-engine.test.ts`
  - editor handle flush와 React undo/picker event ownership
- `frontend/test/reference-prompt-store.test.ts`
  - Store의 immutable document, notification, source/compiled/serialized
    projection, v6 restore rejection/changed result, definition command
- `frontend/test/reference-prompt-react.test.ts`
  - React root 단일성, Raw/Structured, editor identity, picker, local undo와
    external restore 후 history 경계
- `frontend/test/reference-prompt-v6.test.ts`
  - v6 AST, stable ID, body edit, restore, reorder
- `frontend/test/reference-loader-extension.test.ts`
  - 두 node instance 격리, ComfyUI widget 복원과 node removal

## 7. 아직 live에서 확인하지 않은 것

자동 fixture는 C0 contract를 확인하지만 실제 ComfyUI Nodes 2.0/Legacy Canvas에서
focus/IME, workflow restore, queue, widget rebuild, node removal 전체 matrix를
대신하지 않는다. 해당 live gate는 C4 완료 조건으로 남긴다.

## 8. history 경계

PromptStore는 canonical document를 교체할 뿐 별도의 undo stack을 만들지 않는다.
`restore()`는 유효성 결과와 함께 `changed`를 반환하고, invalid 입력은 기존
document와 projection을 유지한다. Controller는 widget/workflow restore를
editor session 경계로 처리해 body epoch을 올린다.

같은 body의 타이핑 undo/redo는 Lexical `HistoryPlugin`이 소유한다. epoch이
바뀌는 외부 restore/graph rebuild가 React snapshot으로 반영되면 editor는 먼저
Lexical history를 비우고 새 document를 쓴다. 따라서 restore 이전의 local undo가
복원된 문서를 다시 덮지 않으며, Ctrl/Cmd+Z는 ComfyUI graph shortcut으로
전파되지 않는다. ComfyUI graph history 자체는 Controller 밖의 graph/workflow
경계로 남긴다.
