# H3 Video Timing 패널 구현 계획

상태: 계획만 작성. 이 문서는 H3 Video의 FPS/Frame 설정 UI를 정의하며, 문서 작성 자체로 실행 계약이나 UI를 변경하지 않는다.

## 1. 목표

현재 H3 workspace header의 긴 `Video Output: ...` 요약을 출력 크기와 시간 설정으로 분리한다.

```text
Timeline Guides  [Output: 16:9 · 1344×768]  [Timing: 24 fps · 124 frames]
```

두 버튼은 같은 오른쪽 패널 영역을 공유한다. Output과 Timing 패널을 동시에 열어 Timeline 폭을 두 번 차지하지 않는다.

```text
[Output] [Timing]
       └── 하나의 shared panel slot
```

## 2. 현재 계약과 경계

- `H3OutputSettings`가 `fps`, `totalFrames`, `width`, `height`와 Output UI 선택값을 canonical state로 소유한다.
- `loader_state.h3Output`은 workflow 저장/복원, execution projection, manifest, bundle과 연결된다.
- `h3_fps`와 `h3_total_frames` native field는 기존 ComfyUI 노드 입력 및 callback proxy 경계를 유지한다.
- React Timing 패널은 별도의 FPS/Frame source of truth를 만들지 않는다.
- 패널이 열려 있는지와 어떤 패널이 활성화됐는지는 workspace의 presentation state이며 저장하지 않는다.

이번 변경에서 새로 저장할 필드는 없다. FPS와 Total Frames는 이미 존재하는 `H3OutputSettings` 값을 사용한다.

## 3. UI 구성

### 3.1 Header summary

기존의 하나의 긴 버튼을 다음 두 버튼으로 분리한다.

```text
Output: 16:9 · 1344×768
Timing: 24 fps · 124 frames
```

- Output summary는 현재 `mode`, `aspect`, `width`, `height`에서 파생한다.
- Timing summary는 `fps`, `totalFrames`에서 파생한다.
- 세부값은 버튼 `title`과 accessible label에도 포함한다.
- 좁은 폭에서는 버튼 내부 텍스트가 ellipsis될 수 있지만, `aria-label`에는 전체 값이 남아야 한다.

### 3.2 Shared panel slot

Workspace의 Timeline 오른쪽 공간에 하나의 패널만 표시한다.

```ts
type H3WorkspacePanel = "output" | "timing" | null
```

- 비활성 버튼을 클릭하면 해당 패널로 전환한다.
- 활성 버튼을 다시 클릭하면 패널을 닫는다.
- Output에서 Timing으로 전환해도 Output의 draft/canonical 값은 유지한다.
- 두 패널을 동시에 렌더링하지 않는다.
- 기존 inline right-side layout과 scroll ownership을 유지한다.

### 3.3 Video Output 패널

기존 Output 패널을 그대로 유지한다.

- Image ratio
- Aspect
- Manual
- Total MP
- Width/Height 정규화

Output 전용 구현은 `h3-output-panel.tsx`와 `h3-output.css`가 소유한다.

### 3.4 Video Timing 패널

새 컴포넌트:

```text
Video Timing

FPS
[ 24 ]

Total Frames
[ 124 ]

Duration
5.167s
```

- FPS: `H3_OUTPUT_MIN_FPS`부터 `H3_OUTPUT_MAX_FPS`까지 정수 입력
- Total Frames: `H3_OUTPUT_MIN_TOTAL_FRAMES`부터 `H3_OUTPUT_MAX_TOTAL_FRAMES`까지 정수 입력
- Duration: read-only derived value
- Duration 계산은 기존 Timeline 표시 규칙과 맞춰 `totalFrames / fps`를 사용한다.
- 입력 blur/commit 시 1회에 canonical state를 갱신한다.
- 잘못된 입력은 기존 reducer/validation 정규화 규칙을 사용한다.

## 4. State와 Native Field 연결

Timing 패널의 입력은 다음 경로를 사용한다.

```text
Timing input
  -> actions.h3SetOutput({ fps / totalFrames })
  -> loaderReducer
  -> state.h3Output
  -> native field proxy / serialization / execution
```

다음 방식은 사용하지 않는다.

- Timing 패널 내부에 별도의 FPS/Frame canonical state 생성
- React 값과 native widget 값을 서로 독립적으로 저장
- duration을 저장 필드로 추가
- panel open 상태를 workflow에 저장

Native widget이 여전히 노출되는 동안에도 callback proxy가 동일한 `h3Output` 값을 읽고 쓰도록 유지한다.

## 5. 컴포넌트와 스타일 구조

### 대상 파일

- `frontend/src/reference-loader/components/h3-workspace-react.tsx`
- `frontend/src/reference-loader/components/h3-output-panel.tsx`
- `frontend/src/reference-loader/components/h3-timing-panel.tsx` 신규
- `frontend/src/reference-loader/styles/h3-workspace.css`
- `frontend/src/reference-loader/styles/h3-output.css`
- `frontend/src/reference-loader/styles/h3-timing.css` 신규
- `frontend/src/reference-loader/styles/index.css`
- `frontend/src/reference-loader/types.ts`
- `frontend/src/reference-loader/reducer.ts`
- 관련 frontend/backend 테스트

### 책임

`h3-workspace-react.tsx`

- header summary 계산과 버튼 렌더링
- `activePanel` presentation state
- shared panel slot에 Output 또는 Timing 렌더링

`h3-output-panel.tsx`

- Image/Aspect/Manual output 설정
- width/height 및 Total MP commit

`h3-timing-panel.tsx`

- FPS/Total Frames 입력
- Duration 표시
- `h3SetOutput` callback 연결

`h3-workspace.css`

- Workspace shell, header, stage, Timeline/List, Inspector
- panel slot 배치 및 header 버튼 공통 레이아웃

`h3-output.css` / `h3-timing.css`

- 각 패널 내부 컨트롤과 필드 스타일

## 6. 구현 단계

### Phase 1 — Header 분리

1. 기존 긴 Output button을 Output summary와 Timing summary 두 버튼으로 나눈다.
2. summary의 width/height/fps/frame 값이 canonical snapshot에서 파생되는지 확인한다.
3. 각 버튼에 accessible label과 expanded 상태를 연결한다.

완료 조건:

- 좁은 Timeline 폭에서도 두 버튼이 서로 겹치지 않는다.
- 기존 Output 버튼을 사용하는 테스트와 action selector의 의미가 유지되거나 명확한 새 selector로 함께 갱신된다.

### Phase 2 — Shared panel slot

1. `outputOpen`을 `activePanel`로 확장한다.
2. Output과 Timing 중 하나만 오른쪽 slot에 렌더링한다.
3. 패널 전환 시 `.rl-h3-stage.is-output-open`의 layout 동작을 일반 panel-open 상태에 맞게 조정한다.
4. panel close와 header toggle의 focus/aria 동작을 확인한다.

### Phase 3 — Timing panel

1. `h3-timing-panel.tsx`를 추가한다.
2. FPS와 Total Frames를 정수 입력으로 제공한다.
3. commit 시 `actions.h3SetOutput`을 호출한다.
4. Duration을 read-only로 계산한다.
5. `h3-timing.css`를 추가하고 `styles/index.css`에서 import한다.

### Phase 4 — Native proxy와 복원 검증

1. Timing 입력 변경이 native `h3_fps`, `h3_total_frames` proxy 값에 반영되는지 확인한다.
2. native field 변경이 Timing panel과 header summary에 반영되는지 확인한다.
3. workflow serialization/restore 후 FPS와 Total Frames가 유지되는지 확인한다.
4. Undo/Redo와 snapshot restore에서 값이 일치하는지 확인한다.

## 7. 테스트 계획

### Frontend

- Header에 Output/Timing 두 버튼이 렌더링된다.
- Output과 Timing을 동시에 표시하지 않는다.
- Output 버튼 재클릭으로 shared panel이 닫힌다.
- Timing 버튼 클릭 시 Timing 패널이 열리고 Output 패널은 닫힌다.
- FPS 변경이 `state.h3Output.fps`를 갱신한다.
- Total Frames 변경이 `state.h3Output.totalFrames`를 갱신한다.
- Duration과 header summary가 변경된 canonical 값에 맞춰 갱신된다.
- native display proxy 변경 후 Timing 패널이 새 값을 표시한다.
- serialization/restore 후 FPS와 Total Frames가 유지된다.
- Output 설정의 Image/Aspect/Manual 상태가 Timing 패널 전환으로 손상되지 않는다.
- 좁은 폭에서 버튼과 패널이 overflow 없이 표시된다.

### Backend

- 기존 `h3Output.fps`와 `h3Output.totalFrames` validation을 유지한다.
- Timing 변경이 execution projection과 fingerprint에 반영된다.
- bundle과 manifest의 FPS/Total Frames가 일치한다.
- 잘못된 타입, 범위 밖 값, 비정수 값은 기존 계약에 따라 거부 또는 정규화된다.

## 8. 범위 제외

이번 변경에서는 다음을 추가하지 않는다.

- Audio 전용 timing 설정
- Video duration 별도 저장 필드
- frame rate와 duration을 동시에 독립 저장하는 계약
- Output과 Timing 패널의 동시 표시
- Image/Audio 실제 출력 모드

## 9. 최소 구현 결론

1. 긴 Video Output summary를 Output/Timing 두 버튼으로 분리한다.
2. 두 버튼은 하나의 right-side shared panel slot을 사용한다.
3. Output 패널은 기존 컴포넌트를 재사용한다.
4. Timing 패널은 FPS, Total Frames, derived Duration만 제공한다.
5. FPS와 Total Frames는 기존 `H3OutputSettings`와 native proxy를 계속 사용한다.
6. panel 선택 상태는 UI에만 존재하고 workflow에는 저장하지 않는다.
