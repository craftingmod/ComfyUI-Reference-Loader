# H3 Video Output 설정 구현 계획

상태: 계획만 작성. 이 문서는 코드 변경이나 Image/Audio 출력 지원을 의미하지 않는다.

## 1. 목표

Reference Loader의 H3 출력 설정에 `Width`와 `Height`를 추가하고, 별도의 native widget을 늘리지 않은 채 React H3 workspace에서 DaSiWa와 유사한 preset UI로 편집한다.

현재 실제 생성 결과는 Video뿐이다. 따라서 이번 단계에서는 Image와 Audio를 실제 출력 모드로 모델링하지 않는다. Image/Audio에 대응하는 최소값을 가짜 상태로 저장하지도 않는다.

목표 상태는 다음과 같다.

```text
React H3 Output picker
  -> LoaderStore / loader_state.h3Output
  -> backend validation
  -> execution fingerprint / manifest
  -> ReferenceLoaderBundle
  -> MiniMax H3 Wrapper
```

## 2. 현재 경계

- `H3OutputSettings`는 현재 `fps`와 `total_frames`를 소유한다.
- `Reference Loader`는 `h3Output`을 loader state와 manifest에 포함한다.
- Bundle은 `h3_fps`와 `h3_total_frames`를 Wrapper로 전달한다.
- MiniMax H3 Wrapper는 현재 native `width`, `height`, `ref_image_size`를 별도로 받는다.
- H3 Timeline은 출력 시간축과 Guide 위치를 편집하지만, 영상 생성 자체를 구현하지 않는다.

이번 변경에서 `width`와 `height`는 원본 reference 미디어의 크기가 아니라 생성되는 H3 Video의 출력 크기다.

## 3. 1단계 계약

### 3.1 Backend / frontend state

기존 H3 출력 계약을 다음처럼 확장한다.

```ts
interface H3OutputSettings {
  fps: number
  totalFrames: number
  width: number
  height: number
}
```

기본값은 현재 Wrapper의 기본값을 유지한다.

```text
width  = 1344
height = 768
fps    = 24
```

기존 workflow에 `width` 또는 `height`가 없으면 위 기본값으로 복구한다. 잘못된 값은 backend 경계에서 거부하거나 현재 state 정규화 규칙에 따라 안전한 값으로 복구한다.

### 3.2 Image / Audio 상태는 추가하지 않음

이번 단계에는 다음 필드를 추가하지 않는다.

```ts
outputKind: "image" | "audio" | "video"
imageFrames: number
audioWidth: number
audioHeight: number
```

이 값들은 실제 Image/Audio 생성 경로가 생길 때 별도 설계한다. 현재 UI에서 Image/Audio 탭을 보여 주더라도 disabled 또는 향후 지원 placeholder로만 표시하며, 실행 계약과 fingerprint에는 넣지 않는다.

`Audio (32×32px)`는 일반 ComfyUI AUDIO의 속성이 아니다. Audio waveform은 시간축과 sample rate를 가지므로, 32×32가 audio latent grid라면 나중에 `audioLatentWidth`/`audioLatentHeight`처럼 별도 의미로 정의해야 한다. `32 frames` 또는 `32 kHz`를 뜻한다면 해당 단위를 명시한다.

### 3.3 Input Scaling

`ref_image_size`는 출력 해상도가 아니라 reference conditioning 입력의 scaling 정책이다. 1단계에서는 Wrapper의 기존 의미를 유지한다.

React Output picker에 함께 노출할 필요가 생기더라도, `h3Output.width`/`height`와 같은 출력 크기 필드에 섞지 않는다. 먼저 기존 Wrapper native 입력을 유지하고, 추후 별도 `inputScaling` 계약으로 옮길지 결정한다.

## 4. UI 계획

H3 Timeline 본문에 큰 설정 패널을 추가하지 않는다. H3 workspace header에 compact summary button을 추가하고, 선택 시 overlay popover를 연다.

```text
H3 Timeline Guides       [Video Output: 16:9 · 1344×768 · 124f · 24fps ▾]
```

Popover의 1단계 구성:

- Aspect preset: `16:9`, `1:1`, `9:16` 등 실제 지원 preset
- Resolution preset: 선택한 aspect에 맞는 width/height preset
- `Custom`: width와 height 직접 입력

Aspect와 Resolution을 독립적으로 저장하지 않는다. 선택 결과는 최종 `width`와 `height`로 변환하고, UI의 preset label은 현재 width/height에서 다시 계산한다.

```text
preset 선택 -> width/height 계산 -> h3Output 저장
Custom 입력 -> width/height 검증 -> h3Output 저장
```

1단계에서는 기존 `h3_total_frames`와 `h3_fps` native widget을 유지할 수 있다. 이 경우 새 picker는 우선 width/height만 편집한다. Frames/FPS까지 React popover로 옮기려면 별도의 후속 migration으로 두 필드를 함께 옮겨야 하며, React와 native widget을 독립적인 source of truth로 유지하지 않는다.

## 5. 구현 단계

### Phase 0 — 계약 확정

- 실제 Video 출력 크기의 허용 범위를 확인한다.
- native MiniMax H3가 요구하는 width/height 규칙과 preset 목록을 확인한다.
- `Audio (32×32px)`가 실제로 무엇을 의미하는지 결정한다.
- 이번 단계에서는 `outputKind`를 추가하지 않는 것으로 고정한다.

완료 조건:

- Video 전용 설정이라는 범위가 문서와 테스트 이름에 명시된다.
- Image/Audio placeholder가 backend 실행 계약에 들어가지 않는다.

### Phase 1 — Backend 계약 확장

대상 파일:

- `backend/core/reference_contract.py`
- `backend/core/reference_manifest.py`
- `backend/nodes/reference_loader.py`
- `backend/nodes/reference_bundle.py`
- `backend/nodes/reference_loader_options_override.py`

작업:

1. `H3OutputSettings`에 `width`, `height`를 추가한다.
2. 기본값, 최소/최대값, 정수 여부를 검증한다.
3. state projection과 manifest projection에 값을 포함한다.
4. execution projection과 fingerprint에 값을 포함한다.
5. bundle에 `h3_width`, `h3_height`를 추가한다.
6. Options Override가 width/height를 보존한다.
7. 이전 state에 값이 없을 때 기본값으로 migration한다.

### Phase 2 — Wrapper 연결

대상 파일:

- `backend/nodes/minimax_h3_reference_wrapper.py`
- `tests/backend/test_minimax_h3_reference_wrapper.py`

작업:

1. Wrapper가 bundle의 `h3_width`, `h3_height`를 읽는다.
2. native H3 `execute()`에 bundle 값을 전달한다.
3. Wrapper에 남아 있는 editable width/height와 bundle 값이 충돌하지 않도록 한다.
4. 1단계에서 native width/height 입력을 유지한다면, 중복 값의 우선순위와 mismatch 오류를 명시한다.

권장 우선순위는 bundle 값이다. 최종 구조에서는 Wrapper의 editable width/height를 제거하고 `references`에서만 읽는다.

### Phase 3 — React picker

대상 파일:

- `frontend/src/reference-loader/types.ts`
- `frontend/src/reference-loader/validation.ts`
- `frontend/src/reference-loader/reducer.ts`
- `frontend/src/reference-loader/execution.ts`
- `frontend/src/reference-loader/components/h3-workspace-react.tsx`
- 관련 H3 workspace style 및 i18n 파일

작업:

1. `H3OutputSettings` 타입과 기본값을 확장한다.
2. width/height 검증과 Custom 입력을 추가한다.
3. preset 선택을 기존 Controller action으로 연결한다.
4. React local state를 canonical output state로 사용하지 않는다.
5. 변경 시 native loader state와 실행 fingerprint가 갱신되도록 한다.
6. header summary는 현재 width/height에서 파생한다.
7. popover는 layout height를 추가하지 않는 overlay로 구현한다.

### Phase 4 — 기존 widget과의 정리

1단계에서 기존 Frames/FPS native widget을 유지했다면, 이 단계는 선택 사항이다.

- React Output popover에서 Frames/FPS까지 편집할 필요가 있을 때만 진행한다.
- `h3_total_frames`, `h3_fps`를 loader state 기반으로 통합한다.
- native widget callback proxy와 중복 state를 제거한다.
- workflow serialization, Nodes 2.0, Legacy Canvas에서 동일한 값을 복원하는지 확인한다.

이 migration을 하지 않는다면 Frames/FPS는 현재 native widget에 남기고, React picker는 width/height만 담당한다.

## 6. 테스트 계획

### Backend

- 기존 state에 width/height가 없으면 `1344×768`로 복구한다.
- 유효한 width/height가 state, manifest, execution projection, bundle에서 동일하다.
- width 또는 height 변경 시 fingerprint가 달라진다.
- 잘못된 타입, 범위 밖 값, 비정수 값이 거부된다.
- Options Override가 width/height를 잃지 않는다.
- Wrapper가 bundle의 width/height를 native H3에 전달한다.
- bundle과 manifest의 H3 출력 설정이 다르면 오류가 난다.

### Frontend

- aspect preset이 올바른 width/height로 변환된다.
- resolution preset이 선택된 aspect와 일치한다.
- Custom 입력이 정수·범위·허용 규칙을 따른다.
- 저장/복원 후 선택 결과가 유지된다.
- Snapshot/Undo/Redo에서 width/height가 canonical state와 함께 복원된다.
- React picker가 별도의 Image/Audio 실행 상태를 만들지 않는다.
- 기존 Frames/FPS native widget을 유지하는 경우 callback proxy와 값이 일치한다.

### Live ComfyUI

자동 테스트와 별도로 Nodes 2.0과 Legacy Canvas에서 다음을 확인한다.

- H3 workspace header와 popover가 노드 높이를 불필요하게 늘리지 않는다.
- Timeline이 접혀도 Output 설정 진입점이 남는다.
- 좁은 노드 폭에서 popover가 잘리지 않거나 접근 가능한 대체 경로가 있다.
- workflow 저장/재로드 후 width/height가 유지된다.
- 동일한 output 설정이 실제 native H3 실행까지 전달된다.

## 7. 향후 Image / Audio 지원 시점

실제 Image 또는 Audio 생성 경로가 추가될 때만 `OutputSpec` discriminated union을 도입한다.

```ts
type OutputSpec =
  | { kind: "image"; frames: 5; width: number; height: number }
  | { kind: "audio"; sampleRate: number; /* audio-specific fields */ }
  | { kind: "video"; width: number; height: number; frames: number; fps: number }
```

그때는 다음을 별도로 결정한다.

- ComfyUI `IMAGE` batch의 5프레임 의미
- ComfyUI `AUDIO` waveform의 sample rate와 duration
- ComfyUI `VIDEO` 값의 실제 materialization 경계
- format별 Wrapper 또는 출력 노드 분리 여부
- format 변경이 reference bundle을 바꾸는지, 생성 설정만 바꾸는지

그 전까지는 Image/Audio를 최소값으로 저장하는 placeholder 계약을 만들지 않는다.

## 8. 최소 구현 결론

첫 PR의 범위는 다음으로 제한한다.

1. Video 전용 `h3Output.width`/`height` 추가
2. 기존 `loader_state`와 bundle에 값 전달
3. H3 workspace header의 compact preset picker
4. Wrapper가 bundle width/height 사용
5. Image/Audio 실제 mode와 native widget 추가는 하지 않음

이 범위는 현재 출력이 Video뿐이라는 사실을 반영하면서도, 나중에 실제 Image/Audio 출력을 추가할 수 있는 확장 지점을 남긴다.
