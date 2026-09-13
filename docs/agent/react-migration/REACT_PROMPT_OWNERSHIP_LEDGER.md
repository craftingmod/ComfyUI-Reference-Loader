# Reference Loader Prompt React ownership ledger

작성 기준: 2026-09-08

이 문서는 [REACT_PROMPT_REMAINING_MIGRATION_PLAN.md](./REACT_PROMPT_REMAINING_MIGRATION_PLAN.md)의 R0 기준과 P10 이후 현재 코드를 고정한다. Production Prompt controller에는 legacy shell 선택지나 wheel interception 경로가 없고, React shell과 picker portal만 남아 있다. 이 문서의 자동 검증 완료는 별도의 live ComfyUI 재실행을 의미하지 않는다.

## 1. Production surface ownership

| Surface                                  | Render/lifecycle owner                                              | Edit/action owner                                                                           | Cleanup boundary                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Prompt root, toolbar, status, hint       | `createPromptReact()`의 React root, `ReferencePromptReactRoot`      | React button handlers가 Controller public action을 한 번 호출                               | `PromptReactMount.destroy()` 후 `ReferencePromptController.destroy()` |
| Structured section stack/card/header     | `PromptWorkspaceHost`와 `PromptSectionCard`                         | React section actions → `removeSection()` / `moveSection()` / drag wrappers                 | React key는 section title; root unmount가 card를 제거                 |
| Structured section body                  | 공통 uncontrolled `PromptEditor`                                    | React input/composition/key/paste/blur → `handleReactEditorInput()` 등                      | React effect는 content fingerprint가 바뀔 때만 DOM 내용을 다시 그림   |
| Section entry                            | `PromptSectionEntry`                                                | React input/keydown → alias query와 `handleReactSectionEntryKeydown()`                      | Prompt React root                                                     |
| Raw editor                               | `PromptEditor` (`target.type === "raw"`)                            | React editor action → `renderReactRawEditor()` / Controller raw parser                      | React root unmount                                                    |
| Subjects & Shots widget/card/body        | 별도 `createPromptDefinitionsReact()` root와 `PromptDefinitionCard` | React field/button/editor action → Controller definition commands                           | definitions React mount의 `destroy()`와 widget `onRemove`             |
| `@`/`#`/`/` picker DOM                   | React `PromptPicker`; active anchor에 portal 배치                   | Controller가 query, Range, active index, insertion command를 소유하고 React가 option을 표시 | picker ref의 mount/unmount + React root unmount                       |
| Canonical document/history/serialization | `ReferencePromptController`                                         | Controller command, graph transaction, parse/compile/restore                                | `ReferencePromptController.destroy()`                                 |

P10에서 `mountSectionHosts()`, `mountRawEditorHost()`, `mountDefinitionHosts()`와
legacy editor DOM construction path를 제거했다. React가 전달한 workspace/
definitions root는 snapshot 구독과 host 수명 확인에 사용되고, Controller는
canonical state와 editor command 경계를 유지한다.

## 2. Event ownership matrix

| Event/action                           | Production owner                              | Retained native island                                                                         |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Editor input/composition               | `PromptEditor` React handler                  | 없음                                                                                           |
| Atomic Backspace/Delete                | React key handler가 Controller command를 호출 | `#removeAtomicAtCaret()`는 Controller 내부 command이며 React subtree 중복 dispatch를 하지 않음 |
| Paste/blur                             | React handler → Controller boundary           | 없음                                                                                           |
| Toolbar, section, definition buttons   | React `onClick`/action adapter                | 없음                                                                                           |
| Picker option click/keyboard           | React option/action adapter → Controller      | 없음                                                                                           |
| Section entry                          | React input/keydown handler                   | 없음                                                                                           |
| Section drag/drop 및 Alt+Arrow reorder | React section handlers → Controller wrappers  | 없음                                                                                           |

따라서 production Prompt의 사용자 action은 React adapter를 통해 Controller command를 한 번만 호출한다. Picker 목록 스크롤은 브라우저 기본 `overflow: auto` 동작을 사용한다.

## 3. Lifecycle and cleanup

1. `createPromptReact()`가 Prompt widget instance마다 React root 하나를 생성한다.
2. `ReferencePromptReactRoot`의 layout effect가 Controller에 React workspace를 등록하고, cleanup에서 `unmountPromptWorkspace()`를 호출한다. 이 production 호출은 편집 delegated handler나 native wheel listener를 설치하지 않는다.
3. `PromptPicker` callback ref가 실제 picker element를 Controller에 등록한다. picker는 active editor/definition의 slot으로 portal되며, slot이 바뀌어도 React element identity를 재사용한다.
4. 별도 definitions widget은 `createPromptDefinitionsReact()`가 독립 root로 소유한다. widget removal은 React mount를 destroy하고 Controller definitions mount를 해제한다.
5. Prompt widget removal은 React mount, prompt subscriptions, preset binding, definitions mount, Controller를 idempotent하게 정리한다.

## 4. P10 result and remaining live gate

- P10에서 `legacyShell` option과 `#mount()`, legacy `#renderEditor()`/`#renderPicker()`/
  `#renderDefinitionBodies()`, delegated editor/click/drag event branch, stale
  section/raw/definition host adapter를 삭제했다.
- production caller는 `frontend/src/reference-loader/extension.ts`에서 기본
  `ReferencePromptController`와 React mounts를 연결한다.
- `mountPromptWorkspace()`라는 public lifecycle method는 React workspace 수명만 등록하며,
  editor DOM이나 native wheel listener를 만들지 않는다.
- R0–R6의 자동 fixture는 `frontend/test/reference-prompt-react.test.ts`에 있으며, structured 모든 body, Raw 전환, chip deletion, IME, picker, section interaction, definition body, instance isolation 및 cleanup을 확인한다.
- 사용자가 Nodes 2.0/Legacy Canvas의 live cleanup 및 parity 검증이 통과했다고
  확인했다. 이번 wheel interception 제거는 해당 live 경계를 더 단순화한다.
