# Media Editor React 전환 계획

작성 기준: 2026-09-12

## 1. 목적

`trim-editor.ts`와 `image-editor.ts`의 긴 `innerHTML` template literal은 현재
React migration의 런타임 실패 원인은 아니다. 두 모달은 `document.body`에 별도로
붙는 native island이고, React Loader root를 덮어쓰지 않는다.

다만 template literal 내부의 HTML은 TypeScript formatter와 linter가 실제 markup을
검사하지 못하게 한다. 이 계획의 목적은 **editor의 markup 소유권을 React/TSX로
옮겨 format/lint/typecheck가 동작하게 만드는 것**이다. canvas, mask, playback 같은
브라우저 native 상호작용까지 한 번에 React state로 재작성하는 것이 목적은 아니다.

## 2. 현재 구현과 판단

현재 경계는 다음과 같다.

```text
React Media card
  └─ actions.edit(id, channel)
       └─ ReferenceLoaderController.#editItem()
            ├─ openImageEditor()  → body 밖의 native modal
            └─ openTrimEditor()   → body 밖의 native modal
```

- React는 Media toolbar, card, Edit 버튼, Loader view를 소유한다.
- `loader.ts`는 `openImageEditor()`와 `openTrimEditor()`를 호출하고 결과를
  기존 graph/state transaction으로 반영한다.
- 각 editor는 모달을 열 때 markup을 한 번 생성하고, `LocalHistory`, canvas,
  pointer event, playback, AbortController를 editor 내부에서 관리한다.
- 모달 종료 시 listener와 player를 정리하고 dialog를 제거한다.
- 현재 `frontend/src`의 `innerHTML` 사용은 두 editor의 초기 markup뿐이다.

따라서 목표는 다음처럼 제한한다.

```text
open*Editor() Promise API 유지
        ↓
React가 dialog/form/controls markup 소유
        ↓
canvas/video/player는 안정된 native ref/host로 유지
```

## 3. 전환 원칙

### 유지할 것

1. `openImageEditor(options)`와 `openTrimEditor(options)`의 Promise 반환 계약
2. `ReferenceLoaderController.#editItem()`의 호출·취소·Apply 결과 처리
3. Loader의 저장 상태, reducer, graph transaction, serialization
4. editor-local `LocalHistory`의 Undo/Redo 의미
5. waveform drawing, mask canvas, crop math, pointer gesture, audio/video player
6. 기존 `.rl-modal`, `.rl-image-editor`, `.rl-trim-editor` CSS 계약
7. 모달을 `document.body`에 붙이는 위치와 abort 시 즉시 닫히는 lifecycle

### 제거할 것

1. editor markup을 담은 긴 `dialog.innerHTML` 문자열
2. React로 옮긴 button/input/textarea를 `querySelector()`로 다시 찾아
   delegated event를 설치하는 방식
3. 동적 텍스트에 필요한 수동 `escapeHtml()` 호출

### 하지 않을 것

- Loader의 canonical state를 React state로 복제하지 않는다.
- 새 global state library나 modal dependency를 추가하지 않는다.
- canvas의 모든 pixel을 매 pointermove마다 React state에 저장하지 않는다.
- 이 작업과 CSS framework 교체, backend 계약 변경, ComfyUI hook 추가를 결합하지 않는다.
- `innerHTML`을 없애기 위해 image processing 또는 native playback 엔진을 다시 작성하지 않는다.

## 4. 목표 ownership

| 영역                            | 목표 소유자                                                 | 비고                                                                   |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `dialog` lifecycle              | `open*Editor()` bridge + React mount                        | host 생성/append/remove는 bridge가 담당                                |
| dialog/form/button/input markup | React component                                             | JSX가 escape와 attribute type을 담당                                   |
| editor draft/history            | native editor session의 `LocalHistory` 또는 React component | Loader 저장 상태와 분리된 transient state; DOM 자체가 기준 상태는 아님 |
| crop/mask 수학                  | 기존 pure function                                          | 변경하지 않고 재사용                                                   |
| mask canvas drawing             | native canvas ref                                           | React effect 또는 명시적 draw command에서 호출                         |
| waveform drawing                | native canvas ref                                           | snapshot 변경 시 다시 그리기                                           |
| audio/video playback            | 기존 player/native element                                  | player lifecycle은 effect cleanup에서 해제                             |
| Apply/Cancel 결과               | `open*Editor()` Promise bridge                              | Controller API를 변경하지 않음                                         |
| Loader state/serialization      | `ReferenceLoaderController`                                 | React가 복제하지 않음                                                  |

한 DOM subtree에는 한 owner만 둔다. React가 렌더한 input/button을 native
`querySelector()` 코드가 동시에 갱신하지 않는다. canvas의 2D context, video/audio
element의 playback API처럼 명시된 native host 조작만 허용한다.

### State ownership 결정

editor 하나에만 귀속된 draft/state는 native editor session에서 계속 관리해도
안전하다. 이 모달은 하나의 호출에 속하고, 부모는 편집 중간 상태가 아니라
Apply/Cancel의 최종 Promise 결과만 받기 때문이다.

현재 구조에서는 다음 구분을 유지한다.

| 상태 종류                                                        | 기준 소유자                     | 설명                                                    |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| crop/range, mode, flip, background 옵션, Undo/Redo               | editor closure의 `LocalHistory` | 편집 중 draft와 history의 canonical state               |
| `input.value`, `hidden`, `aria-*`, 선택/포커스                   | native DOM                      | canonical state의 표시 및 임시 입력 buffer              |
| mask pixel, pointer gesture, seek timer, AbortController, player | canvas/ref와 native runtime     | 고빈도·수명 관리 상태; React state에 매번 복사하지 않음 |
| Apply 이후 item/crop/caption/serialization                       | `ReferenceLoaderController`     | Loader의 저장·graph transaction 경계                    |

따라서 **React markup 전환이 State 전환을 강제하지 않는다.** 다만 React가
input/button의 owner가 되면 해당 controls의 value와 event도 React 또는 하나의
명시적 adapter가 소유해야 한다. React render와 native `render()`가 같은
controls를 동시에 갱신하는 혼합 ownership은 허용하지 않는다.

State를 React로 옮길 때도 모든 값을 `useState`로 만들지 않는다.

- React state로 옮길 후보: mode, cold form values, background status, history snapshot
- `useRef`/native로 유지할 후보: mask pixel buffer, pointermove 중 gesture, timer,
  player, `AbortController`, canvas context
- 이동하지 않을 것: Loader canonical state와 graph/serialization 책임

### `LocalHistory`와 React snapshot adapter 계약

전략 B에서 React가 editor-local State를 직접 렌더링하는 경우에는
`LocalHistory`를 React state로 복사하지 않는다. `LocalHistory`가 canonical owner로
남고, React는 외부 store snapshot을 구독하는 view가 된다. 전략 A처럼 editor bridge가
모든 변경 뒤 `render()`를 직접 호출하는 경우에는 이 adapter를 추가하지 않아도 된다.

adapter를 도입할 때 `LocalHistory`는 다음 계약을 제공한다.

```ts
interface HistorySnapshot<T> {
  value: T
  canUndo: boolean
  canRedo: boolean
}

interface LocalHistory<T> {
  readonly snapshot: HistorySnapshot<T>
  subscribe(listener: () => void): () => void
}
```

구현 규칙:

1. `commit`, `replace`, `undo`, `redo`가 `value` 또는 `canUndo`/`canRedo`를
   실제로 변경했을 때만 listener를 호출한다.
2. no-op `commit`과 no-op `undo`/`redo`는 알림하지 않는다.
3. 변경이 없을 때 `snapshot` 객체의 identity를 유지하고, 변경 시 새 snapshot을
   발행한다. `value` 내부의 `NormalizedCrop`, `TimeRange`, 배열은 immutable update를
   사용한다.
4. `Uint8ClampedArray` 같은 mutable buffer를 history에 넣을 때는 입력과 history
   snapshot 사이의 alias를 만들지 않는다. mask snapshot은 기존의 복사 경계를
   유지한다.
5. `subscribe()`는 unsubscribe 함수를 반환하며, editor 종료 시 반드시 호출한다.
6. React hook은 `useState`로 State를 복제하지 않고 `useSyncExternalStore`로
   `snapshot`을 읽는다. action은 adapter를 통해 `commit`/`replace`/`undo`/`redo`를
   호출한다.

`LocalHistory`만으로 React가 표시할 모든 값을 표현할 수 없는 경우에는 별도의
`EditorViewSnapshot`을 둔다. 이 snapshot은 history snapshot을 복제하는 State가 아니라
React view에 필요한 projection이다. 예를 들어 trim은 history의 확정 range와 현재
slider 조작 중인 `liveDraft`, playback snapshot, validation error를 구분한다.

```text
LocalHistory.snapshot       확정된 undo/redo State
EditorViewSnapshot          React가 표시할 값의 projection
native refs/runtime         canvas, gesture, player, timer, AbortController
```

`liveDraft`를 history에 매 input마다 commit하지 않는다. trim의 input/slider 조작은
view snapshot 또는 native draft를 갱신하고, `change`/조작 완료 시점에만
`LocalHistory.commit()`한다. image의 crop/move/resize gesture도 같은 규칙을 따르며,
pointermove 중간값과 canvas pixel drawing은 React snapshot에 넣지 않는다.

## 5. 전환 전략

두 가지 전략 중 하나를 editor 단위로 선택한다.

### 전략 A — native editor 유지

Markup, native event, `LocalHistory`, canvas/player를 모두 기존 editor session이
소유한다. 가장 작은 변경이며, React migration 실패로 취급하지 않는다. 단, 긴
HTML 문자열 내부 markup의 formatter/linter 한계는 남는다.

### 전략 B — React shell + 선택적 State 전환

React가 dialog/form/controls의 markup과 lifecycle을 소유하고, editor-local
`LocalHistory`는 처음에는 native session에 남길 수 있다. React가 controls의
값을 직접 렌더해야 하는 시점부터는 cold state를 React snapshot으로 승격한다.
canvas, mask, gesture, playback은 명시적인 native ref/adapter로 유지한다.

전략 B를 적용할 때의 최소 조건은 다음과 같다.

1. `open*Editor()` Promise API는 유지한다.
2. React-owned controls는 native `querySelector()` 기반 render 대상에서 제거한다.
3. native hot path는 React state를 매번 갱신하지 않고 ref와 명시적 draw/update를 사용한다.
4. React-owned controls가 editor-local history를 표시하는 경우
   `LocalHistory` snapshot adapter를 통해서만 갱신한다.
5. Apply/Cancel/Abort/Unmount 시 state와 listener가 정확히 한 번 정리된다.

초기 권장안은 `trim-editor`에 전략 B를 적용하되 State 전환은 cold controls부터
시작하고, `image-editor`는 전략 A 또는 JSX shell만 먼저 적용하는 것이다.

### UI primitive 통합 전략 — Tailwind 비도입

현재 UI가 이미 ComfyUI theme 변수와 `rl-*` namespace를 사용하고 있으므로,
Tailwind CSS나 shadcn/ui 패키지를 추가하지 않는다. 목표는 shadcn/ui의 source-owned
component composition, 명시적 variant, 접근성 패턴만 참고하여 작은 내부 UI primitive를
만드는 것이다.

#### 유지할 경계

- `--comfy-*`와 `--rl-*` CSS token을 색상·간격·상태 표현의 기준으로 유지한다.
- `frontend/src/reference-loader/styles/*.css`를 기본 스타일 소유자로 유지한다.
- Tailwind preflight, 전역 reset, utility class 생성기를 도입하지 않는다.
- `rl-*` class namespace를 유지하여 ComfyUI host의 전역 CSS와 충돌하지 않게 한다.
- native `<dialog>`, canvas, crop overlay, waveform, audio/video player는 전용 native
  경계를 유지한다.

#### 우선 추출할 primitive

다음 primitive는 시각적 wrapper가 아니라 markup, 상태, 접근성 계약을 공유하는 작은
React component로 만든다.

```text
frontend/src/reference-loader/ui/
  button.tsx
  field.tsx
  toggle-group.tsx
  status-message.tsx
  editor-footer.tsx
```

초기 primitive의 책임은 다음으로 제한한다.

- `Button`: primary, secondary, danger, disabled, busy 상태와 focus-visible 표시
- `Field`: label, description, error, input/select/textarea 연결과 `aria-*` 계약
- `ToggleGroup`: mode/tool 선택, `aria-pressed`, keyboard focus 순서
- `StatusMessage`: error, warning, loading, success의 semantic 상태 표시
- `EditorFooter`: history, Cancel, Apply의 공통 배치와 primary action 상태

primitive는 editor State나 `LocalHistory`를 직접 소유하지 않는다. State와 action은
props 또는 snapshot/action adapter로 받고, native canvas/player를 내부에서 관리하지
않는다. 같은 DOM subtree에 React와 native mutation owner를 중복으로 두지 않는다.

#### 구현 순서

1. `tokens.css`, `native-editor.css`, `loader.css`, `image-editor.css`,
   `trim-editor.css`에서 반복되는 button/input/status 패턴을 목록화한다.
2. 새 CSS framework 없이 `ui/` primitive와 `ui.css` 또는 기존 공통 CSS 규칙을
   추가한다. 각 primitive는 `rl-*` class와 `data-*` variant를 사용한다.
3. trim editor에서 Field, ToggleGroup, EditorFooter를 우선 적용한다. 기존
   `LocalHistory` snapshot/action 경계와 Promise bridge는 변경하지 않는다.
4. trim 동작과 CSS가 안정된 후 image editor에서 Field, Button, StatusMessage를
   적용한다. canvas, crop overlay, mask brush preview는 계속 image 전용 CSS와
   native ref를 사용한다.
5. loader, H3 workspace와 공통화할 수 있는 primitive만 재사용한다. 서로 다른
   interaction semantics를 단순히 하나의 거대 component로 합치지 않는다.
6. 공통 primitive 적용 후 사용하지 않는 중복 CSS만 제거한다. 기존 class와
   serialization, data attribute 계약을 한 번에 바꾸지 않는다.

#### Tailwind 재평가 조건

Tailwind 도입은 다음 조건이 실제로 관찰될 때만 별도 설계한다.

- 세 개 이상의 화면에서 동일한 layout utility 조합이 반복된다.
- 수동 CSS 유지 비용이 primitive 추출 비용보다 커진다.
- ComfyUI host와 격리된 CSS 범위·preflight 전략을 검증할 수 있다.
- build output, custom-node 배포, Legacy Canvas/Nodes 2.0 theme에서 회귀가 없다.

그 전까지는 Tailwind 설정, preflight, shadcn CLI, Radix dependency를 추가하지 않는다.

## 6. 단계별 작업

### 단계 0 — 기준선과 경계 고정

작업 파일:

- `frontend/test/reference-loader-editor.test.ts`
- `frontend/test/reference-loader-dom.test.ts`
- `docs/TESTING.md`

작업:

1. 현재 editor 동작을 기준선으로 기록한다.
2. image/trim dialog가 Loader root의 자식이 아니라 `document.body`의 별도
   subtree인지 테스트로 고정한다.
3. Apply, Cancel, backdrop, Abort, node destroy 후 dialog/listener/player가
   남지 않는지 확인한다.
4. 현재 editor 테스트와 `bun run typecheck`, `bun run test:frontend`를 통과시킨다.

완료 조건:

- 기존 동작 변경 없이 modal parent와 cleanup 경계가 테스트에 남아 있다.
- React root identity와 modal identity를 서로 다른 lifecycle로 설명할 수 있다.

### 단계 1 — `trim-editor` React 전환

우선순위가 가장 높은 단계다. trim editor는 form과 transport control 비중이
높아 JSX의 가독성·format/lint 이득이 가장 크다.

권장 파일 구성:

- `frontend/src/reference-loader/editors/trim-editor.ts`
  - `openTrimEditor()` Promise bridge와 editor domain helper 유지
- `frontend/src/reference-loader/editors/trim-editor-react.tsx`
  - `TrimEditorDialog` markup과 React event handler
- `frontend/test/reference-loader-editor.test.ts`
  - 기존 동작 테스트 확장

구현 순서:

1. bridge가 `dialog` host를 만들고 class/aria 속성을 설정한 뒤 `body`에
   append한다.
2. `createRoot(dialog)`로 `TrimEditorDialog`를 mount하고, 현재 `options`를
   명시적 props로 전달한다.
3. `<form>`, header, range input, number input, caption, history/footer를
   JSX로 옮긴다.
4. editor draft/history를 React로 옮기는 것은 필수가 아니다. native editor
   session에 하나의 `LocalHistory`를 유지할 수 있다. React가 controls를
   소유하는 경우에만 [snapshot adapter 계약](#localhistory와-react-snapshot-adapter-계약)을
   적용하고, native render와 React render가 같은 controls를 동시에 갱신하지 않게 한다.
5. playback snapshot은 기존 `AudioPreviewPlayer`/`VideoPreviewPlayer` subscription을
   사용한다. 재생 element와 player를 unrelated render에서 교체하지 않는다.
6. waveform canvas는 `ref`로 받고 snapshot/초기화 시 기존 `drawWaveform()`을 호출한다.
7. Apply/Cancel/cancel event/Abort는 bridge callback을 통해 Promise를 resolve하고,
   bridge가 `root.unmount()` 후 dialog를 제거한다.
8. JSX가 소유하는 controls에서는 `dialog.addEventListener("click/input/change")`
   delegated handler를 제거한다.

trim에서 snapshot adapter를 적용할 때에는 `range`의 확정 history와 조작 중인
`liveDraft`를 한 State로 혼합하지 않는다. React controlled input으로 전환하면
`liveDraft` 갱신과 history commit을 서로 다른 action으로 제공하고, Undo/Redo 버튼의
disabled 상태는 history snapshot에서 계산한다.

특히 Seek 업데이트처럼 빈번한 값은 매 프레임마다 전체 JSX tree를 재생성하지
않는다. 재생 snapshot은 필요한 text/value만 갱신하고, native player가 실제
재생을 계속 소유한다.

### 단계 2 — `image-editor` JSX shell 전환

trim editor가 안정된 뒤 image editor의 static shell을 옮긴다. image editor의
핵심은 markup보다 canvas/gesture engine이므로 처음부터 모든 pointer logic을
React handler로 재작성하지 않는다.

권장 파일 구성:

- `frontend/src/reference-loader/editors/image-editor.ts`
  - pure crop/mask math와 Promise bridge 유지
- `frontend/src/reference-loader/editors/image-editor-react.tsx`
  - dialog/form/control markup
- `frontend/test/reference-loader-editor.test.ts`
  - 기존 crop/mask/background/restore 테스트 확장

구현 순서:

1. header, preview layout, interaction mode, viewport controls, crop fields,
   mask controls, transform/background controls, history/footer를 JSX로 옮긴다.
2. stage, visual, image, mask canvas, crop overlay, brush preview를 `ref`로
   연결하고 DOM identity를 유지한다.
3. 기존 `render()`의 style/attribute/canvas 갱신을 다음 두 종류로 나눈다.
   - React props/state로 표현 가능한 UI: React render
   - canvas pixels, image transform, crop overlay geometry: 명시적 native ref update
4. 기존 pointer gesture engine을 우선 native hook/helper로 유지한다. 이 helper는
   `dialog.querySelector()` 대신 refs를 받고, draft 변경 callback만 호출한다.
5. mode/button/input/change 이벤트를 JSX handler로 옮길 때는 해당 controls의
   owner를 React로 확정한다. crop math와 `LocalHistory`는 그대로 재사용할 수
   있지만, React-owned controls는 snapshot adapter를 통해 렌더하고 native `render()`가
   같은 controls를 다시 갱신하지 않게 한다.
6. background preview, metadata 요청, abort cleanup은 effect와 명시적인
   controller ownership으로 이동한다.
7. Apply 시 mask canvas snapshot을 PNG로 만들고 기존
   `AppliedImageEditorResult`/`RestoredImageEditorResult`를 그대로 반환한다.

이 단계가 끝나도 canvas drawing과 gesture listener가 native인 것은 실패가
아니다. React가 shell과 lifecycle을 소유하고 native interaction island가
명시적으로 연결되어 있으면 목표 경계를 충족한다.

### 단계 3 — 선택적 native interaction 정리

단계 1·2의 안정화 이후에도 실제 유지보수 문제가 남을 때만 진행한다.

- trim의 native delegated handler를 전부 JSX callback으로 정리
- image의 pointer/wheel handler를 React event 또는 작은 custom hook으로 정리
- `render()`를 snapshot reducer와 native draw effect로 세분화

이 단계는 `innerHTML` 제거에 필요한 조건이 아니다. interaction 코드를 옮기는
것보다 현재 native helper의 안정성과 pointer 성능이 더 중요하면 그대로 둔다.

## 7. 테스트 계획

### LocalHistory snapshot adapter

- snapshot identity는 State 변경 때만 바뀐다.
- `commit`, `replace`, `undo`, `redo`가 실제 변경 시 listener를 호출한다.
- no-op mutation은 listener를 호출하지 않는다.
- 여러 listener가 독립적으로 unsubscribe된다.
- editor 종료 후 unsubscribe된 listener와 delayed callback이 React나 DOM을 갱신하지 않는다.
- trim의 live draft input/slider 조작은 history entry를 매 이벤트마다 만들지 않고,
  change/조작 완료 시 하나의 entry를 만든다.
- image의 pointermove 중간값은 history와 React snapshot에 들어가지 않고,
  gesture 완료 시 commit된다.

### 공통 lifecycle

- dialog는 `document.body` 아래에 있고 Loader React root 안에 있지 않다.
- React update가 발생해도 dialog, canvas, video element identity가 유지된다.
- Apply/Cancel/backdrop/ESC/Abort가 정확히 한 번만 resolve한다.
- unmount 뒤 delayed metadata/background/playback callback이 DOM을 갱신하지 않는다.
- node destroy 후 dialog, global key listener, player, object URL이 남지 않는다.

### Trim

- start/end slider와 numeric field의 최소 간격 및 clamp
- Undo/Redo와 caption 반환
- audio playback, video playback, muted/with-audio 경계
- waveform와 no-audio/silent 상태 표시
- Seek 중 draft range, stop, playback end 처리

### Image

- View/Crop/Mask mode 전환
- crop resize/move/pan/zoom/flip과 source pixel 변환
- mask erase/restore/invert, Alt modifier, canvas snapshot
- background preview 성공/실패/취소
- Restore original, caption, Apply recipe, abort

### 정적 품질 게이트

각 단계마다 다음을 실행한다.

```shell
bun run fmt:check
bun run lint
bun run typecheck
bun run test:frontend
bun run build
git diff --check
```

`fmt:check`와 `lint`가 통과하는 것만으로 editor 동작이 검증되지는 않는다.
DOM/canvas/player 테스트와 live ComfyUI 검증을 별도로 유지한다.

## 8. 완료 기준

다음 조건을 모두 만족할 때 editor shell React 전환을 완료로 본다.

1. 두 editor의 production markup에 `innerHTML`이 없다.
2. JSX markup에 대해 repository formatter/typecheck/linter가 실제 구조를
   검사할 수 있다.
3. `open*Editor()`와 Loader Controller API가 변하지 않는다.
4. editor-local history와 Apply/Cancel 결과가 기존과 동일하다.
5. React-owned DOM과 native canvas/player host의 owner가 겹치지 않는다.
6. 일반 Loader rerender, workflow restore, node destroy가 열린 editor의
   lifecycle을 깨뜨리지 않는다.
7. 자동 테스트와 build가 통과하고, Nodes 2.0 및 Legacy Canvas에서 modal,
   focus, resize, playback을 수동 확인한다.
8. 전략 B를 선택한 editor에서는 React-owned controls가 snapshot/action adapter만
   사용하며, native `render()`와의 중복 mutation이 없다.
9. 공통 React controls는 내부 `ui/` primitive와 기존 `--rl-*` CSS token을 사용하며,
   Tailwind preflight나 전역 utility class에 의존하지 않는다.

## 9. 권장 PR 분할

1. **Trim React shell PR** — 단계 0~1, trim 내부만 변경
2. **UI primitive PR** — trim에서 검증한 공통 Button/Field/Status/Footer 추출 및
   기존 token 기반 스타일 정리
3. **Image React shell PR** — 단계 2, image 내부만 변경
4. **Optional interaction cleanup PR** — 단계 3, 필요성이 확인된 경우에만

각 PR에서 Loader state schema, backend, ComfyUI extension hook, unrelated CSS
정리는 함께 변경하지 않는다. 목표는 `innerHTML`을 없애면서도 현재 native
interaction의 안정된 경계를 보존하는 것이다.
