# Reference Loader Preview Surface 분리 계획

작성 기준: 2026-09-14  
선행 문서: [Controller 분리 로드맵](./REFERENCE_LOADER_CONTROLLER_DECOMPOSITION_ROADMAP.md)

## 1. 목적

M3에서 ComfyUI node/widget lifecycle을 `ComfyUILifecycleBridge`로 분리한 뒤에도
`ReferenceLoaderController`에는 native preview 효과와 DOM 동기화가 남아 있다.

이 문서의 목표는 다음 네 가지를 `PreviewSurfaceBridge`로 분리하는 것이다.

- audio/video preview player lifecycle
- waveform canvas drawing
- playback button과 video element의 DOM 동기화
- preview 관련 ResizeObserver와 player subscription

이 분리는 Loader의 canonical state를 옮기는 작업이 아니다. `LoaderStore`가 계속
Media state, history, reducer, graph transaction을 소유하고,
`MediaRuntimeCoordinator`가 metadata/proxy/waveform 결과를 소유한다.

## 2. 현재 판단

현재 `loader.ts`는 runtime data와 native preview surface를 다음처럼 함께 조정한다.

```text
MediaRuntimeCoordinator
  └─ ItemRuntime.waveform / metadata / previewUrl
             |
             v
ReferenceLoaderController
  ├─ AudioPreviewPlayer / VideoPreviewPlayer
  ├─ waveform ResizeObserver와 canvas drawing
  ├─ playback button DOM update
  ├─ active video element를 card에 attach/detach
  ├─ preview 시작/중지와 editor playback 연결
  └─ LoaderStore commit, render, graph dirty
```

이는 기능적으로 동작하지만, 한 사용자 동작이 canonical state와 native effect를
동시에 건드리는 지점이 많다.

현재 분리 대상은 다음과 같다.

| 현재 위치 | 책임 | 판단 |
| --- | --- | --- |
| `loader.ts:280-288` | player, ResizeObserver, preview 지연 상태 | Preview surface 후보 |
| `loader.ts:329-338` | waveform observer 설치 | Preview surface로 이동 |
| `loader.ts:387-388` | player subscription | Preview surface로 이동 |
| `loader.ts:961-1027` | waveform 및 playback DOM 동기화 | Preview surface로 이동 |
| `loader.ts:1062-1125` | grid audio/video preview 명령 | Preview surface로 이동 |
| `loader.ts:484-485`, `1043-1044`, `1261-1262`, `1283-1284` | state 변화 전 preview 중지 | Loader가 bridge 명령 호출 |
| `loader.ts:1415-1426` | trim editor의 audio playback 연결 | 좁은 player capability로 유지 |
| `loader.ts:1504` | video audio toggle 후 mute 반영 | Loader commit 후 bridge 호출 |

## 3. 목표 구조

```text
ReferenceLoaderController
  ├─ LoaderStore                 canonical state/history
  ├─ MediaRuntimeCoordinator     async runtime data
  ├─ LoaderViewBridge             React snapshot/mount/update
  ├─ H3TimelineSession            Timeline draft/commands
  └─ PreviewSurfaceBridge         native preview effect/lifecycle
       ├─ AudioPreviewPlayer
       ├─ VideoPreviewPlayer
       ├─ waveform canvas
       ├─ playback DOM
       └─ ResizeObserver/subscriptions
```

`ReferenceLoaderController`는 여전히 외부에서 사용하는 facade로 남는다. 다음
메서드의 public contract는 바꾸지 않는다.

```text
previewAudio(id)
previewVideo(id)
editItem(id, channel?)
removeItem(id)
clear()
restore(serialized)
destroy()
```

각 메서드는 canonical commit 또는 외부 API를 직접 수행한 뒤 Preview bridge에
필요한 effect를 명시적으로 전달한다.

## 4. 책임 경계

### 4.1 `PreviewSurfaceBridge`가 소유할 것

- `AudioPreviewPlayer`와 `VideoPreviewPlayer` 인스턴스
- player 상태 subscription과 DOM 동기화
- waveform canvas의 크기 계산 및 drawing
- root에 설치하는 `ResizeObserver`
- 현재 재생 중인 video element의 card host 이동
- poster 숨김/복구와 playback button의 label, title, class 변경
- grid audio/video preview의 시작, 중지, toggle
- item 제거, 교체, clear, restore, destroy 시 preview 중지
- trim editor에 전달할 audio playback capability
- Preview bridge 자체의 idempotent `destroy()`

### 4.2 `ReferenceLoaderController`에 남길 것

- `LoaderStore` 생성, dispatch, restore, serialize
- undo/redo와 graph transaction
- upload/edit 결과의 canonical Media commit
- `MediaRuntimeCoordinator` 호출 및 runtime data 전달
- H3 Timeline과 Prompt reference projection 조정
- React snapshot 조합과 render 요청
- ComfyUI display property와 dirty callback
- Preview bridge를 호출하는 action facade

### 4.3 Preview bridge가 소유하지 않을 것

- `LoaderState` 또는 별도의 Media state 복제
- history/undo stack 또는 reducer
- `MediaRuntimeCoordinator`의 runtime map, sequence, epoch
- upload, metadata, proxy, waveform API 호출
- serialization/restore 포맷
- Prompt document, Prompt history, Prompt controller
- H3 Timeline draft
- graph transaction 또는 `setDirtyCanvas`
- ComfyUI node/widget 등록 및 `onRemoved` hook
- React root 또는 `LoaderViewBridge`의 mount lifecycle

## 5. 최소 host 계약

새 bridge가 전체 `ReferenceLoaderController`를 받지 않도록 한다. 필요한 read와
effect callback만 좁은 host 계약으로 전달한다.

개념적인 계약은 다음과 같다.

```ts
interface PreviewSurfaceHost {
  getRoot(): HTMLElement
  getItem(id: string): MediaItem | undefined
  getRuntime(id: string): ItemRuntime | undefined
  getAudioPreviewUrl(item: MediaItem): string
  getVideoPreviewUrl(item: MediaItem): string
  isDestroyed(): boolean
  setStatus(message: string): void
  requestRender(): void
  requestScheduledRender(): void
}
```

실제 구현에서는 현재 `ReferenceLoaderApi`, `LoaderState`,
`MediaRuntimeCoordinator.getRuntime()`를 재사용한다. bridge가 `LoaderStore`나
runtime coordinator 자체를 받지 않도록 한다.

editor가 기존 audio player를 계속 사용해야 하므로, 내부적으로만 사용할 수 있는
다음 capability는 허용한다.

```text
getAudioEditorPlayback(): AudioPreviewPlayer
```

이 capability는 Controller의 새 public API가 아니다. `openTrimEditor()`의
Promise 계약과 `editor:<id>` owner semantics를 보존하기 위한 adapter 경계다.

## 6. 상태 및 effect 흐름

### Preview 시작

```text
React action: previewAudio(id)
        |
        v
ReferenceLoaderController.previewAudio(id)
        |
        +-- item/runtime 유효성 확인
        +-- PreviewSurfaceBridge.toggleAudio(id)
        |     ├─ 다른 player 중지
        |     └─ 기존 URL/crop/metadata로 재생
        +-- player subscription -> playback DOM 동기화
        └-- 실패 시 host status + render
```

Preview 재생과 중지는 canonical state를 변경하지 않는다. 따라서 graph
transaction, history entry, serialization 결과를 만들지 않는다.

### State 변화에 따른 중지

```text
remove/replace/clear/restore/edit
        |
        +-- Loader가 canonical state/runtime를 정리
        └-- PreviewSurfaceBridge.stopForItem() 또는 stopAll()
```

item 제거 전에 해당 owner를 중지해야 한다. `restore`, `clear`, `destroy`는 전체
player와 video element를 정리한다.

### Runtime 결과와 waveform

```text
MediaRuntimeCoordinator
  └─ runtime update / scheduled render
          |
          v
LoaderViewBridge React commit
          |
          v
PreviewSurfaceBridge.syncAfterRender()
  ├─ waveform canvas draw
  └─ playback button/video DOM sync
```

Waveform 데이터는 runtime이 소유하고, canvas는 Preview bridge가 소유한다. 어느
쪽도 waveform을 Loader canonical state에 복사하지 않는다.

## 7. 단계적 이행

### 1단계: 현재 동작 고정

- preview 관련 호출자와 owner 문자열을 inventory한다.
- `grid:<id>`와 `editor:<id>` owner semantics를 테스트로 고정한다.
- preview 시작/중지가 serialization, history, graph dirty를 만들지 않는지 확인한다.
- video poster 복구와 waveform 재그리기 조건을 고정한다.

### 2단계: `PreviewSurfaceBridge` 추출

- player, subscription, ResizeObserver를 새 모듈로 이동한다.
- `#drawWaveforms`, `#syncPlaybackUi`, `#toggleAudioPreview`,
  `#toggleVideoPreview`의 동작을 옮긴다.
- Controller의 `previewAudio()`와 `previewVideo()`는 bridge delegation으로
  유지한다.
- Controller의 render callback은 `syncAfterRender()`를 호출한다.

### 3단계: caller 연결

- remove, replace, clear, restore, edit 경로의 직접적인 player 조작을
  `stopForItem()`/`stopAll()`로 바꾼다.
- `toggleVideoAudio()`는 Store dispatch 후 `setVideoMuted()`를 호출한다.
- trim editor는 bridge가 제공하는 audio playback capability를 사용한다.
- Preview 관련 `destroy` 순서를 bridge의 단일 cleanup으로 모은다.

### 4단계: preview 지연 상태 정리

`#deferPreviews`를 이동할지는 2단계 후 결정한다. 이동하는 경우에도 view snapshot에
boolean만 공개하고, Loader state나 runtime map에는 넣지 않는다.

다음 조건을 만족하지 못하면 이 상태는 Loader에 남긴다.

- caption focus 중 runtime preview update를 지연하는 의미가 Preview bridge에
  명확히 귀속된다.
- `flushDeferredPreviews()`와 기존 React snapshot 결과를 변경하지 않는다.
- 별도 상태 복제 없이 기존 focus 판정을 재사용할 수 있다.

### 5단계: 기존 책임 제거

- Loader의 player/observer/subscription field를 삭제한다.
- Loader에서 preview DOM query와 player 직접 호출을 삭제한다.
- old private method가 남아 있지 않은지 `rg`로 확인한다.
- Preview bridge가 canonical state를 변경하지 않는지 검토한다.

## 8. 검증 게이트

### 자동 검증

- preview audio/video toggle과 owner별 중지
- video audio toggle 후 mute 상태 동기화
- waveform canvas drawing과 ResizeObserver 재계산
- React commit 후 playback button/video poster 동기화
- remove, replace, clear, restore, edit, destroy cleanup
- 반복 `destroy()`가 예외와 잔여 listener를 만들지 않는지 확인
- editor audio playback의 `editor:<id>` owner 보존
- preview 조작이 `serialize()` 결과를 바꾸지 않는지 확인
- 기존 frontend tests, typecheck, lint, format, build
- `git diff --check`

### 실제 ComfyUI 검증

자동 fixture 통과만으로 실제 동작 완료를 판단하지 않는다.

- Nodes 2.0과 Legacy Canvas에서 mount/update/destroy
- audio/video preview 시작과 중지
- video poster 복구와 waveform DOM
- file drop, replacement, remove, clear, restore
- caption focus/IME 중 preview 지연 및 flush
- node removal 후 player, listener, video element 잔여 여부

## 9. 하지 않을 것

- `PreviewStore` 또는 두 번째 canonical Media state 추가
- 일반적인 `FeatureController`, event bus, service container 추가
- `MediaRuntimeCoordinator`를 Preview bridge로 합치기
- waveform을 React state로 매 frame 복사
- audio/video preview 포맷 또는 API 계약 변경
- editor canvas/player를 React로 전면 재작성
- `LoaderViewBridge` 전체를 다시 분리
- Prompt, Timeline, ComfyUI lifecycle 분리를 이 작업에 섞기
- preview 동작을 이유로 `LoaderState` serialization schema 변경

## 10. 완료 판단

다음 조건을 모두 만족할 때 이 분리를 완료로 판단한다.

1. `Loader`는 preview player와 native preview DOM의 lifecycle을 직접 소유하지
   않는다.
2. `PreviewSurfaceBridge`는 runtime 결과를 표시하지만 canonical state를
   저장하거나 dispatch하지 않는다.
3. preview 시작/중지가 history, graph transaction, serialization을 변경하지
   않는다.
4. remove, replace, clear, restore, destroy 이후 player, listener, video element,
   poster class가 남지 않는다.
5. 두 Loader instance의 player와 preview DOM이 서로 섞이지 않는다.
6. 기존 public Controller API와 editor Promise 계약이 유지된다.
7. 자동 검증 결과와 실제 ComfyUI 검증 결과를 별도로 기록한다.

이 단계가 끝나면 `Loader`는 canonical command orchestration과 cross-domain
projection에 집중한다. 다음 분리 후보인 H3 workspace adapter는 이 작업과 섞지
않고 별도 계획과 PR로 다룬다.
