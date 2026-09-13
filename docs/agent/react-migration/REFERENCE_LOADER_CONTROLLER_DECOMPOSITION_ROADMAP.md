# Reference Loader Controller 후속 분리 로드맵

작성 기준: 2026-09-14  
선행 문서: [Timeline Controller 경계](./REFERENCE_LOADER_TIMELINE_CONTROLLER_BOUNDARY.md)

## 1. 목적

`H3TimelineSession` 분리 이후 `ReferenceLoaderController`를 추가로 분해할 때의
순서와 소유권을 정의한다.

이 로드맵의 목표는 Controller의 파일 크기를 기계적으로 줄이는 것이 아니다.
상태 소유권과 lifecycle이 실제로 독립된 축을 순서대로 분리하여, 기능 변경의
영향 범위를 제한하는 것이 목표다.

새로운 전역 상태관리 시스템, 일반적인 `FeatureController`, `ServiceContainer`,
또는 Media state의 두 번째 canonical owner는 도입하지 않는다.

## 2. 현재 결론

Timeline은 이미 `H3TimelineSession`이 draft와 Timeline 명령을 소유하고,
Controller가 좁은 host 역할과 lifecycle 조정을 담당하는 구조로 분리되었다.

다음 분리 단위는 `MediaRuntimeCoordinator`가 적절하다. Media의 저장 상태를
옮기는 것이 아니라, 비동기 runtime 효과와 canonical state 반영을 분리한다.

```text
ReferenceLoaderController
├─ LoaderStore / canonical state       유지
├─ graph transaction / history         유지
├─ MediaRuntimeCoordinator             다음 분리
├─ View/Snapshot bridge                이후 분리
├─ ComfyUI lifecycle bridge            마지막 분리
└─ H3TimelineSession                   완료
```

## 3. 분리 원칙

### 3.1 파일 크기가 아니라 소유권을 기준으로 한다

메서드 이름이나 UI 화면별로 클래스를 나누지 않는다. 다음 질문에 모두 “예”라고
답할 수 있을 때만 독립 경계로 만든다.

- 독립적인 상태 또는 lifecycle이 있는가?
- 다른 기능이 아닌 하나의 명확한 owner를 지정할 수 있는가?
- 외부에 전달할 계약을 좁힐 수 있는가?
- canonical state와 history를 복제하지 않고 동작하는가?
- destroy, restore, stale async 결과를 독립적으로 검증할 수 있는가?

### 3.2 canonical state와 runtime 결과를 구분한다

다음 두 가지는 서로 다른 책임이다.

```text
MediaRuntime
  upload / metadata / proxy / waveform / preview 효과

LoaderStore + Controller
  MediaItem / 순서 / reference identity / history / graph transaction
```

Runtime이 업로드나 metadata 처리를 완료했다는 사실만으로 canonical state를
직접 변경하거나 history entry를 생성해서는 안 된다.

### 3.3 새 경계는 결과를 반환하고, 저장 결정은 상위에서 한다

권장 흐름은 다음과 같다.

```ts
const result = await mediaRuntime.upload(file)

if (result.ok) {
  controller.commitUploadedMedia(result.media)
}
```

`MediaRuntimeCoordinator`가 모든 Loader action을 임의로 dispatch하도록 만들면
Timeline 분리 이전의 결합이 다시 생긴다. runtime 결과와 canonical commit의
경계를 명시적으로 유지한다.

## 4. 단계별 로드맵

### M0 — Timeline 경계 안정화

새로운 Controller 분리 전에 Timeline session의 lifecycle과 transaction 경계를
고정한다.

#### 확인할 동작

- Timeline 열기 → 입력 → Apply
- Timeline 열기 → 입력 → Cancel
- Guide drag/drop → Cancel
- Guide 편집 중 Media 삭제 또는 교체
- workflow restore
- Clear → Undo
- node 제거 또는 Controller destroy
- Prompt Shot draft가 dirty인 상태에서 Timeline 전환
- destroy 또는 restore 이후 늦게 도착한 callback

#### 완료 기준

- Apply 전에는 canonical state, history, graph transaction이 변경되지 않는다.
- Cancel, clear, restore, destroy가 draft를 남기지 않는다.
- stale callback이 이후 state나 view를 변경하지 않는다.
- session 테스트가 Controller private 구현이 아니라 명령과 공개 결과를 검증한다.

이 단계가 통과되기 전에는 다음 분리를 동시에 진행하지 않는다.

### M1 — `MediaRuntimeCoordinator` 분리

#### 분리 목적

현재 Controller에 함께 들어 있는 비동기 media runtime lifecycle을 분리한다.
이 축은 Media의 canonical model보다 다음 요소들과 더 강하게 결합되어 있다.

- runtime cache
- upload pending 상태
- metadata/proxy/waveform 로딩
- sequence와 epoch를 이용한 stale 결과 차단
- concurrency limiter
- preview player lifecycle

#### 1차 이동 후보

현재 `loader.ts`에서 다음 상태와 로직을 우선 inventory한다.

- `#runtime`
- `#runtimeSequences`
- `#runtimeSequence`
- `#runtimeEpoch`
- `#runtimeLimiter`
- `#pending`
- upload 및 replacement의 비동기 처리
- runtime reload와 stale result 검사
- metadata, proxy, waveform 적용
- runtime cache 정리

`#audioPreview`, `#videoPreview`, waveform canvas 동기화는 runtime과 관련이
있지만 DOM과의 결합이 강하다. 1차 분리에서 모두 옮기지 말고, 먼저 비동기
runtime loader와 preview cleanup의 실제 경계를 확인한다.

#### Runtime이 소유할 것

- upload API 호출과 임시 object URL lifecycle
- metadata/proxy/waveform 로딩
- per-media sequence
- restore/clear/destroy를 위한 epoch 무효화
- 동시 로딩 제한
- runtime 결과와 runtime 오류
- runtime 결과의 정리와 재로딩

#### Runtime이 소유하지 않을 것

- `LoaderState` 또는 `LoaderStore`
- Media identity와 canonical 순서
- reducer와 validation
- undo/redo history
- graph transaction과 node dirty 처리
- workflow serialization
- Prompt document
- Timeline draft와 Apply/Cancel

#### 권장 계약

실제 구현 전에 필요한 host capability를 inventory하고, 최소 계약으로 고정한다.
예시는 다음과 같다.

```ts
interface MediaRuntimeHost {
  getState(): LoaderState
  getApi(): ReferenceLoaderApi
  setStatus(message: string): void
  onRuntimeChanged(): void
  commitUploadedMedia(result: UploadedMediaResult): void
  commitRuntimeCapabilityChange(change: RuntimeCapabilityChange): void
}
```

이 계약의 핵심은 `commitUploadedMedia`와
`commitRuntimeCapabilityChange`를 통해 canonical state 변경을 명시하는 것이다.
Runtime에 범용 `dispatch(action)`만 제공하여 저장 결정까지 위임하지 않는다.

#### M1 분리 순서

1. upload, metadata, proxy, waveform의 호출 그래프와 stale guard를 inventory한다.
2. runtime 결과 타입을 기존 `LoaderState`와 구분한다.
3. 비동기 loader를 새 모듈로 이동한다.
4. Controller에서 canonical commit과 graph transaction을 계속 수행한다.
5. restore, clear, destroy에서 epoch와 object URL 정리 순서를 고정한다.
6. preview player를 완전히 옮길지 여부는 M1의 runtime 테스트 후 결정한다.

#### M1 완료 기준

- stale upload/runtime 결과가 삭제되거나 교체된 Media를 되살리지 않는다.
- 동일 Media에 대한 이전 로딩 결과가 최신 sequence를 덮어쓰지 않는다.
- runtime metadata/proxy/waveform 변경만으로 history entry가 생성되지 않는다.
- upload 성공 시 canonical commit과 graph transaction의 횟수가 기존과 같다.
- restore, clear, destroy 후 pending object URL과 preview가 정리된다.
- Media runtime 테스트가 Controller 내부 field가 아닌 runtime 계약을 검증한다.

### M2 — View/Snapshot bridge 분리

M1이 안정된 뒤 React view publication과 mount lifecycle을 별도 경계로 검토한다.

#### 분리 후보

- `#buildViewSnapshot`
- `#publishView`
- React mount/update/destroy
- snapshot의 runtime, pending, selection, status 조합
- render scheduling

#### 남겨야 할 것

- canonical state를 변경하는 action
- ComfyUI widget의 저장/복원 계약
- Media runtime의 async lifecycle
- Timeline session의 draft 규칙
- native media element와 waveform의 실제 DOM ownership

`View/Snapshot bridge`는 canonical state를 보유하지 않는다. 기존
`LoaderViewSnapshot`과 equality 규칙을 재사용하고, React는 snapshot을 렌더링하며
typed command를 호출하는 역할만 유지한다.

#### M2 완료 기준

- snapshot 생성이 canonical state를 변경하지 않는다.
- 하나의 사용자 동작이 React와 native 경로에서 중복 dispatch되지 않는다.
- React root가 Loader instance마다 하나만 생성된다.
- update, unmount, destroy가 idempotent하다.
- focus와 native media island의 owner가 문서화되어 있다.

### M3 — ComfyUI lifecycle bridge 분리

View와 runtime 경계가 안정된 뒤에만 ComfyUI 통합 lifecycle을 별도 모듈로
검토한다.

#### 후보 책임

- node/widget 등록 및 제거
- restore/save hooks
- queue 전 callback
- graph dirty 처리
- ComfyUI 이벤트 구독과 해제
- React root와 native island의 mount/teardown 조정

이 모듈은 ComfyUI 외부 계약을 감싸는 adapter에 가깝다. LoaderStore, MediaRuntime,
Prompt controller, Timeline session의 canonical owner가 되어서는 안 된다.

#### M3 완료 기준

- node 제거가 runtime, React root, Timeline session을 모두 종료한다.
- restore와 queue가 기존 serialization 결과를 유지한다.
- 두 Loader instance의 widget/event/lifecycle이 서로 섞이지 않는다.
- destroy가 반복되어도 listener, player, object URL이 남지 않는다.

## 5. Prompt 영역의 처리

Prompt는 이 로드맵에서 다시 분해하지 않는다. `ReferencePromptController`와
Prompt 관련 Store/adapter가 이미 Prompt document, history, serialization,
editor lifecycle의 별도 경계를 형성하고 있다.

Loader Controller에 남겨야 하는 것은 Prompt와 Loader 사이의 최소 bridge뿐이다.

- Prompt reference projection 전달
- Prompt Shot snapshot 전달
- H3 Guide 편집 요청 전달
- Prompt Shot dirty 상태 확인
- Timeline Apply/Cancel과 Prompt draft의 충돌 조정

Prompt document 전체나 Prompt history를 `MediaRuntime` 또는
`H3TimelineSession`으로 옮기지 않는다.

## 6. 책임 소유권 표

| 책임 | 현재/목표 owner | 다음 분리에서의 처리 |
| --- | --- | --- |
| Loader canonical state | `LoaderStore` | 유지 |
| reducer / validation | Store와 기존 H3 helper | 유지 및 재사용 |
| history / undo / graph transaction | Controller와 Store 경계 | 유지 |
| H3 draft / Timeline command | `H3TimelineSession` | 완료 |
| upload / metadata / proxy / waveform | Controller 내부 runtime | M1에서 분리 |
| preview player | Controller 내부 player | M1에서 경계 확인 후 부분 또는 전체 이동 |
| React snapshot publication | Controller | M2에서 분리 검토 |
| ComfyUI node/widget lifecycle | Controller | M3에서 마지막 분리 검토 |
| Prompt document / history | Prompt controller/Store | 이 로드맵 범위 밖 |

## 7. 첫 번째 후속 작업의 범위

실제 다음 PR은 다음 범위로 제한한다.

```text
포함
  - Media runtime 호출 그래프 inventory
  - runtime result 타입과 canonical commit 경계 정의
  - upload/metadata/proxy/waveform loader 추출
  - stale sequence/epoch 및 cleanup contract test

제외
  - MediaStore 신설
  - LoaderState schema 변경
  - Prompt controller 재분해
  - React surface 전면 재작성
  - preview DOM ownership의 일괄 이동
  - ComfyUI lifecycle 전체 이동
```

첫 PR에서 runtime과 View bridge를 동시에 분리하지 않는다. runtime async 문제와
React rendering 문제를 한 변경에서 섞으면 실패 원인을 분리하기 어렵다.

## 8. 검증 게이트

### 자동 검증

- Timeline session contract tests
- Media runtime upload/reload/stale-result tests
- restore, clear, destroy cleanup tests
- 기존 frontend/backend unit tests
- typecheck, lint, format check
- `git diff --check`

### 실제 ComfyUI 검증

자동 테스트만으로 다음 동작을 완료로 판단하지 않는다.

- Nodes 2.0과 Legacy Canvas에서 mount/update/destroy
- file drop과 replacement overlay
- preview player와 waveform DOM
- focus, keyboard, IME, drag/drop
- workflow restore, queue, node removal

각 단계에서 자동 fixture 통과와 실제 ComfyUI 동작 확인을 별도의 결과로
기록한다.

## 9. 하지 않을 것

- 일반적인 `FeatureController` 또는 `ServiceContainer` 추가
- Timeline/Media 전용 Redux나 external state library 추가
- Media canonical state의 두 번째 owner 생성
- Prompt document를 Loader 쪽으로 이동
- runtime이 범용 reducer dispatch를 통해 저장 결정을 수행하도록 허용
- React migration을 이유로 native media island를 억지로 React로 대체
- Controller 이름을 바꾸는 cosmetic refactor
- M1 검증 전에 M2와 M3를 병렬로 진행

## 10. 분리 완료를 판단하는 기준

다음 변경이 서로 독립적인 파일과 테스트로 제한되어야 한다.

```text
Timeline 규칙 변경
  -> H3TimelineSession
  -> H3 helper / Timeline test

Media 비동기 규칙 변경
  -> MediaRuntimeCoordinator
  -> runtime test

Media 저장 규칙 변경
  -> LoaderStore/reducer 또는 Controller commit 경계

React snapshot 변경
  -> View/Snapshot bridge

ComfyUI widget 변경
  -> ComfyUI lifecycle bridge
```

Timeline 변경이 매번 Media runtime, Prompt controller, ComfyUI lifecycle,
React root를 동시에 수정해야 한다면 해당 경계는 아직 충분히 좁지 않다.
