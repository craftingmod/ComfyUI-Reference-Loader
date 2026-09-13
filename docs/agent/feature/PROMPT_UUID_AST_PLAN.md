# UUID 기반 Prompt AST 구현 계획

작성 기준: 2026-09-09

상태: 개략 설계. 구현 전 검토용.

상위 문서:

- [Prompt React 전환 계획](./REACT_PROMPT_MIGRATION_PLAN.md)
- [Prompt Raw Export / Import 계획](./PROMPT_RAW_EXPORT_IMPORT_PLAN.md)
- [Prompt Controller 분해 계획](./REACT_PROMPT_CONTROLLER_DECOMPOSITION_PLAN.md)

## 1. 목적

현재 Prompt state는 이미 `PromptSection.parts`라는 JSON 배열을 사용하지만,
Subject/Shot 참조의 일부가 아직 `#tag` 문자열에 의존한다.

```text
현재 canonical reference:
  text part 안의 #subject_1

목표 canonical reference:
  definition-ref part의 definitionId
```

이번 설계의 목적은 Prompt를 문자 하나 단위의 거대한 AST로 만드는 것이
아니다. 긴 텍스트는 하나의 text part로 유지하고, 편집·컴파일에 의미가 있는
Media/Subject/Shot 참조만 별도 part로 표현한다.

UUID는 내부 identity다. 사용자가 입력하고 복사하는 Source에는 UUID를 노출하지
않으며, Source에서는 계속 `#tag`와 `@image1` 같은 사람이 읽는 alias를 사용한다.

## 2. 설계 결정

### 2.1 단일 canonical document

`ReferencePromptController`가 유일한 Prompt document와 history/transaction의
소유자로 남는다.

```text
PromptController
  └─ PromptDocument (canonical AST)
       ├─ renderAuthoringPrompt()
       ├─ compilePromptDocument()
       └─ getPromptViewSnapshot()
              ↓
          React components
```

React state에 PromptDocument를 복제하지 않는다. React는 view snapshot을
구독하고 명시적인 command를 Controller에 전달한다.

### 2.2 text run + semantic reference

텍스트를 단어 또는 문자 단위로 쪼개지 않는다.

```ts
type PromptPart =
  | { type: "text"; text: string }
  | { type: "mention"; referenceId: string; mediaKind: PromptMediaKind }
  | { type: "definition-ref"; definitionId: string }
```

인접한 `text` part는 normalize 시 하나로 합친다. 참조를 삽입할 때만 기존
text part를 다음과 같이 나눈다.

```text
"walks toward @image1"
    ↓
text("walks toward ") + media-ref(id) + text("")
```

빈 text part는 저장 시 제거한다.

### 2.3 사용자 alias와 내부 identity 분리

```ts
type PromptDefinition = {
  id: string
  kind: "subject" | "shot"
  tag: string
  parts: PromptPart[]
  frameIndex?: number       // shot only
}
```

- `id`: 안정적인 내부 identity. `crypto.randomUUID()`로 생성한다.
- `tag`: `subject_1` 같은 사용자가 보는 alias. 변경 가능하다.
- `parts`: Subject/Shot body 자체도 동일한 PromptPart 규칙을 사용한다.
- `frameIndex`: Shot의 시간 위치. Shot의 identity와 분리한다.

처음부터 Subject와 Shot을 하나의 배열로 강제할 필요는 없다. 현재
`subjects`와 `shots` 저장 구조를 유지하면서 각각 `id`를 추가하고, 공통
reference resolver가 두 배열을 조회하도록 시작할 수 있다.

## 3. 목표 타입 개략

현재 타입을 한 번에 전면 교체하지 않고, 다음과 같은 v6 형태를 목표로 한다.
실제 필드명은 구현 단계에서 기존 `PromptSubject`, `PromptShot`와의 호환 비용을
확인해 결정한다.

```ts
type PromptAstDocument = {
  version: 6
  view: PromptViewMode
  subjects: PromptSubjectNode[]
  shots: PromptShotNode[]
  sections: PromptSectionNode[]
}

type PromptSubjectNode = {
  id: string
  tag: string
  parts: PromptPart[]
}

type PromptShotNode = {
  id: string
  tag: string
  frameIndex: number
  parts: PromptPart[]
}

type PromptSectionNode = {
  id: string
  title: string
  parts: PromptPart[]
}
```

`section.id`는 section reorder와 React `key`에 사용한다. `title`은 현재
section의 source header 계약이므로 별도의 stable identity로 취급하지 않는다.

Media는 Prompt document 안에 전체 Media metadata를 복사하지 않는다.
`mention.referenceId` 또는 `mediaId`만 저장하고 실제 metadata/alias/ordinal은
현재 Loader reference snapshot에서 resolve한다.

## 4. Source와 Compiled의 책임

### 4.1 Authoring Source

AST를 사람이 읽고 편집할 수 있는 text로 투영한다.

```text
AST definition-ref(id = subject UUID)
  → #subject_1

AST media-ref(id = media UUID)
  → @image1
```

기존 `renderAuthoringPrompt()`의 section header와 blank-line 규칙은 유지한다.
Source 출력에는 UUID, 내부 배열 index, React 전용 정보가 포함되지 않는다.

### 4.2 Compiled Prompt

Compiled 출력은 Source를 다시 파싱하는 경로가 아니라 AST를 직접 resolve한다.

```text
definition-ref → definition.parts를 렌더링
media-ref      → active reference의 model tag를 렌더링
subject list   → <Subject N> 생성
shot list      → [Shot N] 및 frame timestamp 생성
```

Subject/Shot ordinal은 배열 순서 또는 기존 frame 정렬 규칙에서 매번 계산한다.
Ordinal을 AST에 저장하지 않는다.

## 5. 편집 명령 경계

React와 native editor는 문자열을 직접 수정하지 않고 Controller command를
호출한다.

```ts
renameDefinition(id: string, tag: string): void
updateDefinitionParts(id: string, parts: PromptPart[]): void
reorderDefinition(id: string, index: number): void
updateSectionParts(sectionId: string, parts: PromptPart[]): void
insertDefinitionRef(sectionId: string, index: number, id: string): void
insertMediaRef(sectionId: string, index: number, referenceId: string): void
removePart(sectionId: string, index: number): void
```

최종 public API는 현재 Controller facade에 맞춰 줄인다. 위 목록을 그대로
노출하는 것이 목적이 아니라, rename/reorder/insert가 tag 문자열 치환에서
identity 기반 mutation으로 이동한다는 경계를 고정하는 것이 목적이다.

### Rename

```text
기존: 모든 section/body 문자열에서 #old_tag를 찾아 치환
목표: definition.id를 찾아 definition.tag만 변경
```

그 후 Source projection이 새 tag를 출력한다. 다른 definition의 본문이나
escaped `\\#old_tag` 텍스트가 우연히 변경되지 않는다.

### Reorder

definition 배열 또는 section 배열을 재정렬한다. UUID와 parts는 변경하지
않는다. Source의 `#tag`도 변경하지 않고, Compiled 단계에서만 Subject/Shot
ordinal을 다시 계산한다.

### Delete

참조가 있는 definition을 삭제할 때는 다음 중 하나를 명시적으로 선택해야
한다.

- 삭제를 거부하고 참조 위치를 표시한다.
- 참조를 `unresolved-ref`로 바꾸고 Apply를 막는다.

참조를 자동으로 일반 text로 바꾸어 조용히 의미를 잃게 만들지 않는다.

## 6. AST와 Raw Import의 관계

Raw는 canonical state가 아니다.

```text
AST → Source Export
Source Import → draft text → parse → validation → Apply transaction
```

Import parser는 alias map을 사용해 다음을 resolve한다.

- `#subject_1` → definition identity
- `@image1` → media reference identity
- section header → section identity 또는 새 section draft

UUID를 포함한 full-fidelity 복원은 Raw가 아니라 Snapshot이 담당한다. Raw에
존재하지 않는 Subject body metadata, Shot frame, Media metadata를 Raw parser가
추측하지 않는다.

Import 중에는 canonical document를 수정하지 않는다. Apply 시 다음을 모두
통과해야 단일 transaction으로 교체한다.

- syntax parse
- alias 중복/미해결 참조 검증
- base Prompt fingerprint 확인
- Media/reference fingerprint 확인
- document validation

Raw 세션의 상세 계약은
[PROMPT_RAW_EXPORT_IMPORT_PLAN.md](./PROMPT_RAW_EXPORT_IMPORT_PLAN.md)를 따른다.

## 7. 기존 v5에서의 마이그레이션

현재 v5는 다음과 같은 혼합 상태다.

- Media mention은 `referenceId` 기반 part로 이미 저장된다.
- Subject/Shot definition은 `tag` 중심이다.
- section text 안의 `#tag`가 Subject/Shot 연결을 표현한다.
- v4 legacy에는 별도의 `subject` part가 있었다.

v6 decoder는 다음 순서로 한 번만 변환한다.

1. 기존 Subject/Shot마다 UUID를 생성한다.
2. 각 section와 definition body의 안전한 `#tag` token을 scan한다.
3. 현재 tag map으로 해석되는 token을 `definition-ref`로 변환한다.
4. 해석되지 않는 token과 escaped tag는 일반 text로 보존하거나 unresolved
   상태로 보존한다. 조용히 삭제하지 않는다.
5. 인접 text part를 merge하고 빈 part를 제거한다.
6. section/definition에 stable id를 생성한다.
7. 전체 document를 validate한 뒤 v6으로 serialize한다.

ID 생성은 저장 시 매번 새로 하지 않는다. 마이그레이션 직후 Snapshot 또는
Prompt state에 기록해 이후 rename/reorder에서도 유지한다.

테스트에서는 `crypto.randomUUID()`를 직접 고정하지 말고 ID generator를
주입한다.

## 8. React 전환과의 결합 방식

AST migration과 React surface migration은 같은 변경 단위에 섞지 않는다.
순서는 다음과 같다.

```text
v5 adapter + AST types
  → AST render/compile parity
  → Controller commands
  → React view snapshot/action adapter
  → React editor surface가 AST command 사용
  → v5 문자열 mutation 제거
```

React가 처음부터 AST 전체를 소유하지 않는다. Controller가 canonical AST를
갖고 React에는 작은 snapshot을 전달한다.

```ts
type PromptViewSnapshot = {
  view: PromptViewMode
  source: string
  compiled: string
  sections: readonly PromptSectionView[]
  definitions: readonly PromptDefinitionView[]
}
```

`PromptSectionView`와 `PromptDefinitionView`는 렌더링에 필요한 값만 가진다.
React `key`는 변경 가능한 `tag`가 아니라 stable `id`를 사용한다.

## 9. 구현 단계

### A0 — 현재 계약 고정

- v5 serialize/deserialize 결과 고정
- Source/Compiled parity 테스트 고정
- rename/reorder/escaped tag/mention 테스트 고정
- Snapshot restore와 두 Prompt instance 독립성 고정

### A1 — 타입과 순수 helper

- `PromptDefinition`, `PromptPart`, stable ID 타입 추가
- part validation/normalization 추가
- `renderPartsFromAst()` 추가
- 기존 `renderAuthoringPrompt()`와 `compilePromptDocument()` 결과 비교

이 단계에서는 Controller와 React를 변경하지 않는다.

### A2 — v5 → v6 decoder

- legacy v5 입력을 v6 AST로 변환
- malformed/duplicate/unresolved 데이터의 복구 정책 구현
- serialize/deserialize round-trip 테스트 추가

기존 v5 입력은 읽을 수 있게 유지한다. 새 저장은 v6으로만 한다.

### A3 — Controller command

- rename/reorder/insert/remove를 UUID 기준으로 구현
- 각 command가 한 번의 history/graph transaction만 생성하는지 확인
- compile/source/serialization이 command 이후 일관되게 갱신되는지 확인

### A4 — React adapter

- `getViewSnapshot()`에 AST projection 추가
- React card/editor의 key를 tag에서 id로 변경
- React event가 Controller command만 호출하도록 정리
- React 내부에 Prompt document/history를 만들지 않음

### A5 — Raw Import 연결

- Source parser가 AST draft를 생성
- Apply/Cancel transaction 적용
- unresolved reference와 fingerprint conflict UI 추가

Raw Import은 AST migration과 분리된 후속 단계로 둘 수 있다.

### A6 — legacy cleanup

- `replacePromptTag()`의 canonical rename 사용처 제거
- subject/shot tag scan을 display/export/import 경로로 제한
- v5 write path 제거
- 사용하지 않는 `PromptSubjectPart` compatibility path 정리

## 10. 검증 항목

최소 단위 테스트:

- text run merge와 empty part 제거
- media/definition ref round-trip
- rename 후 UUID ref 유지
- reorder 후 UUID와 body 유지
- duplicate tag 거부
- escaped `\\#tag` 보존
- unresolved reference의 no-op 또는 오류 처리
- Source render parity
- Compiled render parity
- v5 → v6 migration
- v6 serialize/deserialize round-trip
- Snapshot restore 후 stable ID 보존
- Raw Import Apply 실패 시 canonical state 불변

저장소 검증 순서는 기존 규칙을 따른다.

```text
focused Prompt tests
  → bun run typecheck
  → bun run test:unit
  → bun run build
  → bun run lint
  → git diff --check
  → ComfyUI live Prompt/Snapshot/queue 확인
```

## 11. 범위에서 제외

- UUID를 사용자가 입력하는 Prompt 문법으로 노출
- 문자/단어별 AST node
- 별도 global state library
- Media metadata를 Prompt AST에 복제
- AST migration과 H3 Guide/Timeline 구조 변경을 한 번에 수행
- Raw를 Snapshot의 완전한 대체물로 사용
- unresolved reference를 자동으로 일반 텍스트로 삭제

## 12. 완료 조건

- 기존 v5 Prompt를 손실 없이 v6 AST로 읽을 수 있다.
- Subject/Shot rename이 문자열 전체 치환 없이 UUID 기준으로 동작한다.
- reorder가 stable identity와 Prompt body를 보존한다.
- Source와 Compiled 출력이 기존 계약과 일치한다.
- React는 AST/history를 복제하지 않고 snapshot과 command만 사용한다.
- Snapshot restore가 stable ID를 보존한다.
- Raw Import 실패가 canonical state를 변경하지 않는다.
- 두 Reference Loader instance가 서로의 AST identity를 오염시키지 않는다.
