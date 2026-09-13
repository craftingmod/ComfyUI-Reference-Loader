# Reference Loader Timeline Controller 경계

## 목적

Reference Loader에 Timeline 기능을 유지하면서 `ReferenceLoaderController`가 계속 비대해지는 것을 막는다.

이 문서는 Timeline 전용 coordinator를 추가하는 최소 설계를 정의한다. 새로운 전역 상태관리 시스템, 별도의 Media state, 또는 Studio 전체 추상화를 도입하지 않는다.

## 결론

현재 Controller에서 가장 명확한 분리 단위는 Timeline 화면 전체가 아니라 **Timeline 편집 세션**이다.

```text
ComfyUI extension
    |
    v
ReferenceLoaderController       host/lifecycle orchestration
    |
    +-- LoaderStore              canonical media state and history
    +-- Media runtime            upload, metadata, preview, playback
    +-- H3TimelineSession        Timeline draft and commands
    |
    +-- React view snapshots
          +-- Loader UI
          +-- H3WorkspaceReact   Timeline view only
```

`H3TimelineSession`은 Timeline의 임시 편집 상태와 명령을 소유한다. 실제 저장 상태와 undo/redo는 기존 `LoaderStore`가 계속 소유한다.

## 현재 분리 대상

현재 구현에는 이미 Timeline 경계를 나타내는 코드가 모여 있다.

- `frontend/src/reference-loader/components/loader.ts:71-86`
  - `H3EditorState`
- `frontend/src/reference-loader/components/loader.ts:354-390`
  - React action과 Controller 메서드 연결
- `frontend/src/reference-loader/components/loader.ts:926-987`
  - Timeline workspace view projection
- `frontend/src/reference-loader/components/loader.ts:1091-2003`
  - Guide drop, placement 선택, frame 편집, draft, Apply/Cancel
- `frontend/src/reference-loader/components/h3-workspace-react.tsx`
  - Timeline workspace의 React presentation
- `frontend/src/reference-loader/h3-media-guides.ts`
  - media와 Guide 관계에 대한 재사용 가능한 순수 로직
- `frontend/src/reference-loader/components/h3-timeline.ts`
  - Timeline placement projection

첫 단계에서는 `loader.ts:1091-2003`의 H3 세션 로직과 관련 private field만 옮긴다. Media runtime, Prompt 전체, ComfyUI extension glue는 함께 분리하지 않는다.

## 책임 경계

### `H3TimelineSession`이 소유하는 것

- 현재 Timeline 선택 상태
- `H3EditorState`와 임시 Timeline draft
- Start/End 선택
- Guide 추가·삭제·source 변경
- frame 입력 중 값과 commit
- Guide/Timeline dirty 상태
- Apply/Cancel 전환
- Timeline 전용 validation 호출
- Timeline session id와 편집 중 충돌 방지

### `H3TimelineSession`이 소유하지 않는 것

- Media item의 canonical state
- Media upload, metadata, preview, playback
- 별도의 history 또는 undo/redo stack
- Prompt document 전체
- ComfyUI node/widget 직접 조작
- React root 생성·unmount
- DOM 전체 재렌더링

Timeline이 Media를 조회해야 할 때는 host capability를 통해 현재 `LoaderState`를 읽는다. Media를 직접 복제해 별도 상태로 유지하지 않는다.

## 최소 Host 계약

새 coordinator가 전체 `ReferenceLoaderController`를 전달받지 않도록 한다. 필요한 기능만 좁은 host 계약으로 전달한다.

개념적인 형태는 다음과 같다.

```ts
interface H3TimelineHost {
  getState(): LoaderState
  dispatch(action: LoaderAction): boolean
  setStatus(message: string): void
  requestRender(force?: boolean): void
}
```

실제 구현에서는 이미 존재하는 `LoaderStore`, `loaderReducer`, `validateH3Timeline`, `h3-media-guides.ts`의 타입과 함수를 재사용한다. coordinator가 자체적으로 동일한 reducer, validation, serialization을 만들지 않는다.

필요한 DOM focus 복구는 처음부터 별도 UI framework로 추상화하지 않는다. 기존 Controller의 focus helper를 유지하거나, session 명령의 결과로 필요한 focus target만 부모가 처리한다.

## 명령 표면

Timeline React view가 호출할 명령은 다음 정도로 제한한다.

```text
toggle()
collapse()
selectPlacement(placement, channel)
openForMedia(mediaId, channel, guideId?)
toggleGuide(mediaId, channel)
dropGuide(channel, frame, dataTransfer)
inputFrame(guideId, value)
commitFrame(guideId, value)
changeGuideSource(guideId, channel, mediaId)
addPlacement(position, frame)
removePlacement(guideId)
apply()
cancel()
reset()
```

이 명령들은 Media를 직접 바꾸지 않는다. Apply 시점에만 기존 Store action을 통해 canonical state를 변경한다.

## 상태 흐름

```text
Media/Loader canonical state
          |
          v
H3TimelineSession.open()
          |
          +-- clone H3TimelineState as draft
          +-- keep initial draft for dirty comparison
          +-- expose derived H3WorkspaceView
          |
          +-- input/drag/select -> draft only
          |
          +-- Apply -> validate -> LoaderStore.dispatch()
          +-- Cancel -> discard draft
```

다음 규칙을 지킨다.

1. Draft는 `H3TimelineState`에 한정한다.
2. Media state와 Prompt state를 Timeline draft에 포함하지 않는다.
3. Apply 전에는 history entry나 graph transaction을 만들지 않는다.
4. Apply 시 validation 실패 시 draft를 유지하고 저장하지 않는다.
5. Cancel, clear, restore, destroy 시 session을 명시적으로 reset/close한다.
6. Media가 삭제되거나 사용 불가능해지면 session은 기존 state를 다시 읽고 안전하게 종료한다.

## `ReferenceLoaderController`에 남길 역할

분리 후 Controller는 다음 연결만 담당한다.

- ComfyUI node/widget lifecycle
- `LoaderStore` 생성과 복원
- Media runtime과 preview lifecycle
- `H3TimelineSession` 생성·reset·destroy
- React action을 Timeline session에 전달
- Timeline session의 변경을 view snapshot/render에 반영
- Prompt와 Timeline 사이의 최소 bridge

Controller에 Timeline의 세부 규칙이 다시 들어오지 않도록 한다. 예를 들어 frame 범위 계산, Guide ownership, draft merge 같은 로직은 session 또는 기존 H3 helper 안에 있어야 한다.

## 단계적 이행

### 1단계: 순수 로직과 세션 상태 확인

- `H3EditorState`와 H3 private field를 분류한다.
- `h3-media-guides.ts`, `h3-timeline.ts`에 이미 있는 로직은 재사용한다.
- Controller의 H3 메서드 중 DOM/ComfyUI 의존 부분과 순수 부분을 구분한다.

### 2단계: `H3TimelineSession` 추출

- Timeline draft와 session 상태를 새 모듈로 이동한다.
- Controller는 좁은 host capability만 제공한다.
- 기존 `LoaderStore` action과 validation 호출은 그대로 사용한다.

### 3단계: action wiring 축소

- `loader.ts:354-390`의 H3 action callback을 session 메서드에 연결한다.
- `H3WorkspaceReact`의 props와 action 이름은 가능한 한 유지한다.
- React view가 Controller private method를 직접 알지 않도록 한다.

### 4단계: lifecycle 검증

다음 경로에서 session이 남아 있거나 stale draft를 저장하지 않는지 확인한다.

- Timeline 열기 → 입력 → Apply
- Timeline 열기 → 입력 → Cancel
- Guide drag/drop → Cancel
- Guide 편집 중 Media 삭제
- workflow restore
- Clear → Undo
- node 제거
- Prompt Shot draft가 dirty인 상태에서 Timeline 전환

### 5단계: 기존 코드 삭제

추출이 동작한 뒤 Controller의 중복 H3 field, 중복 validation, 중복 transition 코드를 삭제한다. 기존 코드를 남겨둔 채 새 coordinator를 우회 경로로만 사용하지 않는다.

## 완료 조건

- Controller가 `H3EditorState`를 직접 소유하지 않는다.
- Controller에 Guide frame/draft merge의 세부 구현이 남지 않는다.
- Timeline은 별도의 canonical state나 history를 만들지 않는다.
- Apply/Cancel의 의미가 기존 동작과 동일하다.
- Media add/remove/reorder와 Timeline edit이 서로의 state를 손상시키지 않는다.
- React view는 snapshot을 렌더링하고 typed command만 호출한다.
- restore, clear, destroy 후 Timeline session이 stale callback을 실행하지 않는다.
- 새 Timeline 테스트가 Controller 내부 구현이 아닌 session 명령과 공개 결과를 검증한다.

## 하지 않을 것

- 일반적인 `FeatureController`/`ServiceContainer` 만들기
- Timeline 전용 Redux나 별도 external state library 추가
- Media state와 H3 Timeline state를 하나의 새 모델로 통합
- Prompt editor 전체를 이번 작업에 포함
- ComfyUI node lifecycle을 Timeline 모듈로 이동
- H3 Studio 전체를 새 route/modal/application으로 확장
- 복원 호환성을 이유로 두 개의 canonical state를 영구 유지

## 판단 기준

분리 후에도 코드가 많을 수는 있다. 목표는 총 LOC를 즉시 줄이는 것이 아니라, 기능 하나를 수정할 때 변경 범위를 다음처럼 제한하는 것이다.

```text
Timeline 규칙 변경
  -> H3TimelineSession
  -> 필요한 H3 helper/test

Media 규칙 변경
  -> LoaderStore/reducer 또는 Media runtime

ComfyUI widget 변경
  -> extension/controller bridge
```

Timeline 변경이 매번 Media runtime, Prompt controller, ComfyUI extension, React root까지 모두 건드린다면 분리 경계가 아직 충분히 좁지 않은 것이다.
