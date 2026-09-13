# Prompt Raw Export / Import 계획

작성 기준: 2026-09-09

상태: 설계 결정 기록. 구현은 다음 작업 세션에서 시작한다.

## 1. 결정

현재 Raw를 Structured Prompt와 실시간 양방향 동기화하는 두 번째 편집
모델로 유지하지 않는다. Raw는 다음 두 가지 일회성 세션으로 분리한다.

| 세션 | 동작 | canonical state 변경 |
| --- | --- | --- |
| Raw Export | 현재 Prompt를 사람이 읽는 텍스트로 한 번 렌더링하고 읽기 전용으로 표시 | 없음 |
| Raw Import | 텍스트를 draft로 편집하고 Apply 때 한 번 파싱 | Apply 성공 시 한 번 |

Import 중에는 Prompt/Subject/Shot의 Structured 편집을 비활성화하거나,
적용 시점에 기준 fingerprint가 바뀌었는지 검사한다. 실시간 rebase나
부분 동기화는 하지 않는다.

## 2. 책임 경계

```text
ReferencePromptController
  canonical PromptDocument, history, transaction, compiled output

Structured UI
  canonical state를 직접 편집하고 #tag / S1 / SH1로 표시

Raw Export
  canonical state의 source-text projection

Raw Import
  임시 draft text를 parse하고 Apply 시 canonical state로 교체

Snapshot
  Loader + Media + Prompt + Subject/Shot + node settings의 전체 백업
```

Raw text는 전체 Snapshot을 대체하지 않는다. `#tag`와 `@image1`은 Prompt
text 교환용으로 사용하고, UUID와 Media identity가 필요한 완전한 복원은
Snapshot이 담당한다.

## 3. Raw text 계약

Export와 Import는 같은 alias 규칙을 사용한다.

- Subject/Shot: `#tag`
- Media: 현재 reference alias인 `@image1`, `@video1`, `@audio1` 등
- section: 현재 source text의 `scene:` 같은 title header
- compiled 전용 `<Subject 1>`, `[Shot 1]`, `<Picture 1>`을 Raw 입력의
  canonical reference로 취급하지 않는다.

`@image1` 등의 이름을 사용자 설정으로 바꾸는 것은 후속 작업으로 둔다.
Import는 열어 둔 시점의 reference alias map을 기준으로 파싱하고, Media
identity가 그 사이 바뀌면 Apply를 거부한 뒤 다시 열도록 한다.

Raw text만으로 Subject/Shot body, Shot frame, UUID까지 백업할 수 있다고
가정하지 않는다. 그런 정보가 필요하면 Snapshot을 사용하거나, 나중에
별도의 full recovery text 포맷을 정의한다.

## 4. 세션 모델

Raw를 `PromptDocument.view === "raw"`인 live canonical 상태로만 표현하지
않고, Controller 또는 Prompt React host에 임시 세션을 둔다.

```ts
type RawSession = {
  mode: "export" | "import"
  draftText: string
  basePromptFingerprint: string
  baseReferenceFingerprint: string
  error?: string
}
```

### Export

1. 현재 canonical document와 reference snapshot을 읽는다.
2. `renderAuthoringPrompt()` 결과를 `draftText`로 만든다.
3. 읽기 전용 textarea/dialog에 표시한다.
4. Copy 또는 Download만 제공한다.

### Import

1. 현재 source text를 초기 draft로 채우거나 빈 import draft를 연다.
2. 입력 중에는 `draftText`만 변경한다.
3. canonical Prompt, history, Structured editor DOM은 변경하지 않는다.
4. Apply 때 Prompt/reference fingerprint를 다시 확인한다.
5. 기준이 같으면 `parseRawPrompt()`를 한 번 실행한다.
6. 파싱·검증이 성공한 경우에만 하나의 graph transaction으로 교체한다.
7. 실패하면 기존 state를 유지하고 Raw draft와 오류를 남긴다.
8. Cancel은 draft를 폐기한다.

Raw Import 실패는 부분 적용하지 않는다. 사용자가 고친 뒤 다시 Apply할
수 있어야 한다.

## 5. UUID와 이름 변경

UUID는 canonical Snapshot/Prompt state의 Subject/Shot identity로 추가할 수
있지만 Raw의 `#tag` 문자열에 노출하지 않는다.

- Structured rename: UUID로 definition을 찾고 tag 표시만 변경한다.
- Raw Import rename: 입력된 text를 현재 alias map으로 해석해 새 document를
  만든다. 기존 document를 실시간 수정하지 않는다.
- Apply 후 새 definition에는 UUID를 생성한다.
- reorder는 tag text를 바꾸지 않고 S/SH ordinal과 compiled ordinal만 다시
  계산한다.

UUID 기반 structured reference AST는 별도 범위다. Raw Export/Import 세션을
먼저 도입하기 위해 `PromptSectionPart` 전체를 즉시 재작성하지 않는다.

## 6. Snapshot 및 복구

Snapshot은 정상적인 lossless restore 경로다.

- `loader_state`: Media identity, source, caption, output/timeline 상태
- `prompt_state`: Prompt와 Subject/Shot state, 향후 UUID 포함
- `node_settings`: Loader/Prompt 관련 설정

기존 Schema를 읽지 못했을 때는 새 canonical parser가 원본을 빈 document로
덮어쓰지 않도록 한다. 알려진 구버전 decoder와 Raw recovery 경로를
유지한다. 복구 Apply는 기존 UUID를 보존하는 migration이 아니라 현재
schema에 새 state와 새 UUID를 생성하는 일회성 변환이다.

향후 Snapshot에 `prompt_recovery` source를 추가할 수 있다. 이 값은 정상
복원에 사용하지 않고, Prompt schema를 읽지 못할 때 Raw를 열기 위한
구조화된 안전망으로만 사용한다. 정의 body와 Shot frame까지 복구해야
한다면 recovery source가 해당 정보를 포함해야 한다.

## 7. 구현 순서

1. `RawSession`과 Export/Import/Apply/Cancel action 경계를 추가한다.
2. 기존 Raw contenteditable의 live `#syncDocumentFromEditor()` 경로를
   Import draft 경로로 분리한다.
3. Raw 화면을 일반 Prompt editor surface가 아닌 단순 textarea/dialog로
   만든다.
4. Apply 시 alias map과 Prompt/reference fingerprint를 검사한다.
5. 성공 시 단일 transaction, 실패 시 no-op을 테스트한다.
6. `@image1` alias 설정은 별도 설계 후 추가한다.
7. UUID field와 Snapshot 보존을 추가한다.
8. 마지막으로 필요할 때만 structured definition reference AST를 검토한다.

## 8. 수용 기준

- Export를 열고 Structured Prompt를 바꾸어도 Export text는 자동 변경되지
  않는다.
- Import 입력 중 Structured Prompt/Subject/Shot state는 바뀌지 않는다.
- Apply 성공 전에는 history, compiled prompt, Snapshot state가 바뀌지 않는다.
- Apply 성공 시 하나의 undo/graph transaction만 생성된다.
- 잘못된 `#tag`, `@image1`, section header는 오류 또는 unresolved 상태로
  보고하고 부분 적용하지 않는다.
- Import 중 Media reference가 변경되면 Apply가 거부된다.
- Cancel은 Prompt, Subject, Shot, Media reference를 원래대로 둔다.
- 알려진 legacy Prompt는 기존처럼 Raw recovery로 열 수 있다.
- 정상 Snapshot Load는 Raw 세션 여부와 무관하게 canonical state를 복원한다.

## 9. 하지 않을 것

- Raw와 Structured를 매 입력마다 서로 다시 렌더링하지 않는다.
- UUID를 사용자가 입력하는 `#tag` 문법에 노출하지 않는다.
- Raw text를 Snapshot의 완전한 대체물이라고 문서화하지 않는다.
- Apply 실패 시 일부 section이나 definition만 반영하지 않는다.
- `@image1` naming customization과 UUID AST를 Raw session 구현에 함께
  끼워 넣지 않는다.
