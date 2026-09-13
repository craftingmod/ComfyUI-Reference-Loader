# Reference Loader Prompt Controller 분해 계획

작성 기준: 2026-09-08
상태: C0~C4 코드 추출 완료, live 검증 대기

## 1. 목적

`ReferencePromptController`는 현재 다음 책임을 함께 가진다.

- canonical `PromptDocument`와 prompt history
- parsing, compilation, serialization, restore
- contenteditable의 caret/selection/IME와 tag editor engine
- `@`/`#` picker query 및 activation
- Subject/Shot draft와 definition command
- ComfyUI DOM widget lifecycle, graph transaction, dirty 상태
- React snapshot publication과 native host mount/cleanup

React migration의 목표는 이 클래스를 React state로 복사하는 것이 아니다.
React migration이 안정된 뒤, 위 책임을 독립적인 경계로 추출해 Controller를
얇은 조정 계층으로 줄이는 것이 이 문서의 목표다.

## 2. 선행 조건

이 작업은 남은 React surface migration 및 P10 legacy 경로 정리와 분리한다.

- React Prompt surface의 자동화 parity가 완료되어야 한다.
- Nodes 2.0과 Legacy Canvas에서 mount, restore, queue, destroy를 확인해야 한다.
- Prompt schema, compiled output, workflow serialization 계약이 고정되어야 한다.
- 현재 Controller의 모든 public caller와 React/native host caller를 먼저
  inventory해야 한다.
- 분해 중에도 `PromptDocument`를 소유하는 객체는 하나만 존재해야 한다.

## 3. 목표 경계

### 3.1 `PromptStore`

canonical 상태와 저장 의미를 소유한다.

- `PromptDocument`
- restore boundary와 immutable snapshot
- validation, serialization
- source/compiled projection
- Subject/Shot definition command
- 구독 가능한 immutable snapshot

Prompt 편집 history는 Store에 중복하지 않는다. 같은 body의 local undo/redo는
Lexical이, ComfyUI graph/workflow restore는 외부 graph 경계가 소유한다.
React는 이 store를 복제하지 않고 구독한다.

### 3.2 `PromptEditorEngine`

편집 surface의 imperative 동작을 소유한다.

- contenteditable DOM 읽기/쓰기
- caret/selection 복원
- IME composition
- tag scan/highlight와 atomic chip 경계
- paste와 multiline normalization
- picker anchor Range와 option activation

현재 engine은 body editor handle registry, flush, React editor event ownership,
undo 전파 차단, blur/paste 경계를 소유한다. Lexical document와 local history는
`PromptRichEditor`가 소유하고 Prompt document는 Store를 통해서만 변경한다.

### 3.3 `ComfyPromptAdapter`

ComfyUI와의 외부 통합을 소유한다.

- DOM widget의 `getValue`/`setValue`
- `serializeValue`/`beforeQueued`
- node dirty/graph transaction 연결
- node 제거, abort, root unmount cleanup
- widget별 Prompt/Definitions root lifecycle

ComfyUI가 React 밖에서 호출하는 API는 이 경계를 통해 안정적으로 유지한다.
구현은 `frontend/src/reference-loader/comfy-prompt-adapter.ts`에 있으며,
`extension.ts`는 Prompt widget을 직접 조립하지 않는다.

### 3.4 `PromptReactBridge`

React와 외부 store/engine/adapter 사이의 얇은 연결 계층이다.

- `useSyncExternalStore`용 snapshot/subscribe
- typed action adapter
- React root와 editor/native-island host 연결
- React-owned surface의 event ownership 차단

이 계층은 canonical state를 보유하지 않는다.
`PromptReactBridge`와 `PromptDefinitionsReactBridge`가 각각 React root, typed
action mapping, idempotent unmount를 소유한다.

## 4. 단계

### C0 — 호출 그래프와 계약 고정

- Controller public method와 private method를 state, editor, ComfyUI, React
  책임으로 분류한다.
- `extension.ts`, React mount, widget callback, native event handler의 호출
  그래프를 문서화한다.
- 각 경계의 입력/출력 타입과 destroy 순서를 테스트로 고정한다.

### C1 — 순수 state/compile 추출

- 기존 prompt-state/pure helper를 재사용해 `PromptStore`의 최소 API를 만든다.
- serialization, restore, source/compiled projection이 기존 결과와 일치하는지
  비교한다.
- Controller와 Store가 동시에 document를 갱신하지 않도록 한쪽을 canonical
  owner로 유지한다.
- 완료: `PromptStore`가 canonical document와 pure projection을 소유하고,
  restore 결과의 `changed`를 반환한다.

### C2 — ComfyUI adapter 추출

- widget callback과 node lifecycle을 `ComfyPromptAdapter`로 이동한다.
- `getValue`, `setValue`, `beforeQueued`, `serializeValue` parity를 유지한다.
- restore/queue/destroy 중 늦게 끝난 listener와 React update를 차단한다.
- 완료: `ComfyPromptAdapter`가 Prompt/Definitions widget callback, preset
  binding, reference subscription, rendered-root rebind, node cleanup을
  소유한다.

### C3 — editor engine 추출

- contenteditable, caret/selection, IME, tag/chip, picker의 imperative API를
  `PromptEditorEngine`으로 좁힌다.
- React component가 engine을 직접 생성하더라도 document/history는 Store를
  통해서만 변경한다.
- picker UI를 React로 옮긴 경우에도 anchor Range와 activation command의
  소유자를 중복시키지 않는다.
- 완료: `PromptEditorEngine`이 editor handle registry와 native event ownership을
  소유하며 picker activation은 Controller command로 위임한다.

### C4 — Controller facade 축소

- 기존 `ReferencePromptController`를 외부 호환 facade로 유지한다.
- facade는 Store, EditorEngine, ComfyPromptAdapter, ReactBridge를 조합하고,
  기존 public API를 당분간 forwarding한다.
- 모든 caller가 새 경계를 사용한 뒤에만 사용하지 않는 private DOM render와
  legacy compatibility branch를 삭제한다.
- 완료: 기존 `ReferencePromptController` 이름과 public API를 facade로 유지하고,
  Store/EditorEngine은 내부 canonical owner로, ComfyPromptAdapter/ReactBridge는
  외부 조합 경계로 연결했다. Prompt widget caller는 adapter를 사용한다.

## 5. 보존해야 할 계약

- React와 Controller/Store가 별도의 Prompt document/history를 만들지 않는다.
- ComfyUI widget serialization index와 saved workflow 형식을 바꾸지 않는다.
- source `#tag`와 compiled `<Subject N>`/`[Shot N]` 변환 규칙을 유지한다.
- graph transaction과 dirty notification의 호출 횟수를 유지한다.
- IME 입력, 마지막 문자, caret/selection, undo/restore를 보존한다.
- 두 Prompt widget instance의 상태와 picker가 서로 섞이지 않는다.
- H3 Guide/Timeline conditioning은 이 분해 작업의 범위에 넣지 않는다.

## 6. 완료 기준

- Controller public facade 외부 계약이 기존 테스트와 동일하게 동작한다.
- Store, EditorEngine, ComfyPromptAdapter 각각에 독립적인 contract test가 있다.
- `PromptReactBridge`와 `PromptDefinitionsReactBridge`의 root destroy가
  idempotent하다.
- React root unmount와 ComfyUI node destroy가 idempotent하다.
- workflow restore, queue, Snapshot, Raw/Structured, undo/redo parity가
  유지된다.
- `ReferencePromptController`에 남은 코드는 경계 조합과 compatibility facade로
  설명할 수 있다.
- live ComfyUI 검증에서 React root, widget serialization, focus/IME, node
  removal이 모두 정상이다.

## 7. 지금 하지 않는 것

이 계획은 현재 React migration 작업과 함께 실행하지 않는다.

- React 안에 새로운 global state library 도입
- Prompt schema/backend contract 변경
- Controller 이름을 먼저 바꾸는 cosmetic refactor
- live parity가 끝나기 전의 대규모 파일 이동
- H3 Guide/Timeline의 React 전환

현재 우선순위는 [남은 Prompt React migration 계획](./REACT_PROMPT_REMAINING_MIGRATION_PLAN.md)을
완료하고 P10 legacy 경계를 닫는 것이다. 이 문서는 그 이후의 구조 개선을 위한
별도 backlog이자 설계 기준으로 사용한다.

## 8. 진행 기록

- **C0 완료 (2026-09-14)**: 실제 Controller public/private method, extension과
  React mount 호출 그래프, widget callback 계약, node destroy 순서를
  [C0 inventory 문서](./REACT_PROMPT_CONTROLLER_C0_CALL_GRAPH.md)에 고정했다.
  lifecycle/widget 경계의 contract test도 추가했다.
- **C1 1차 진행 (2026-09-14)**: `PromptStore`가 v6 canonical document와
  validation, serialization, source/compiled projection, parse/definition pure
  command의 owner가 되었다. Controller의 기존 facade와 widget 계약은
  유지된다. Lexical editor-local history와 ComfyUI graph undo는 이 절편에서
  중복 Store history로 만들지 않았다.
- **C1 2차 진행 (2026-09-14)**: Store의 `restore()`가 유효한 document와
  canonical 교체 여부(`changed`)를 함께 반환하도록 했다. Controller의 중복
  restore replace 경로를 제거하고, 외부 restore가 body epoch을 새로 시작하는
  경계를 유지했다. React contract test는 restore 후 이전 Lexical local undo가
  복원된 문서를 다시 덮지 않는 것과 Ctrl/Cmd+Z가 graph handler로 전파되지
  않는 것을 고정한다.
- **C2 완료 (2026-09-14)**: `ComfyPromptAdapter`로 Prompt/Definitions widget
  callback과 reference/preset/lifecycle binding을 이동했다. rendered widget root
  재연결도 ComfyUI lifecycle bridge의 공용 경계로 이동했다.
- **C3 완료 (2026-09-14)**: `PromptEditorEngine`으로 body handle registry,
  flush, paste/blur와 undo/redo event ownership을 이동했다. Lexical local
  history와 picker command의 기존 소유자는 유지했다.
- **C4 완료 (2026-09-14)**: `PromptReactBridge`와
  `PromptDefinitionsReactBridge`가 React root/action mapping/unmount를
  명시적으로 소유하도록 바꾸고, 기존 Controller public API를 facade로
  유지했다.
- live ComfyUI Nodes 2.0/Legacy Canvas의 focus/IME, workflow restore, queue,
  widget rebuild, node removal matrix는 실행 환경 의존 gate로 남긴다.
