# Prompt UUID + React 모델 기반 편집기 구현 명세

작성 기준: 2026-09-09. **구현 지시서이며, 구현 완료 보고서가 아니다.**

이 문서의 목적은 구현 담당자가 아키텍처를 추측하지 않고 순서대로 작업하도록 하는 것이다. 이번 문서 작성 작업은 런타임 코드를 변경하지 않는다.

## 1. 구현 담당자에게 전달할 작업 지시

Reference Loader의 Prompt 본문을 UUID 참조를 가진 문서 모델로 바꾸고, React에 연결된 모델 기반 rich-text 편집기로 전환하라. Section 본문과 Subject/Shot 본문에 일반 텍스트, `#태그` chip, `@이미지` chip이 같은 줄의 임의 위치에 함께 존재해야 한다. Video/Audio mention도 보존하라.

DOM에서 본문을 다시 읽어 저장하는 현재 방식을 제거하라. 저장 형식은 편집 라이브러리의 JSON이 아니라 프로젝트의 Prompt v6 AST다. Controller가 저장 문서의 유일한 소유자이고 React는 snapshot을 구독한다. 편집 엔진은 입력·selection·IME·본문 DOM을 담당한다.

각 단계의 완료 조건을 검증한 뒤 다음 단계로 진행하라. 테스트를 건너뛰고 마지막에 한꺼번에 확인하지 마라. 실제 브라우저에서 검증하지 않은 IME, caret, Undo를 완료라고 보고하지 마라. 기존 미커밋 변경과 계획 문서를 덮어쓰지 마라.

## 2. 먼저 이해해야 하는 제약과 설계 결정

### 2.1 Textarea라는 말의 의미

HTML `<textarea>`는 문자열 입력만 지원하므로 자식 React chip을 본문 중간에 렌더링할 수 없다. 이 문서에서 Structured Prompt 편집기는 textarea처럼 보이는 **rich-text textbox**다. 텍스트 위에 chip을 겹치는 overlay 방식, chip 사이마다 textarea를 만드는 방식은 사용하지 않는다.

`<div contentEditable>{parts.map(...)}</div>`를 만들고 매 input마다 React children을 다시 렌더링하는 것도 사용하지 않는다. selection, 조합 입력, 브라우저 DOM 변경과 React reconciliation의 충돌을 직접 해결해야 하기 때문이다.

### 2.2 Controlled의 정확한 계약

목표는 다음 네 가지다.

1. 저장값이 DOM에 숨어 있지 않고 명시적인 문서 모델에 존재한다.
2. React가 문서를 구독하고 모든 사용자 의미 변경을 typed command로 전달한다.
3. 외부 Restore/Undo/Clear가 편집기에 반영된다.
4. 편집 직후 Serialize/Queue가 최신 문서를 얻는다.

이 명세의 구현 경로는 **Lexical + React + 프로젝트 전용 document adapter**로 고정한다. React 19와의 호환 버전을 확인하고 사용하는 Lexical 패키지는 같은 버전으로 lockfile에 고정하라. 현재 설치된 의존성은 React/React DOM이며 Lexical은 새 의존성이다. IME와 selection 엔진을 직접 만드는 비용을 피하기 위한 도입이다.

**Lexical 자체는 React의 `value/onChange` 완전 제어 입력이 아니다.** 엔진이 편집 중 EditorState를 소유한다. 따라서 이것을 순수 React controlled contenteditable이라고 보고하면 안 된다. 외부 AST와 엔진의 입력 제안을 연결하는 어댑터까지 구현했을 때 이 문서의 “모델 기반 제어” 조건을 만족한다. `initialConfig.editorState`만 주는 구현은 불합격이다. 사용자가 엔진 내부 상태조차 허용하지 않는 엄격한 props-only controlled를 별도로 요구하면 이 경로는 그 요구를 만족하지 않으므로 설계를 다시 검토해야 한다.

Lexical은 DOM 대신 EditorState를 기준으로 동작하며 초기 설정 이후의 문서 교체에는 별도 API가 필요하다. [공식 Editor State 문서](https://lexical.dev/docs/concepts/editor-state)

### 2.3 기존 계획과 우선순위

- [UUID AST 개략 계획](./PROMPT_UUID_AST_PLAN.md): v6 방향의 기반이다. 이 문서가 아래의 구체적인 구현 선택을 보충한다.
- [Raw Export/Import 계획](./PROMPT_RAW_EXPORT_IMPORT_PLAN.md): Raw는 Export/Import 세션으로 구현한다. 두 번째 live AST를 만들지 않는다.
- [Controller 분해 계획](./REACT_PROMPT_CONTROLLER_DECOMPOSITION_PLAN.md): 전체 Controller 분해는 이번 작업의 전제조건이 아니다.
- 기존 P6/P8 문서의 “native/uncontrolled 본문 유지”는 이전 단계의 범위였다. 이번 대상 본문에는 적용하지 않는다.
- 실제 저장 schema, 컴파일 의미, 테스트가 기존 계획의 예시와 다르면 현재 동작을 먼저 fixture로 고정하고 아래의 명시적 변경만 적용한다.

## 3. 현재 코드에서 확인한 출발점

경로는 repository root 기준이다. 구현 시작 시 다시 확인하라.

| 파일/함수                                                 | 현재 역할                                                   | 변경 목표                                 |
| --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `frontend/src/reference-loader/prompt-state.ts`           | v5 타입, validation, source, compile, migration             | v6 AST와 순수 변환 함수                   |
| `components/prompt-react.tsx`의 `PromptEditor`            | 빈 contenteditable을 mount하고 `renderContent(editor)` 호출 | 새 rich editor를 사용하는 React wrapper   |
| 같은 컴포넌트의 `contentKey`, fingerprint                 | DOM 재작성 여부를 비교                                      | 문서 revision/동일 변경 확인으로 대체     |
| `components/prompt-editor.ts`의 `handleReactEditorInput`  | HTMLElement를 받고 DOM에서 재수집                           | parts와 revision을 받는 command           |
| `#syncDocumentFromEditor`, `#syncDefinitionsFromEditor`   | 전체 본문 DOM을 document로 복구                             | 전환 완료 시 제거                         |
| `serialize`, `compiledPrompt`                             | 읽기 전에 DOM sync                                          | 모델 flush 경계 뒤 AST 읽기               |
| `components/prompt-dom.ts`                                | chip DOM 생성, 태그 highlight, Range, 본문 파싱             | 순수 색상/표시 helper만 필요한 만큼 유지  |
| `components/prompt-definitions-react.tsx`                 | Subject/Shot UI                                             | UUID key와 같은 rich editor 사용          |
| `view-model.ts`                                           | Loader에서 PromptReference 생성                             | 기존 media reference identity 보존        |
| `extension.ts`                                            | widget lifecycle, Snapshot, Shot/Timeline 연결              | v6 restore와 flush 연결; widget 슬롯 보존 |
| `backend/core/prompt_contract.py`                         | Python v5 parser/compiler                                   | v6 parser/compiler + 구버전 지원          |
| `backend/nodes/reference_loader_export_prompt_for_llm.py` | 문서를 읽어 YAML 출력                                       | v6 입력에서 동일한 출력 의미 검증         |

위 `components/`, `view-model.ts`, `extension.ts`는 `frontend/src/reference-loader/` 아래다.

현재 v5의 media mention은 이미 `referenceId`를 저장한다. Subject/Shot은 `#tag`가 text에 들어 있으며 영속 UUID가 없다. Definition snapshot의 `identity`는 저장 v6 ID라고 가정하면 안 된다. 현재 Section은 title로 지정한다. React로 wrapper만 바꾸는 것은 이번 요구의 완료가 아니다.

## 4. 범위

### 포함

- Section, Subject, Shot의 본문과 두 종류의 inline reference.
- Section/Definition의 영속 ID, rename/reorder/restore.
- `@`/`#` picker, chip 삽입·선택·삭제·복사·붙여넣기.
- IME, Undo/Redo, serialization, Python 호환.
- Raw Export/Import를 통한 문자열 입출력 경계.
- Add section은 일반 controlled input 또는 textarea로 변경. alias picker 기능 유지.

### 별도 작업으로 남길 것

- Media board 전체 전환, H3 Guide 데이터 구조 변경, Timeline UI 재작성.
- 범용 에디터 framework, Markdown/WYSIWYG toolbar, collaborative editing.
- 단어마다 UUID를 부여하는 AST, 전역 Redux/Zustand 도입.
- 자동 배포·커밋·릴리스. 요청받지 않은 로컬 설정 변경.

## 5. 저장 schema: Prompt v6

아래는 **프로젝트 저장 계약**이다. Lexical NodeKey와 JSON을 이 타입에 섞지 마라.

```ts
type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "mention"
      referenceId: string
      mediaKind: "image" | "video" | "audio"
      label: string // unresolved 시 표시할 마지막 alias; identity가 아님
    }
  | { type: "definition-ref"; definitionId: string }

interface PromptSectionV6 {
  id: string
  title: string
  parts: PromptPart[]
}
interface PromptSubjectV6 {
  id: string
  tag: string
  parts: PromptPart[]
}
interface PromptShotV6 {
  id: string
  tag: string
  frameIndex: number
  parts: PromptPart[]
}
interface PromptDocumentV6 {
  version: 6
  view: "structured" | "raw"
  subjects: PromptSubjectV6[]
  shots: PromptShotV6[]
  sections: PromptSectionV6[]
}
```

`view`는 기존 workflow 호환을 위해 유지해도 된다. Raw draft text와 세션 revision은 저장 document에 넣지 않는다.

### 5.1 세 종류의 identity를 혼동하지 말 것

| identity              | 예                              | 수명/의미                                       |
| --------------------- | ------------------------------- | ----------------------------------------------- |
| 대상 UUID             | Subject의 `id`                  | rename/reorder/Save/Restore 동안 유지           |
| media reference ID    | 기존 item ID 또는 `${id}:audio` | 기존 Loader 채널 식별 계약 유지                 |
| 편집기 occurrence key | Lexical NodeKey                 | 같은 대상 chip 두 개도 서로 다른 key; 저장 금지 |

Section과 Definition 생성 시 `crypto.randomUUID()`를 한 번 호출한다. render, getter, compiler, 일반 validation에서 UUID를 생성하지 않는다. 기존 Media ID를 UUID 형식으로 강제 변환하지 않는다. 특히 Video 파생 Audio의 `:audio` suffix를 제거하면 Video와 Audio를 구별할 수 없다.

같은 Subject를 두 번 삽입하면 두 part의 `definitionId`는 같다. 두 편집 노드의 key는 다르다. `key={definitionId}`로 occurrence를 렌더링하지 마라. Section/Definition 카드의 React key는 각각 영속 `id`다.

Text run에는 UUID를 추가하지 않는다. chip마다 영속 occurrence UUID도 추가하지 않는다. 편집 엔진의 노드 key면 충분하며, snapshot restore 때 엔진 key를 새로 만드는 것은 정상이다.

### 5.2 normalization/validation

1. 인접 text는 합친다. 빈 text는 제거한다. 공백과 줄바꿈은 임의 trim하지 않는다.
2. 빈 본문은 `parts: []`다. 엔진 내부의 빈 paragraph는 저장 시 제거한다.
3. `definition-ref`는 subjects/shots 전체에서 정확히 하나의 ID를 찾아야 한다.
4. tags는 기존 `normalizePromptTag` 규칙과 Subject/Shot 전체 unique 조건을 유지한다.
5. Section title 규칙, text/state 길이 제한, Shot 정수 범위를 유지한다. TS/Python 경계가 같아야 한다.
6. v6 duplicate ID, 잘못된 ID, 존재하지 않는 definition target은 오류다. 임의 재발급 또는 silent discard하지 않는다.
7. import/restore 실패는 현재 document를 유지하고 경로가 있는 오류를 보여준다. 최초 workflow load 실패는 원문 recovery를 제공하고 자동으로 빈 값으로 덮어쓰지 않는다.
8. UUID unique는 Prompt document 범위다. 서로 다른 Loader 노드에 같은 Snapshot을 넣어도 노드 간 참조가 연결되면 안 된다.

## 6. UUID와 사용자 텍스트의 의미

### 6.1 입력에서 semantic reference로 승격

- Picker에서 선택하면 즉시 `definition-ref` 또는 `mention`을 삽입한다.
- 직접 입력한 등록 `#tag`는 공백/구두점/Enter로 token이 끝나거나 blur 시 정확히 일치하는 경우에만 승격한다. 조합 중에는 승격하지 않는다.
- `#hero`를 입력하는 도중 `#her`라는 대상이 있다고 중간에 chip으로 바꾸지 마라.
- 미등록 tag, escaped tag, 경계가 맞지 않는 문자열은 text다. rename 시 수정하지 않는다.
- plain text paste와 Raw Import도 같은 tokenizer를 사용한다. 엔진별 정규식을 따로 만들지 마라.
- media alias는 현재 reference map에서 정확히 해석되는 경우만 승격한다. `<Picture 1>` 같은 compiled token을 자동 참조로 바꾸지 않는다.
- 기존 `scanPromptTags`의 경계/escape 테스트를 재사용하고 Unicode 입력 테스트를 추가한다.

### 6.2 rename/reorder/delete

Rename은 ID로 대상을 찾아 `tag`만 바꾼다. 전체 본문 문자열 치환은 제거한다. 참조 chip의 표시 이름은 resolver가 최신 tag를 보여준다.

Reorder는 배열 순서만 바꾼다. ID, parts, focus를 유지한다. Subject ordinal과 Shot ordinal은 기존 컴파일 규칙으로 계산한다.

Definition 삭제는 다른 본문에서 참조 중이면 거부하고 참조 위치를 알려준다. 삭제되는 자신의 본문 안 참조는 막을 이유가 없다. 이 정책으로 unresolved definition node 타입을 추가하지 않는다. 사용자가 참조 chip들을 제거한 다음 대상을 삭제할 수 있어야 한다.

Media 삭제/비활성화는 기존 Loader 동작을 유지한다. mention의 ID와 fallback label을 보존하고 unavailable 상태를 표시한다. 이름/ordinal이 같은 다른 media로 조용히 재연결하지 않는다.

Media mention은 stable `referenceId`로만 추적한다. Media replace/reorder가 같은 이름이나 ordinal을 근거로 다른 media에 자동 rebind하지 않으며, 별도의 순서 기반 binding 옵션도 두지 않는다.

## 7. 상태 소유권

| 상태                             | 소유자                         | 저장 여부           |
| -------------------------------- | ------------------------------ | ------------------- |
| Prompt v6 AST                    | ReferencePromptController      | 저장                |
| Loader media/reference metadata  | 기존 Loader                    | 기존 방식           |
| cached immutable view snapshot   | Controller                     | 저장 안 함          |
| 입력 중 EditorState, selection   | 각 rich editor adapter/엔진    | 저장 안 함          |
| picker query/active option/range | 해당 편집 세션                 | 저장 안 함          |
| Raw Import 문자열                | React controlled session draft | Apply 전 저장 안 함 |
| IME 상태, 마지막 발행 revision   | adapter                        | 저장 안 함          |

엔진 EditorState는 문서의 독립적인 저장본이 아니라 **입력 제안과 selection을 담는 편집 표현**이다. 엔진의 accepted content를 Controller가 동기적으로 받는다. React `useState`에 PromptDocument 전체를 복제하지 않는다.

Snapshot 구독은 기존 `useSyncExternalStore`를 재사용한다. 변경이 없을 때 `getSnapshot()`은 같은 객체를 돌려준다. 본문 하나가 바뀌었다고 모든 editor를 remount하지 않는다.

## 8. React ↔ Controller ↔ 엔진 계약

다음 타입 이름은 새 파일 예시다. 동일 역할의 기존 타입을 수정해 사용해도 된다. DOM element를 입력 데이터로 받는 API는 남기지 않는다.

```ts
type EditorTarget = { type: "section"; id: string } | { type: "definition"; id: string }

interface BodySnapshot {
  target: EditorTarget
  parts: readonly PromptPart[]
  revision: number // 본문 변경 시 증가. 저장하지 않음
  epoch: number // 전체 Restore 등 편집 세션 무효화 시 증가
}

interface BodyEdit {
  target: EditorTarget
  baseRevision: number
  epoch: number
  parts: readonly PromptPart[]
  editId: string // 세션 내부 증가 sequence도 가능; UUID 불필요
  composing: boolean
}

type EditResult =
  | { ok: true; revision: number; editId: string }
  | { ok: false; reason: "stale" | "invalid" | "missing-target" }

interface PromptBodyEditorProps {
  value: BodySnapshot
  onChange(edit: BodyEdit): EditResult
  readOnly: boolean
  ariaLabel: string
}
```

### 8.1 보통 타이핑의 정확한 순서

1. 엔진이 입력을 처리한다. 기존 native delegated handler는 이 subtree를 처리하지 않는다.
2. 엔진 update listener에서 **EditorState**를 읽어 parts로 변환한다. DOM textContent를 읽지 않는다.
3. selection-only update는 document command를 호출하지 않는다.
4. adapter가 `onChange`를 호출한다. Controller는 target/revision/epoch/parts를 검증한다.
5. Controller가 새 immutable body를 저장하고 revision을 증가시킨 다음 snapshot을 publish한다.
6. 성공 ack의 editId/revision을 adapter가 기억한다.
7. 같은 변경이 props로 돌아오면 ack만 반영한다. 엔진 root를 다시 만들지 않는다.

자동 normalization으로 입력과 다른 parts를 반환해야 한다면 accepted snapshot을 다음 반영에 사용한다. 중간 글자를 잃는 제한 초과 입력은 inline 오류와 마지막 accepted content 복원으로 처리한다. 반복 render로 제한을 넘기는 입력을 무한 재전송하지 마라.

### 8.2 외부 변경

- Restore/Clear/Undo 등 외부 변경은 Controller command가 AST를 바꾸고 adapter가 엔진 API로 반영한다.
- Restore는 epoch를 올려 이전 session callback, picker query, pending edit를 무효화한다.
- metadata rename/reorder만 바뀌면 body revision은 그대로다. chip label만 resolver 기반으로 갱신하고 caret/history를 건드리지 않는다.
- foreign body revision은 외부 입력이다. 자신의 편집 echo와 구분해서 반영한다. stale edit를 새 문서에 덮어쓰지 않는다.
- `setEditorState`를 매 render마다 호출하지 않는다. `initialConfig` 변경이나 React key 변경을 외부 동기화의 대체 수단으로 사용하지 않는다.

### 8.3 최소 imperative handle

adapter는 lifecycle 연결에 필요한 `focus()`, `flushAcceptedModel()`, `cancelTransientSession()` 정도만 제공한다. `getHTML()`, `parseDOM()`, `renderContent(HTMLElement)`는 제공하지 않는다.

`flushAcceptedModel()`은 엔진의 pending update를 해당 버전의 지원 API로 마무리하고 최신 parts를 Controller에 제출하는 동기 경계다. 단순히 `getEditorState()`만 읽어서 아직 pending인 변경을 잃지 않도록 spike에서 확인한다. 엔진 update는 batch될 수 있다. [공식 update/동기 반영 설명](https://lexical.dev/docs/concepts/editor-state#synchronous-reconciliation-with-discrete-updates)

## 9. 편집 엔진 노드와 chip

엔진에는 paragraph/text/line-break와 inline reference node만 허용한다. lists, headings, bold, link, table 등의 저장 의미를 추가하지 않는다.

새 reference node는 inline atomic node로 구현한다. React chip을 렌더링해야 하므로 inline DecoratorNode 경로를 먼저 사용하고, 선택·키보드 삭제·clipboard를 spike로 확인한다. 단순히 span에 `contentEditable=false`만 지정하면 모든 atomic interaction이 해결된다고 가정하지 마라. 공식 Node 확장 API를 사용하라. [Lexical Nodes](https://lexical.dev/docs/concepts/nodes), [React 플러그인](https://lexical.dev/docs/react/plugins)

엔진 노드 payload에는 mention 또는 definition-ref 데이터만 둔다. tag/ordinal/thumbnail은 현재 resolver에서 얻는다. serialized Lexical payload는 clipboard 같은 편집 세션 용도로만 쓰며 workflow schema로 쓰지 않는다.

### 9.1 삽입 예

```text
입력: "왼쪽 인물이 천천히 걷는다"
caret: "왼쪽 인물|이 천천히 걷는다"
동작: #hero 선택
결과: text("왼쪽 인물") + definition-ref(heroId) + text("이 천천히 걷는다")
caret: chip 바로 뒤
```

1. picker를 열 때 엔진 selection/range와 epoch를 저장한다. DOM Range를 저장하지 않는다.
2. 선택 시 target/epoch와 대상 ID의 존재를 다시 검사한다.
3. query 구간만 엔진 selection으로 선택한다. 기존 선택 영역에서 명시적으로 삽입한 경우 그 영역을 대체한다.
4. 단일 엔진 transaction으로 reference node를 삽입하고 caret을 뒤로 옮긴다.
5. picker를 닫고 한 번의 의미 변경으로 발행한다.
6. 실제 공백을 임의 추가하지 않는다. 빈 trailing text anchor는 엔진 표현에만 허용한다.

중간·시작·끝, 연속 chip, 빈 본문에서도 같은 계약이다. 좌우 화살표와 Shift 선택, Home/End, multiline 이동은 엔진에 맡기되 테스트한다. Backspace/Delete는 chip 내부 문자를 지우지 않고 chip 전체를 제거해야 한다. 선택 범위가 여러 text/chip을 포함하면 그 범위를 한 번에 삭제한다.

### 9.2 picker

기존 React picker UI와 옵션 생성 로직을 가능한 한 재사용한다. 후보는 alias와 UUID를 모두 가지되 선택 command는 UUID를 전달한다. query 위치는 엔진 selection을 사용한다. 화면 좌표 계산에 DOM 측정을 쓰는 것은 허용하지만 DOM을 문서로 읽는 것은 금지한다.

한 번에 focus된 body의 picker 하나만 활성화한다. Escape는 닫기, 위/아래는 후보 이동, Enter/Tab 선택은 기존 정책을 확인해 유지한다. IME 처리 중에는 Enter를 가로채지 않는다. 후보 버튼 pointer down으로 selection이 사라지지 않게 하되 키보드 접근성도 유지한다.

## 10. IME와 저장 타이밍

React에서 composition마다 children을 교체하거나 key를 바꾸지 않는다. 조합은 엔진이 처리하고 adapter는 조합 문자열도 최신 모델 발행 경로에 포함한다. 조합 중 자동 tag 변환과 외부 body 교체는 하지 않는다.

- 조합 시작부터 종료까지 하나의 Undo 묶음이다.
- `compositionend`와 뒤따르는 input/update가 같은 결과를 두 번 저장하거나 history에 두 번 들어가지 않도록 parts 동등성과 transaction identity로 확인한다.
- Save/Queue/Copy compiled/Snapshot은 `flushAcceptedModel()`을 먼저 통과한다. blur만 기다리지 않는다.
- IME 조합 중 Save는 엔진이 현재 노출한 preedit 문자열까지 저장하고, 이후 조합이 자연스럽게 계속되게 한다. 앱이 아직 OS IME에서 전달받지 못한 후보 문자를 저장할 수 있다고 주장하지 않는다.
- Restore/Raw Apply/본문 삭제처럼 파괴적인 외부 교체는 조합 종료 전 실행하지 않는다. 종료 직후 기준 revision을 재검사한다. 조합 중 강제 unmount는 피한다.
- 즉시 flush를 해당 엔진 버전에서 보장할 수 없다면 이 단계는 미완료다. timeout으로 “충분히 기다렸을 것”이라고 처리하지 않는다.

## 11. Undo/Redo의 단일 책임

브라우저 native Undo, Lexical HistoryPlugin, Controller history가 같은 입력을 중복 기록하게 하지 마라.

이 명세에서는 **Prompt Controller의 문서 transaction history 한 개**를 사용한다. 엔진의 Undo/Redo command를 가로채 Controller undo/redo로 연결하고 별도의 engine HistoryPlugin은 mount하지 않는다. 기존 graph transaction 연결부를 재사용하되 ComfyUI graph shortcut과 같은 이벤트를 동시에 처리하지 않는다.

각 history entry는 before/after AST와 필요 시 active target의 selection bookmark를 가진다. bookmark는 target ID + 본문 기준 offset(anchor/focus, text는 UTF-16 단위, chip은 1 단위)로 표현하고 엔진 adapter가 변환한다. 라이브 DOM Range/NodeKey를 영속 기록하지 않는다. 일반 문자 삭제/이동을 이 offset 모델로 재구현하지 마라.

- 같은 body에서 연속 타이핑은 500ms 이내 같은 편집 종류면 합친다. paste/chip 삽입/rename/reorder/selection 이동/target 이동은 묶음을 끊는다.
- 조합 한 회는 타이머와 관계없이 한 묶음이다.
- chip 삽입, clear, import apply, rename, reorder는 각각 한 transaction이다.
- metadata refresh는 입력 history에 기록하지 않는다. 의도적인 by-order rebind는 문서 변경 transaction이다.
- explicit Snapshot Load는 기존 앱의 전체 Snapshot Undo 정책과 연결하고, 이전 편집 세션 history는 무효화한다. Prompt Undo가 snapshot 밖의 이전 문서로 튀면 안 된다.
- 편집기 focus에서 Ctrl/Cmd+Z와 redo는 한 경로만 소비한다. ComfyUI graph Undo로 같은 키가 전파되지 않게 한다.

Graph API 변경이 필요하면 구현 전에 현재 공식 ComfyUI 문서를 확인한다. 그래프의 beforeChange/afterChange가 있다는 사실만으로 텍스트 편집 history가 완성되었다고 간주하지 마라.

## 12. Clipboard 계약

내부 복사에는 `text/plain`과 `application/x-reference-loader-prompt-parts+json`을 함께 제공한다. payload는 version, session scope token, parts만 포함하고 media 파일/경로를 포함하지 않는다.

- text/plain은 사용자 alias인 `#tag`, `@image1`을 사용한다. UUID를 노출하지 않는다.
- 같은 Loader 편집 세션 paste는 payload를 validate하고 현재 대상이 존재할 때 UUID 참조를 보존한다.
- 다른 Loader/외부 앱/이전 session이면 plain text를 현재 alias map으로 해석한다. 다른 node의 UUID를 그대로 믿지 않는다.
- payload가 잘못되었거나 일부 ID가 사라졌으면 전체 plain text 경로로 fallback하고 짧은 안내를 표시한다. 조각 일부만 조용히 삭제하지 않는다.
- HTML은 실행하거나 innerHTML로 넣지 않고 plain text만 사용한다. 임의 markup은 저장하지 않는다.
- copy는 문서를 바꾸지 않는다. cut은 clipboard write가 가능한 이벤트 경로에서 복사와 삭제를 한 transaction으로 수행한다.
- drag/drop으로 다른 body에 text/chip을 이동하는 동작도 같은 검증을 거치거나 기본 drop을 막고 미지원 상태를 명시한다. 기존 section/definition header reorder는 유지한다.

## 13. Source와 Compiled

### Source

`definition-ref` → 현재 `#tag`, mention → 현재 `@alias` 또는 저장 fallback label. title header/blank line 규칙은 기존 Source 형식을 유지한다. Source는 UUID 보존 백업이 아니다. Snapshot JSON이 UUID 보존 백업이다.

현재 `renderAuthoringPrompt()`는 media를 active model tag로 표시하는 경로가 있다. UUID/Raw 계획의 alias Source로 바꾸는 것은 **의도적인 변경**이며 Copy source/Raw 테스트를 함께 수정한다. Copy compiled의 모델 토큰은 바꾸지 않는다.

### Compiled

AST를 직접 방문한다. Source를 다시 parse해서 compiled를 만들지 않는다.

- `definition-ref`는 기존 문법의 `<Subject N>` 또는 `[Shot N]`으로 resolve한다.
- Definition body는 기존 definition 출력 위치에서 한 번 출력한다. 참조 위치에 body를 재귀적으로 펼치지 않는다.
- Subject ordinal은 기존 배열 순서, Shot은 frame 오름차순과 기존 동률 순서를 유지한다.
- frame은 24fps와 기존 소수점 반올림 규칙을 유지한다.
- mention은 현재 active reference의 모델 tag로 resolve한다. unavailable은 기존 fallback 의미를 유지한다.
- v6 text의 `#tag`를 compiler가 다시 semantic reference로 승격하면 안 된다. 승격은 입력/import/migration 경계에서 끝낸다. escape의 출력 처리는 기존 계약을 유지한다.
- TS와 Python이 동일 fixture에 동일 source/compiled 의미를 출력해야 한다.

자기 참조/상호 참조는 token을 출력할 뿐 body 재귀 확장을 하지 않으므로 무한 재귀를 만들지 않는다. AST 계획의 “definition-ref → body 렌더링” 개략 예시를 재귀 인라인 확장 지시로 해석하지 마라.

## 14. v1–v5 호환과 v6 전환

1. 기존 legacy → v5 recovery 경로를 보존한다.
2. v5 → v6에서는 먼저 모든 Section/Subject/Shot에 ID를 부여한다.
3. complete tag → definition ID map을 만든 후 모든 본문 text를 같은 tokenizer로 한 번 변환한다.
4. 등록된 정확한 비escaped tag만 definition-ref로 바꾼다. unknown/escaped/prefix 충돌은 text로 유지한다.
5. 기존 mention의 referenceId/mediaKind/label은 보존한다. by-order를 migration 중 임의 실행하지 않는다.
6. 로드된 v6를 serialize/restore할 때 ID는 그대로 유지한다. validation/getter가 재발급하면 실패다.
7. 같은 구형 파일을 두 번 별도로 migration하면 새 UUID가 달라도 된다. 한 번 변환되어 저장된 문서를 다시 읽을 때 달라지면 안 된다.
8. Python은 v5를 계속 읽어 기존 문법대로 컴파일할 수 있다. 읽기 전용 compile을 위해 매 실행마다 무작위 UUID를 만들지 않는다. v6에는 저장 ID가 필수다.
9. Frontend가 v6를 저장하기 시작하는 변경과 Python v6 지원은 하나의 배포 단위다. frontend만 올려서 unknown part를 버리는 상태를 만들지 않는다.

## 15. Raw Export/Import

Export는 AST에서 만든 읽기 전용 문자열이다. Import는 `<textarea value={draft} onChange={...}>`인 실제 controlled React 입력이다. Structured AST에 타이핑마다 반영하지 않는다.

Import를 열 때 document epoch/revision과 media alias map fingerprint를 고정한다. Apply 때 변경이 있었으면 거부하고 다시 열도록 안내한다. Cancel은 canonical AST를 바꾸지 않는다.

Apply는 parse/validation 전체 성공 뒤 한 transaction으로 적용한다. 현재 definitions와 UUID를 유지하고 기존 Section title과 일치하는 항목의 ID는 재사용하며 새 Section만 ID를 발급한다. Source에는 정의 body/frame 전체가 없으므로 Raw Import가 definitions를 삭제/재생성하면 안 된다. 중복 section header 처리와 unknown text recovery는 기존 parser 계약을 테스트로 고정한다.

Raw에서 잠시 이동했다고 document 전체를 export → parse → replace하지 마라. 이 왕복은 UUID 보존 수단이 아니다.

## 16. 파일별 실행 순서와 완료 게이트

### P0. baseline 및 엔진 spike

- `git status --short`로 시작 상태 기록. 기존 변경 보존.
- `docs/TESTING.md`, 기존 Prompt tests와 현재 schema 읽기.
- 선택한 Lexical 버전/API, React 19 호환과 라이선스/번들 크기 확인. 실제 사용하는 패키지만 추가.
- 임시 또는 최종 컴포넌트 경로에서 하나의 본문, text, chip 두 종류, 한국어 IME, 중간 삽입, 외부 value 교체를 증명한다.
- NodeKey와 UUID 분리, own echo 무시, 동기 flush, Controller Undo를 spike에 포함한다.
- **게이트:** 위 조건이 실제 브라우저에서 동작하기 전 대규모 native 경로 삭제 금지. 실패하면 실패 조건을 보고하고 설계를 조정한다.

### P1. 순수 AST/컴파일 계약

- `prompt-state.ts` 타입·validator·migration·source·compiler 수정.
- `backend/core/prompt_contract.py`와 직접 소비자 수정.
- 필요할 때만 작은 `prompt-parts.ts`로 순수 helper 분리.
- v5 regression + v6 공통 JSON fixture를 추가한다.
- **게이트:** UI 없이 serialization, rename, reorder, migration, TS/Python compile 통과.

### P2. Controller 명령 경계

- body target을 title/tag 대신 ID로 바꾼다.
- `replaceBody`, rename, reorder, remove, restore, commit history 경계를 구현한다.
- body revision/epoch와 immutable snapshot을 제공한다.
- serialized 읽기 경계에 adapter flush를 등록/해제할 수 있게 한다.
- 기존 DOM 경로는 아직 전환하지 않은 surface에만 한정한다.
- **게이트:** Controller 테스트가 DOM 없이 body 수정과 serialize를 검증한다.

### P3. 공통 Rich Editor 구현

- 제안 경로: `components/prompt-rich-editor.tsx`와 필요한 경우 `components/prompt-reference-node.tsx`.
- AST ↔ 엔진 변환, onChange/외부 반영, chip, picker, clipboard, IME, history를 구현한다.
- Section 하나에 연결해 생명주기를 검증한다.
- **게이트:** 중간 삽입/즉시 Save/Undo/외부 Restore/동일 대상 중복 chip 테스트 통과.

### P4. 모든 대상 연결

- Section 본문 전체, Subject 본문, Shot 본문에 같은 rich editor 사용.
- `prompt-react.tsx`, `prompt-definitions-react.tsx`의 renderer callback과 DOM input 계약 제거.
- Add section controlled 입력 적용. Raw Export/Import 연결.
- `extension.ts`의 Shot Timeline adapter는 필요 시 기존 tag callback을 현재 ID로 변환하는 얇은 호환 경계로 둔다. Timeline 모델 자체를 확대 개편하지 않는다.
- Shot frame direct commit과 Timeline Apply/Cancel draft를 섞지 않는다.
- **게이트:** 모든 본문에서 chip/IME/Undo가 같은 방식으로 동작한다.

### P5. Native 상태 경로 제거

- 모든 caller를 검색한 뒤 `#syncDocumentFromEditor`, `#syncDefinitionsFromEditor`, DOM 파서·chip insertion·highlight·native Range 관리 중 사용이 끝난 코드를 삭제한다.
- 순수 색상/표시 함수와 실제 남은 비본문 DOM 기능은 유지한다.
- 본문 root에 native input/keydown/composition/paste handler가 남지 않도록 점검한다.
- node 제거/재등록/StrictMode cleanup에서 listener, root, adapter를 정확히 한 번 해제한다.
- **게이트:** 본문 모델을 DOM에서 읽는 제품 코드가 없고 editor subtree 이중 소유가 없다.

### P6. 통합 검증/문서

- 아래 테스트와 build 수행. `dist/`는 직접 수정하지 않는다.
- 실제 번들/스타일 변경이 있다면 기존 build/cache bust 방식 적용.
- `docs/TESTING.md`와 필요한 frontend 설명만 실제 구현에 맞게 갱신한다.
- 구현 결과에 완료 phase, 실행 명령/exit code, live 검증 여부, 남은 실패를 기록한다.

## 17. 필수 검증표

| 번호 | 입력/행동                                 | 기대 결과                                         |
| ---- | ----------------------------------------- | ------------------------------------------------- |
| T01  | `가나다` 중간에 image chip 삽입           | 좌우 텍스트 보존, caret chip 뒤                   |
| T02  | 같은 Subject chip 두 번                   | 같은 대상 ID, 독립 선택/삭제                      |
| T03  | chip만 있는 빈 body, 연속 chip            | 좌우 이동/앞뒤 입력/삭제 가능                     |
| T04  | text와 chip을 가로질러 선택 삭제          | 선택 범위만 삭제, Undo 한 번 복원                 |
| T05  | `#hero` rename                            | ref 표시 변경, unknown/escaped text 그대로        |
| T06  | Subject/Section reorder                   | UUID 동일, focused editor remount 없음            |
| T07  | Media reorder, enable 변경                | 기본 모드에서 referenceId 동일, ordinal 표시 갱신 |
| T08  | Video와 파생 Audio 삽입                   | Video ID와 `:audio` ID 구분                       |
| T09  | 한국어 `안녕하세요` chip 앞뒤 입력        | 자모 분리/중복/누락 없음                          |
| T10  | 일본어/중국어 조합과 picker Enter         | 조합 확정이 picker 선택으로 새지 않음             |
| T11  | 마지막 입력 직후 Save/Queue               | blur 없이 최신 문자열/UUID 포함                   |
| T12  | 조합 중 Save, 뒤이어 조합 확정            | 당시 preedit 저장, 다음 확정 정상, 중복 없음      |
| T13  | chip 삽입/삭제 Ctrl+Z/redo                | 한 경로에서 정확히 복원                           |
| T14  | 타이핑 → rename → Undo                    | rename만 취소, 이전 텍스트 보존                   |
| T16  | v6 Save/Restore 반복                      | UUID/parts 동일, callback stale 반영 없음         |
| T17  | v5 registered/unknown/escaped tags        | registered만 ref로 migration                      |
| T18  | duplicate UUID/없는 definition-ref import | 현재 문서 보존, 오류 표시                         |
| T19  | 같은 노드/다른 노드 paste                 | 내부 UUID 보존/외부 alias 재해석                  |
| T20  | HTML paste, 과대 payload                  | 실행 없음, validation, silent text loss 없음      |
| T21  | Raw Export → Cancel Import                | canonical/UUID 불변                               |
| T22  | Raw Import 중 media map 변경 → Apply      | stale 거부, 기존 문서 유지                        |
| T23  | 참조 중 definition 삭제                   | 거부 및 참조 위치 안내                            |
| T24  | Media 삭제 후 같은 ordinal 파일 추가      | 기본 모드에서 다른 ID로 재연결 없음               |
| T25  | 다른 Loader 두 개 동시 편집/하나 삭제     | state/picker/history 독립, leak 없음              |
| T26  | Shot frame 직접 변경 및 Timeline Cancel   | 기존 즉시 commit/draft 경계 유지                  |
| T27  | TS/Python v5/v6 compile fixtures          | Subject/Shot/Media 모델 출력 동등                 |
| T28  | emoji/결합문자/빈 줄/여러 줄              | 깨진 surrogate·줄 손실 없이 왕복                  |
| T29  | preset 변경/virtual section 입력          | 최초 편집에서 ID 한 번 생성, 이후 유지            |
| T30  | picker 열린 상태 Restore/target 삭제      | 이전 range/command 무효화                         |

기존 `frontend/test/reference-prompt*.test.ts`에 역할별 테스트를 배치하고, Python 테스트는 기존 prompt contract 테스트 위치를 찾아 확장한다. 단순히 `element.textContent = ...` 한 다음 synthetic input을 dispatch하는 기존 happy-dom 테스트만으로 새 엔진의 브라우저 입력을 증명하지 마라. 순수 AST/Controller 자동 테스트와 실제 Chromium/ComfyUI 입력 검증을 분리한다.

실행 순서:

```sh
bun run typecheck
bun run test:frontend
bun run test:backend
bun run build
git diff --check
```

`bun run test:unit`은 frontend/backend를 합친 명령이며 `bun run test`도 같은 경로다. 변경 없이 세 alias를 반복 실행할 필요는 없다. 최종 formatting/lint와 배포물 검증은 `docs/TESTING.md`의 해당 명령을 따른다. Python은 repo script 또는 `uv run`으로 실행한다. 실제 검증은 Nodes 2.0과 Legacy Canvas에서 최소 T01/T10/T12/T14/T16/T25를 수행하고 나머지 표도 증거를 남긴다. 실행 환경이 없으면 미검증으로 표시한다.

## 18. 리뷰에서 바로 반려할 구현

- React wrapper만 붙이고 `innerHTML`/`textContent`/DOM parser가 본문 저장값의 원천으로 남음.
- `onInput → innerHTML 저장 → effect에서 innerHTML 재주입`.
- UUID를 label/tag/배열 index로 대체하거나 render마다 새로 생성.
- 모든 body를 매 키 입력마다 serialize → parse → remount.
- Lexical JSON/NodeKey를 Prompt workflow에 저장.
- engine local history와 Controller history를 동시에 사용.
- native delegated handler와 React/engine handler가 같은 이벤트를 처리.
- v6 frontend만 구현하고 Python은 v5로 남음.
- label 변경만으로 다른 media를 자동 resolve하거나 UUID를 잃는 Raw round trip.
- `initialConfig`만 설정하고 외부 restore를 지원한다고 주장.
- IME/selection을 happy-dom 결과만으로 검증 완료라고 주장.

## 19. 최종 완료 체크리스트

- [ ] Section/Subject/Shot이 영속 ID로 조작된다.
- [ ] 본문 중간에 text와 두 종류 reference chip을 자유롭게 편집할 수 있다.
- [ ] `#tag` 참조의 canonical 저장은 definition UUID다.
- [ ] React snapshot과 engine adapter의 양방향 계약이 구현되었다.
- [ ] 본문 DOM을 저장 모델로 역파싱하는 경로가 제거되었다.
- [ ] IME·selection·Undo·clipboard·즉시 저장을 실제 입력으로 검증했다.
- [ ] 구형 workflow와 TS/Python v6 계약을 함께 검증했다.
- [ ] Media identity, by-order 옵션, H3 Timeline transaction을 보존했다.
- [ ] 모든 미검증/실패 항목을 명시했고 실제로 끝난 단계만 완료 표시했다.

## 20. 후속 구현 에이전트에 붙여넣을 짧은 프롬프트

> `docs/PROMPT_CONTROLLED_UUID_IMPLEMENTATION_SPEC.md`를 읽고 P0부터 순서대로 구현하라. 사용자 목표는 DOM uncontrolled 상태 관리를 없애고 UUID AST와 React 연동 편집기를 쓰는 것이다. Lexical은 props-only controlled가 아니므로 문서의 adapter 계약까지 구현해야 한다. 먼저 baseline과 engine spike를 검증하고, v6 frontend/backend를 함께 변경하라. 기존 미커밋 변경을 보존하라. 매 단계의 완료 조건과 검증 결과를 기록하고, native DOM wrapper만 React로 바꾸거나 IME 검증을 생략한 상태를 완료로 보고하지 마라. 구현 범위 밖의 Media/H3 UI를 재작성하지 마라.
