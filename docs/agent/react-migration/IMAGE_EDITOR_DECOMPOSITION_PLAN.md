# Image Editor Decomposition Plan

## 1. 목적

`frontend/src/reference-loader/editors/image-editor.ts`의 책임을 안정적인 경계로
분리한다.

목표는 파일 크기 자체를 줄이는 것이 아니라 다음을 명확히 나누는 것이다.

- DOM과 React view에 의존하지 않는 이미지 편집 계산
- draft와 persisted edit recipe의 변환
- mask pixel 연산
- dialog, canvas, pointer gesture, history, 비동기 preview를 조정하는 session

기존 `openImageEditor()`의 동작 계약과 `ImageEditorDialog`의 public callback 계약은
유지한다.

## 2. 현재 구조

현재 `image-editor.ts`는 다음 책임을 함께 가진다.

- crop, viewport, aspect ratio, 좌표 변환
- draft 초기화와 `ImageEditRecipe` 생성
- mask brush와 mask inversion
- `LocalHistory` 기반 undo/redo
- canvas 초기화와 mask 복원
- crop/viewport/mask pointer gesture
- wheel zoom과 history merge
- background removal preview와 AbortController 관리
- metadata loading
- React dialog mount/unmount
- Apply, Cancel, Restore Original 결과 생성

`image-editor-react.tsx`는 이미 JSX view와 DOM ref 수집을 별도 소유한다. 따라서
이번 계획은 React view를 다시 나누는 것이 아니라, `image-editor.ts` 내부의 순수
계산과 session orchestration을 분리하는 데 집중한다.

## 3. 목표 구조

```text
editors/
├── image-editor.ts              # public entry point와 session orchestration
├── image-editor-model.ts        # draft 타입, 초기화, recipe 변환
├── image-editor-geometry.ts     # crop/viewport/aspect 순수 계산
├── image-editor-mask.ts         # mask pixel 순수 계산
└── image-editor-react.tsx       # React dialog view와 DOM refs
```

### 3.1 `image-editor-model.ts`

이 모듈은 편집 상태의 데이터 계약과 persisted edit 변환을 소유한다.

이동 대상:

- `ImageEditorDraft`
- `ImageEditorOptions` 및 결과 타입
- `MaskBrushTool`, `CropHandle`, interaction 관련 타입
- `createInitialImageDraft()`
- `initialImageEditorRecipe()`
- `recipeFromDraft()`
- materialized edit 판별에 필요한 순수 helper

제약:

- DOM, React, `document`, canvas API를 import하지 않는다.
- `ImageItem`과 `ImageEditRecipe` 타입만 backend/domain contract로 사용한다.
- 기존 import caller를 한 번에 바꾸지 않고 `image-editor.ts`에서 필요한 타입과
  함수를 re-export할지 먼저 검토한다.

### 3.2 `image-editor-geometry.ts`

crop과 viewport의 수학적 변환을 순수 함수로 분리한다.

이동 대상:

- `viewportPanBounds()`
- `constrainCropViewport()`
- `resizeNormalizedCrop()`
- `cropAspectRatioValue()`
- `fitNormalizedCropToAspect()`
- `resizeNormalizedCropToAspect()`
- `moveNormalizedCrop()`
- `isNormalizedCropFullyVisible()`
- `isNormalizedCropViewportFilling()`
- `cropSelectionModeForFrame()`
- `isCropHandleVisible()`
- `projectCropToViewport()`
- `unprojectCropFromViewport()`
- `normalizedCropToPixels()`
- `pixelCropToNormalized()`
- `updatePixelCrop()`
- `updatePixelCropForAspect()`
- `resolveImageEditorPointerIntent()`

제약:

- 입력 draft를 직접 수정하지 않는다.
- viewport의 실제 DOM 크기는 숫자 인자로 받는다.
- `HTMLElement`, `PointerEvent`, `ImageData`를 사용하지 않는다.
- crop 경계, aspect ratio, flip, pan의 기존 수치 계약을 유지한다.

### 3.3 `image-editor-mask.ts`

canvas를 직접 조작하지 않는 mask pixel 연산을 분리한다.

이동 대상:

- `applyMaskBrush()`
- `invertMaskPixels()`
- `maskBrushToolForModifier()`

`canvasFile()`처럼 HTML canvas에서 `File`을 만드는 기능은 session 쪽에 남긴다.
이는 pixel 계산과 browser encoding lifecycle을 서로 다른 책임으로 유지하기
위함이다.

### 3.4 `image-editor.ts`

public entry point이자 session coordinator로 남긴다.

계속 소유할 책임:

- `openImageEditor()` public API
- dialog와 React root의 생성 및 해제
- `LocalHistory` instance
- canvas와 DOM ref의 실제 연결
- pointer/wheel event listener 등록 및 제거
- gesture 진행 상태
- metadata/background preview의 AbortController
- render orchestration
- Apply/Cancel/Restore 결과 settle

이 파일에서 개별 이벤트 handler를 모두 별도 파일로 옮기지는 않는다. session
state가 강하게 연결되어 있으므로, 먼저 순수 함수 경계를 제거한 뒤 남은 결합도를
재평가한다.

## 4. 실행 단계

### E1 — 모델과 타입 경계 고정

1. `ImageEditorDraft`, option/result 타입의 caller를 확인한다.
2. `image-editor-model.ts`를 추가한다.
3. 초기 draft와 recipe 생성 결과가 기존과 동일한지 테스트한다.
4. 기존 import 경로가 필요한 경우 `image-editor.ts`에서 compatibility re-export를
   유지한다.

완료 기준:

- model 모듈은 DOM/React 의존성이 없다.
- materialized edit와 revision 계산이 기존과 동일하다.
- 기존 editor 호출자는 `openImageEditor()` 계약을 변경하지 않는다.

### E2 — geometry 순수 함수 추출

1. crop/viewport 관련 타입과 함수를 `image-editor-geometry.ts`로 이동한다.
2. `image-editor.ts`는 geometry 함수를 import해서 기존 session 흐름에 사용한다.
3. 기존 geometry 테스트를 새 모듈의 직접 테스트로 이동하거나 보강한다.

완료 기준:

- geometry 테스트가 DOM과 React 없이 실행된다.
- normalized crop과 pixel crop의 round-trip 계약이 유지된다.
- aspect preset, flip, clipped crop, viewport pan 경계가 유지된다.

### E3 — mask 순수 함수 추출

1. mask brush와 inversion을 `image-editor-mask.ts`로 이동한다.
2. brush opacity, radius, boundary clipping, RGBA alpha 계약을 고정한다.
3. canvas encoding과 history commit은 `image-editor.ts`에 남긴다.

완료 기준:

- mask pixel 테스트가 canvas element 없이 실행된다.
- erase/restore, Alt modifier, invert 결과가 기존과 동일하다.
- mask snapshot의 width/height와 `maskTouched` 처리 계약이 유지된다.

### E4 — session 경계 검토

E1~E3 이후에만 `openImageEditor()` 내부를 재평가한다.

다음 조건을 모두 만족할 때만 별도의 `ImageEditorSession` 추출을 검토한다.

- crop gesture와 mask/background async 흐름이 독립적인 command/state 경계를 가진다.
- session을 추출해도 DOM ref와 history forwarding만 늘어나지 않는다.
- session 단위 contract test를 DOM fixture로 안정적으로 작성할 수 있다.

조건을 만족하지 않으면 `openImageEditor()`를 coordinator로 유지한다. 함수가
크다는 이유만으로 추가 controller나 service를 만들지 않는다.

## 5. 보존해야 할 계약

- `openImageEditor(options)`의 Promise 결과 형태
- Apply, Cancel, Restore Original semantics
- `LocalHistory` undo/redo와 wheel merge 동작
- materialized edit에서 기존 crop/mask를 재사용하지 않는 규칙
- crop 좌표의 normalized/pixel 변환과 aspect 제한
- mask brush의 erase/restore 및 opacity 처리
- background preview 취소, 실패, 재요청 semantics
- `AbortSignal`에 의한 dialog 종료
- React dialog callback 이름과 `ImageEditorReactRefs` 계약
- dialog와 global event listener의 idempotent cleanup

## 6. 테스트 계획

각 단계에서 다음 검사를 유지한다.

- model: initial draft, recipe, revision, materialized edit
- geometry: crop resize/move, aspect, pan bounds, projection round-trip
- mask: brush, boundary clipping, opacity, inversion
- session: dialog open/close, apply/cancel, undo/redo, metadata, background preview
- React: refs 등록, native change deduplication, action callback routing

저장소 검사:

```text
bun run typecheck
bun run test:frontend
bun run test:unit
bun run build
```

## 7. 하지 않는 것

- `image-editor-react.tsx`를 다시 작은 presentational component로 쪼개기
- 모든 pointer handler를 별도 service로 이동하기
- 새 global state library 도입
- `LocalHistory`를 다른 history store로 교체하기
- image edit/backend recipe contract 변경
- 파일 줄 수만 줄이기 위한 facade와 forwarding layer 추가

## 8. 중단 기준

다음 중 하나가 발생하면 추가 분리를 중단한다.

- 새 모듈이 대부분 기존 함수의 단순 forwarding만 제공한다.
- DOM ref, history, gesture state가 여러 모듈에 중복된다.
- 순수 계산과 session side effect의 경계가 오히려 불명확해진다.
- 기존 editor contract test와 live UI 검증이 더 어려워진다.

이 계획의 성공 기준은 `image-editor.ts`의 최소 줄 수가 아니라, 순수 이미지 편집
계산을 browser session과 독립적으로 검증할 수 있게 되는 것이다.
