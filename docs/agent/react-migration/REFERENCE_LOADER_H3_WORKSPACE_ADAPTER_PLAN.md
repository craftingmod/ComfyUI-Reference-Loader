# Reference Loader H3 Workspace Adapter 분리 계획

작성 기준: 2026-09-14  
선행 문서:

- [Timeline Controller 경계](./REFERENCE_LOADER_TIMELINE_CONTROLLER_BOUNDARY.md)
- [Controller 분리 로드맵](./REFERENCE_LOADER_CONTROLLER_DECOMPOSITION_ROADMAP.md)
- [Preview Surface 분리 계획](./REFERENCE_LOADER_PREVIEW_SURFACE_DECOMPOSITION_PLAN.md)

## 1. 목적

`H3TimelineSession`이 Timeline draft와 명령을 소유하고,
`PreviewSurfaceBridge`가 native preview effect를 소유하게 된 뒤에도
`ReferenceLoaderController`에는 H3 workspace 전용 DOM orchestration이 남아 있다.

이번 계획의 목표는 다음 H3 UI effect를 `H3WorkspaceBridge`로 분리하는 것이다.

- Timeline 명령 결과에 따른 render 및 focus 정책
- H3 editor/workspace/timeline marker/shot의 focus 복구
- H3 draft field를 재렌더링 뒤 유지하는 focus-preserving render
- H3 workspace가 사용할 interaction root 조회

이 분리는 H3 canonical state나 React mount lifecycle을 옮기는 작업이 아니다.
`H3TimelineSession`은 계속 draft와 Timeline 명령을 소유하고,
`LoaderViewBridge`는 계속 React root의 mount/update/destroy를 소유한다.

## 2. 현재 상태와 판단

현재 구조는 다음과 같다.

```text
ReferenceLoaderController
  ├─ LoaderStore
  ├─ MediaRuntimeCoordinator
  ├─ PreviewSurfaceBridge
  ├─ H3TimelineSession
  │    ├─ draft / selection / Apply / Cancel
  │    └─ requestRender(force, focus) -> Controller
  └─ LoaderViewBridge
       ├─ Media React root
       ├─ H3WorkspaceReact mount
       └─ interactionRoot
```

현재 H3 전용 orchestration은 [loader.ts:798-917](../frontend/src/reference-loader/components/loader.ts)에 모여 있다.

| 현재 위치 | 책임 | 다음 처리 |
| --- | --- | --- |
| `loader.ts:298-311` | Timeline session host wiring | `H3WorkspaceBridge`의 render/focus callback으로 연결 |
| `loader.ts:798-809` | H3 Guide drag source 검증 | 1차에서는 Controller host callback으로 유지 |
| `loader.ts:811-862` | focus 종류별 render/focus 정책 | `H3WorkspaceBridge`로 이동 |
| `loader.ts:864-884` | editor/workspace focus helper | `H3WorkspaceBridge`로 이동 |
| `loader.ts:886-917` | draft field focus 보존 render | `H3WorkspaceBridge`로 이동 |
| `view-bridge.ts:117-136` | H3 React mount lifecycle | `LoaderViewBridge`에 유지 |
| `h3-timeline-session.ts` | draft, validation, command, Apply/Cancel | `H3TimelineSession`에 유지 |

### 현재 문제

`H3TimelineSession`은 UI focus 동작을 직접 구현하지 않지만
`requestRender()`를 Controller의 H3 private method에 의존한다.
그 결과 Timeline 규칙 변경이 다음 경계를 동시에 건드릴 가능성이 있다.

```text
H3TimelineSession
  -> ReferenceLoaderController private focus helpers
  -> LoaderViewBridge interactionRoot
  -> React DOM selector
```

이것은 Media canonical state의 문제는 아니며, H3 workspace의 native DOM effect와
React view mount 경계가 Controller에 함께 남아 있는 문제다.

## 3. 목표 구조

```text
ReferenceLoaderController
  ├─ LoaderStore                 canonical Media/H3 state and history
  ├─ MediaRuntimeCoordinator     metadata/proxy/waveform/upload runtime
  ├─ PreviewSurfaceBridge        audio/video native preview effect
  ├─ H3TimelineSession           H3 draft and commands
  ├─ H3WorkspaceBridge           H3 focus/render/DOM effect
  └─ LoaderViewBridge            generic snapshot and React mount lifecycle
       ├─ Media React root
       └─ H3WorkspaceReact mount
```

명령 흐름은 다음과 같다.

```text
H3TimelineSession command
        |
        +-- canonical change 없음 --------------------+
        |                                             |
        +-- requestRender(force, focus) --------------> H3WorkspaceBridge
                                                      |
                                                      +-- Controller render()
                                                      +-- interactionRoot 조회
                                                      +-- H3 focus/scroll 복구
```

`H3WorkspaceBridge`는 view snapshot을 만들거나 React component를 직접 렌더링하지
않는다. `LoaderViewBridge`가 제공하는 interaction root와 Controller의 render
callback을 사용해 H3 workspace의 DOM effect만 수행한다.

## 4. 책임 경계

### 4.1 `H3WorkspaceBridge`가 소유할 것

- `H3TimelineFocus`에 따른 render/focus 정책
- `editor-guide`, `workspace`, `timeline-guide`, `timeline-shot`,
  `source-control` focus 처리
- `preserve-editor-focus` 경로의 active input/select 정보 보존
- H3 editor row와 timeline marker의 scroll/focus 처리
- H3 workspace가 사용할 interaction root 조회 adapter
- bridge 자체의 idempotent `destroy()`와 destroyed guard

### 4.2 `H3WorkspaceBridge`가 소유하지 않을 것

- `LoaderState`, `H3TimelineState`, `H3WorkspaceView`의 canonical 저장
- H3 draft, selection, dirty 상태, validation
- Apply/Cancel 또는 LoaderStore dispatch
- history, graph transaction, serialization
- React root 생성, `createRoot`, `root.unmount()`
- Preview player, waveform, media runtime
- Prompt document와 Prompt history
- ComfyUI node/widget lifecycle
- 일반 Media card의 focus와 drag/drop

### 4.3 `ReferenceLoaderController`에 남길 것

- `H3TimelineSession` 생성, reset, destroy
- session host의 `getState`, `dispatch`, status, prompt shot bridge
- canonical state 변경과 graph transaction
- `render()` 및 `LoaderViewBridge` 호출
- public `mountH3Workspace()` facade
- H3 Guide drag source의 Media identity 검증

H3 Guide drag source는 첫 단계에서 Controller에 남긴다. 동일한
`application/x-reference-loader-item` payload를 Media React surface도 사용하므로,
drag payload 공용 모듈 추출을 이번 분리에 섞지 않는다.

## 5. 최소 Host 계약

새 bridge가 전체 Controller를 받지 않도록 다음 read/effect만 전달한다.

```ts
interface H3WorkspaceHost {
  getRoot(): HTMLElement
  getInteractionRoot(): HTMLElement | undefined
  isDestroyed(): boolean
  render(force?: boolean): void
}
```

필요한 경우 `getInteractionRoot()`는 `LoaderViewBridge.interactionRoot`를 그대로
반환한다. `H3WorkspaceBridge`는 `LoaderViewBridge` 또는 `H3TimelineSession` 자체를
받지 않는다.

권장 public surface는 다음과 같다.

```ts
class H3WorkspaceBridge {
  constructor(host: H3WorkspaceHost)
  requestRender(force?: boolean, focus?: H3TimelineFocus): void
  destroy(): void
}
```

`requestRender()`는 Controller의 public API가 아니다. `H3TimelineSession` host의
`requestRender` callback을 연결하기 위한 내부 adapter 경계다.

## 6. Focus 계약

기존 `H3TimelineFocus` union을 변경하지 않는다.

| focus kind | 대상 | 기존 동작 보존 조건 |
| --- | --- | --- |
| `preserve-editor-focus` | 현재 H3 input/select | field와 guide ID가 같으면 같은 DOM control에 focus |
| `editor-guide` | Guide editor row의 frame input | row scroll 후 frame field focus |
| `workspace` | H3 workspace collapse button | workspace scroll 후 collapse button focus |
| `timeline-guide` | Guide marker 또는 placement fallback | marker 우선, 없으면 placement button |
| `timeline-shot` | Shot marker | `scroll`가 true일 때만 nearest scroll |
| `source-control` | Media card의 H3 toggle/edit button | `:audio` parent ID와 channel을 정확히 해석 |

Focus target이 존재하지 않는 경우 예외를 발생시키지 않고 조용히 종료한다.
재렌더링 직후 아직 DOM이 존재하지 않는 상태에서 stale callback이 도착해도
Controller나 session state를 변경하지 않는다.

## 7. 단계적 이행

### 0단계: 현재 동작과 selector 계약 고정

새 파일을 추가하기 전에 다음을 테스트로 고정한다.

- `H3TimelineFocus` 각 kind의 focus target
- Guide marker가 없을 때 placement button fallback
- `preserve-editor-focus`의 field/guide ID 복구
- `timeline-shot.scroll`의 true/false 차이
- source-control에서 `videoId:audio`가 부모 video card로 해석되는지
- interaction root가 없을 때 root fallback
- destroyed 상태에서 늦은 render/focus callback이 무시되는지

이 단계에서는 Controller 구현을 변경하지 않는다.

### 1단계: `H3WorkspaceBridge` 추가

새 파일:

```text
frontend/src/reference-loader/h3-workspace-bridge.ts
```

이동할 로직:

- `#requestH3Render`
- `#focusH3EditorGuide`
- `#focusH3Workspace`
- `#renderH3PreservingFocus`

이동하지 않을 로직:

- `H3TimelineSession`의 draft/command/validation
- `#h3GuideDragSource`
- `LoaderViewBridge.mountH3Workspace()`
- `ReferenceLoaderController.mountH3Workspace()` public facade

bridge는 `document.activeElement`를 읽을 수 있지만, focus 정보를 별도 state로
저장하지 않는다. 한 번의 `requestRender()` 호출 안에서 현재 field를 읽고,
render 후 다시 찾는다.

### 2단계: Controller wiring 변경

Controller에는 다음 field와 host wiring만 추가한다.

```ts
#h3Workspace!: H3WorkspaceBridge
```

Timeline session host 변경:

```ts
requestRender: (force, focus) => this.#h3Workspace.requestRender(force, focus)
```

bridge host 구현:

```ts
{
  getRoot: () => this.root,
  getInteractionRoot: () => this.#viewBridge.interactionRoot,
  isDestroyed: () => this.#destroyed,
  render: (force) => this.render(force),
}
```

생성 순서는 다음을 지킨다.

1. `LoaderStore` 생성
2. `H3TimelineSession` 생성
3. `LoaderViewBridge` 생성
4. `H3WorkspaceBridge` 생성
5. restored runtime hydrate 및 첫 render

`LoaderViewBridge`가 생성되기 전에 H3 bridge가 interaction root를 읽지 않도록
한다. constructor 중 callback이 즉시 실행될 수 있으므로 초기화 순서를 테스트로
고정한다.

### 3단계: H3 drag source 경계 재평가

1차에서는 `#h3GuideDragSource`를 Controller에 유지한다. 다음 조건을 모두
만족할 때만 별도 이동을 검토한다.

- Media React surface와 H3 workspace가 공유하는 drag payload parser가 하나로
  정리된다.
- `DRAG_MIME`, scope, channel, item capability 검증의 owner가 명확하다.
- `loader-react.tsx`의 일반 reorder/drop 동작이 영향을 받지 않는다.
- H3 workspace bridge가 LoaderState를 복제하지 않는다.

조건을 만족하지 않으면 drag source는 Controller host callback으로 유지한다.

### 4단계: 기존 책임 제거

다음 검색 결과가 0이 되어야 한다.

```text
loader.ts:
  #requestH3Render
  #focusH3EditorGuide
  #focusH3Workspace
  #renderH3PreservingFocus
```

Controller에는 `H3WorkspaceBridge` 호출과 H3 session lifecycle만 남긴다.
기존 private method를 남겨두고 새 bridge를 우회 경로로 사용하는 형태는 완료로
보지 않는다.

## 8. 검증 계획

### 8.1 Unit/DOM 자동 검증

기존 `frontend/test/reference-loader-timeline.test.ts` 또는 새
`frontend/test/reference-loader-h3-workspace-bridge.test.ts`에 다음을 추가한다.

#### Render/focus

- 각 `H3TimelineFocus`가 기존 target을 선택한다.
- missing marker가 placement fallback으로 내려간다.
- editor guide row가 scroll되고 frame field가 focus된다.
- workspace focus가 collapse button에 도착한다.
- draft field focus가 render 이후 유지된다.
- `timeline-shot.scroll`이 false면 불필요한 scroll을 호출하지 않는다.
- `source-control`이 video-derived audio ID를 부모 ID로 변환한다.

#### Lifecycle

- `destroy()`를 반복 호출해도 예외가 없다.
- destroy 후 `requestRender()`가 render, focus, scroll을 호출하지 않는다.
- restore, clear, node removal 뒤 stale focus callback이 state를 변경하지 않는다.
- 두 Loader instance의 interaction root와 focus target이 서로 섞이지 않는다.

#### Canonical boundary

- focus-preserving render가 Loader serialization을 변경하지 않는다.
- focus 복구만으로 history entry나 graph transaction이 생성되지 않는다.
- Timeline Apply/Cancel 동작과 session dirty semantics가 그대로 유지된다.
- Guide drop의 foreign scope, unsupported channel, video source rejection이 유지된다.

### 8.2 기존 검증

- `bun run typecheck`
- `bun run test:frontend`
- `bun run test:backend`
- `bun run test:unit`
- `bun run lint`
- 변경 파일 Oxfmt check
- `bun run build`
- `git diff --check`

Windows uv/Ruff cache 오류가 발생하면 repository-local cache/temp 또는
`UV_NO_CACHE=1` 경로를 사용하되, 환경 오류와 source/test 오류를 구분해 기록한다.

### 8.3 실제 ComfyUI 검증

자동 fixture 통과만으로 H3 workspace 분리 완료를 판단하지 않는다.

- Nodes 2.0에서 Timeline widget mount/update/destroy
- Legacy Canvas에서 Timeline widget mount/update/destroy
- Guide editor input과 frame focus 유지
- Guide drag/drop과 foreign Loader scope rejection
- Apply/Cancel 및 Media 삭제/교체 중 session reset
- workflow restore와 clear 후 focus target 잔여 여부
- Prompt Shot draft dirty 상태에서 Timeline 전환
- node removal 후 React root, interaction root, listener 잔여 여부
- 두 Loader node instance 사이 focus와 drag scope 격리

실제 검증 결과는 자동 테스트 결과와 별도로 기록한다.

## 9. 완료 조건

다음 조건을 모두 만족할 때 이 분리를 완료로 판단한다.

1. Controller가 H3 focus/render private 구현을 직접 소유하지 않는다.
2. `H3WorkspaceBridge`가 LoaderState, H3 draft, history를 복제하지 않는다.
3. `H3TimelineSession`의 draft/Apply/Cancel/validation owner가 변경되지 않는다.
4. `LoaderViewBridge`가 React mount/update/destroy owner로 남는다.
5. 기존 `H3TimelineFocus` 종류와 focus fallback semantics가 유지된다.
6. focus 복구와 render scheduling이 serialization/history/graph dirty를 변경하지 않는다.
7. restore, clear, destroy 이후 stale H3 callback과 DOM listener가 남지 않는다.
8. 두 Loader instance가 서로의 workspace root, focus, drag scope를 사용하지 않는다.
9. Controller public API와 `mountH3Workspace()` 계약이 유지된다.
10. 자동 검증과 실제 ComfyUI 검증 결과가 별도로 기록된다.

## 10. 다음 단계와 분리하지 않을 것

이 계획 다음의 후보는 Media editor orchestration이다. 다만 H3 workspace adapter와
동시에 진행하지 않는다.

```text
H3 workspace focus/render 변경
  -> H3WorkspaceBridge
  -> H3 workspace bridge test

H3 draft/validation 변경
  -> H3TimelineSession
  -> Timeline session test

Media editor API/Promise 변경
  -> 별도 MediaEditorCoordinator 계획
  -> editor/controller integration test
```

이번 작업에서는 다음을 하지 않는다.

- `H3WorkspaceStore` 또는 두 번째 Timeline state 추가
- H3 React component 전체 재작성
- `LoaderViewBridge` 전체 재분리
- drag payload 공용화와 H3 adapter를 한 PR에 결합
- Prompt controller 재분해
- ComfyUI lifecycle bridge 재분해
- PreviewSurfaceBridge와 H3 workspace adapter를 한 PR에 결합
- Controller 이름 변경 또는 cosmetic refactor

목표는 `loader.ts`의 LOC를 줄이는 것이 아니라, H3 focus/render effect를 변경할 때
Timeline canonical state, Media runtime, Preview surface, ComfyUI lifecycle까지
동시에 수정하지 않아도 되는 경계를 만드는 것이다.
