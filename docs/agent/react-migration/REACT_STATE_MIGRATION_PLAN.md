# Reference Loader React 전환: Controller 상태 정리 및 단계별 작업 계획

작성 기준: 2026-09-08 현재 작업 트리. 이 문서는 구현 계획이며 코드 전환 완료를 의미하지 않는다.

## 1. 목표와 범위

`ReferenceLoaderController`의 상태 변경·알림·부수 효과를 먼저 정리한 뒤 일반 Media UI를 React로 전환한다. 기존 `reducer.ts`, `history.ts`, 직렬화와 API를 재사용하며, 저장 상태를 React 안에 복제하지 않는다.

기존 [REACT_MIGRATION.md](./REACT_MIGRATION.md)의 방향을 실행 가능한 파일 단위 작업으로 구체화한다. 기존 작업 트리의 GUIDE React 실험과 기타 수정은 보존한다. 이 계획에서는 기존 문서의 “GUIDE 데이터가 있는 경우 legacy 경로 또는 오류” 중 **legacy 경로 유지**를 초기 기본안으로 선택한다.

- 초기 포함: Controller 상태 정리, 일반 Media Toolbar/Channel/Card, 업로드, 순서 변경, 캡션, I/V/VA/A, Snapshot, Clear/Undo/Redo, 기존 편집기 호출.
- 초기 제외: GUIDE 편집 UI, Start/End 배치, GUIDE Timeline 상호작용, GUIDE draft 모델 재설계, native H3 conditioning 변경.
- 유지: Prompt 편집기와 Subject/Shot 데이터 소유권, image/trim 편집기 내부, 플레이어와 waveform 처리, ComfyUI 위젯 생명주기.
- 함께 변경하지 않음: 저장 스키마 버전, Python backend 계약, Tailwind, 전역 상태 라이브러리, 청크 분리.

첫 구현 단위는 React 컴포넌트가 아니라 **기존 DOM UI를 유지한 상태 변경 경계 정리**다.

## 2. 현재 코드에서 확인한 문제

| 위치                                                   | 현재 책임/동작                                                                        | 전환 시 필요한 조치                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `components/loader.ts`의 `ReferenceLoaderController`   | 약 3,200줄에 history, runtime, upload, display, GUIDE draft, DOM 이벤트/마크업이 결합 | 저장 상태 → 알림 → 화면의 의존 방향부터 정리               |
| `#dispatch`, `#onInput`, Undo/Redo 클릭 처리           | 각각 history를 직접 변경하며 후속 처리가 다름                                         | 의미별 mutation 메서드로 수렴                              |
| `#disableSilentVideoAudio`                             | present뿐 아니라 past/future의 오디오 플래그도 보정                                   | 일반 사용자 action으로 바꾸지 말고 별도 보정 연산으로 유지 |
| `render`, `#renderSingleImage`                         | `innerHTML` 교체 후 Prompt reference listener 호출                                    | 참조 알림을 DOM 렌더에서 분리                              |
| `#composing`, `#renderPending`                         | textarea 편집 중 전체 재렌더를 미룸                                                   | 상태 발행은 즉시, 입력 DOM 보호는 view의 책임으로 분리     |
| `writeDisplayProxy`                                    | `state.ui`와 `node.properties.referenceLoader`를 모두 변경                            | 저장 위치와 두 history 경계를 명시                         |
| `#runtime`, `#pending`, epoch/sequence/AbortController | 비동기 결과, 취소, 표시 상태와 리소스 수명 관리                                       | React가 소유할 표시값과 외부 리소스를 구분                 |
| `extension.ts`                                         | 직렬화/복원, graph change, widget 제거, display proxy, Prompt 연결                    | 기존 public Controller API를 유지해 변경 파급 제한         |

React와 React DOM, React 타입, `react-jsx` 설정은 이미 존재한다. `h3-guide-editor.tsx`도 작업 트리에 있으므로 React 설치/샘플 작성은 선행 작업이 아니다.

## 3. 상태 소유권

| 상태                                                                 | 기준 데이터 소유자                     | 저장/Undo 정책                     | React 접근                                           |
| -------------------------------------------------------------------- | -------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `LoaderState`: items, order, output flags, crop/edit, ui, h3Timeline | 노드별 `LoaderStore`                   | 기존 serialize + Loader history    | 읽기 전용 snapshot, command 호출                     |
| metadata, loading/error, previewUrl, pending 표시                    | Controller                             | 저장/Loader Undo 제외              | 불변 view snapshot                                   |
| File, object URL, AbortController, limiter, request sequence         | Controller                             | 저장 제외, restore/destroy 시 정리 | 리소스 자체를 전달하지 않음                          |
| 선택된 media ID, status                                              | 초기에는 Controller                    | 저장 제외                          | 공용 view snapshot                                   |
| Snapshot menu, hover/drop 시각 상태, caption 입력 버퍼               | 해당 view                              | 저장 제외                          | legacy는 기존 필드, React 전환 시 컴포넌트로 이전    |
| 오디오/비디오 실제 재생과 canvas                                     | 기존 player/native host                | 저장 제외                          | 구독값/명령과 명시적 host ref                        |
| Prompt document와 Shot 편집 상태                                     | 기존 Prompt controller                 | 기존 Prompt 계약                   | Loader에 복제하지 않고 참조 projection/callback 유지 |
| GUIDE draft/Timeline view                                            | 기존 GUIDE 경로                        | 기존 Apply/Cancel 정책             | 초기 React 모델에서 제외                             |

`LoaderStore`는 하나의 구체 구현만 만든다. 범용 store framework, action middleware, dependency injection 계층은 추가하지 않는다. `LoaderState.ui`는 이름에 UI가 있어도 현재 저장 대상이므로 컴포넌트 local state로 옮기지 않는다.

## 4. 목표 흐름

```text
React / legacy DOM / ComfyUI display proxy
                  ↓ 의미별 Controller command
ReferenceLoaderController
  ├─ LoaderStore → loaderReducer + history
  ├─ API / upload / player / request cancellation
  ├─ node properties / graph change
  └─ cached view snapshot + subscriptions
                  ↓
React useSyncExternalStore / legacy render / Prompt reference subscription
```

### 저장 상태 변경

- Store는 `state`, `canUndo`, `canRedo`, `dispatch(action, { mergeKey? })`, `undo`, `redo`, `restore`를 담당한다. `restore`는 history를 새로 시작한다.
- 무음 Video 자동 보정은 기존처럼 history 전체에 적용하는 명시적인 연산으로 둔다. 과거 상태를 복원하면 불가능한 오디오 출력이 다시 켜지는 회귀를 막는다.
- Controller는 변경이 있는지 확인한 뒤 기존 graph before/after 쌍으로 실제 mutation을 감싼다. no-op은 새 history/graph transaction을 만들지 않는다.
- 사용자 commit, undo/redo, workflow restore, runtime-only 갱신을 구별한다. workflow restore를 사용자 편집으로 재기록하지 않는다.
- 한 사용자 동작의 저장 상태 변경과 필요한 후처리를 마친 뒤 view와 Prompt에 일관된 상태를 발행한다. React batching에 transaction 의미를 맡기지 않는다.
- 캡션은 기존 IME/caption `mergeKey`를 유지한다. React 입력 이벤트에서도 현재 문자열을 즉시 canonical state로 전달해 입력 직후 Queue/Save 시 마지막 문자가 빠지지 않게 한다.
- graph history와 Loader local history를 이번 작업에서 합치지 않는다. node property 변경은 현재처럼 graph 쪽에 남긴다.

### 읽기와 알림

- Controller에 안정된 함수 참조의 `subscribeView(listener)`와 `getViewSnapshot()`을 추가한다.
- snapshot에는 state 참조, display, runtime 표시값, pending 표시 목록, selected ID, status, Undo/Redo 가능 여부를 담는다. 실제 `File`, DOM, player, AbortController는 넣지 않는다.
- 변경이 없으면 `getViewSnapshot()`은 같은 객체를 반환한다. 변경 시 새 snapshot을 만든 후 알린다. 기존 mutable Map을 그대로 노출하거나 getter 호출마다 새 배열을 만들지 않는다.
- `subscribePromptReferences`의 기존 진입 API와 초기 통지 의미는 유지하되 알림 발생 지점을 `render()`에서 제거한다. 참조 순서/활성화/source/preview 변경 뒤 발행하고, 단순 메뉴 열림은 Prompt 갱신을 유발하지 않게 한다.
- view의 재렌더 지연은 알림을 지연하지 않는다. Prompt 구독 callback이 Shot 목록을 Loader에 전달하는 왕복 경로에는 동일 값 재발행 방지를 둔다.
- derived ordinal, filename, duration, disabled 상태는 `view-model.ts`의 순수 계산으로 만든다. leaf card가 전체 state를 다시 해석하지 않는다.

React 외부 상태 구독과 snapshot 안정성 규칙은 [React 공식 useSyncExternalStore 문서](https://react.dev/reference/react/useSyncExternalStore)를 따른다. 이 저장소에는 React 외부의 ComfyUI/Prompt 호출자가 있어 외부 저장소를 유지할 이유가 있다.

### 비동기와 해제

- 현재 runtime 동시성 제한 4, epoch, item sequence, source 검증을 유지한다.
- restore/Clear/destroy 이후 늦게 끝난 요청은 state/runtime/React를 갱신하지 않는다. replace/edit 뒤 이전 source의 결과도 무시한다.
- React effect에서 업로드/metadata 요청을 새로 시작하지 않는다. 기존 Controller command가 요청을 시작하고 결과만 발행한다.
- 노드 제거 시 구독 해제, React unmount, native host 해제, 요청 취소, player destroy, object URL 해제를 책임별로 수행한다. 중복 destroy도 안전해야 한다.
- 재생 진행처럼 빈번한 갱신은 player host에서 처리해 전체 Media tree를 매번 다시 그리지 않는다.

## 5. GUIDE 제외의 구체적 경계

초기 React 경로는 GUIDE 데이터가 없는 문서에 적용한다. 기존 문서의 GUIDE를 없애거나 disabled로 직렬화하지 않는다.

- `h3Timeline.enabled`, Start/End ID, guides, disabledVisualIds/disabledAudioIds 중 하나라도 값이 있으면 기존 Loader view를 사용한다. enabled=false만으로 GUIDE-free로 판단하지 않는다.
- GUIDE 데이터가 있는 Snapshot/workflow를 restore할 때도 같은 판정을 한다. view 교체가 필요하면 기존 view를 먼저 해제하고 같은 canonical store를 사용한다.
- GUIDE-free React 경로에는 G/Guide 편집/Start/End 배치 컨트롤과 GUIDE command를 노출하지 않는다.
- 공통 `types.ts`, `reducer.ts`, `validation.ts`, 직렬화의 GUIDE 데이터 보존/검증은 제거하지 않는다. backend 실행 경로도 변경하지 않는다.
- 기존 reducer의 Remove/Clear는 GUIDE 참조를 정리한다. 따라서 “React에서 GUIDE 컨트롤만 숨기고 모든 Media 작업이 timeline을 무조건 보존한다”는 보장은 하지 않는다. GUIDE 문서를 legacy로 보내 이 의미를 유지한다.
- 향후 legacy를 제거하려면 GUIDE 복구 계획 또는 명시적인 미지원 문서 처리 정책이 먼저 필요하다. 초기 구현에서는 silent fallback to empty timeline을 금지한다.

Shot은 GUIDE와 구별한다. 기존 `setPromptShots`와 Shot callback을 유지하고, Shot lane은 필요 시 native host에 남긴다. Prompt document를 LoaderStore로 이동하지 않는다.

## 6. 단계별 구현과 완료 조건

### 단계 0 — 현행 계약 고정

작업 파일: 기존 `reference-loader-state.test.ts`, `reference-loader-dom.test.ts`, `reference-loader-extension.test.ts`, `reference-loader-snapshot.test.ts`.

1. 현재 테스트 결과를 기준선으로 기록한다. 이미 수정 중인 GUIDE 시험 파일의 결과는 구분한다.
2. references/single-image 두 모드, caption/IME history, property history, restore, 무음 Video 보정 경로를 확인한다.
3. 누락된 핵심 동작만 보강한다. 마크업 전체 문자열 snapshot을 추가하지 않는다.

완료: 이후 단계에서 유지할 저장/사용자 동작을 테스트로 비교할 수 있다.

### 단계 1 — history와 mutation 경계 추출, DOM 유지

작업 파일:

- 신규 `frontend/src/reference-loader/loader-store.ts`: LoaderState/history의 단일 소유자.
- 수정 `components/loader.ts`: `#history` 직접 대입 제거, store 위임, 의미별 command 진입점 정리.
- 재사용 `reducer.ts`, `history.ts`, `serialization.ts`, `types.ts`: 기존 로직을 JSX에 복사하지 않음.
- 신규 `frontend/test/reference-loader-store.test.ts`: mutation/history 계약 검증.

1. 일반 action, caption merge, Undo/Redo, restore, 무음 Video history 보정을 store 경로로 모은다.
2. `state`, `serialize`, `restoreSnapshot`, `displayState`, `writeDisplayProxy`, file drop, Prompt API 등 외부 호출 계약을 유지한다.
3. DOM event handler는 ID/channel/value 해석 후 command를 호출하게 한다. React에서도 같은 command를 호출하게 설계한다.
4. raw reducer dispatch만 공개해 player mute 후처리를 우회하지 않게 한다.

완료: Controller에서 history 직접 변경 경로가 사라지고 기존 DOM 동작이 유지된다. 아직 JSX 전환은 없다.

### 단계 2 — 상태 발행과 렌더링 분리

작업 파일:

- 신규 `frontend/src/reference-loader/view-model.ts`: 일반 Media snapshot/view 타입과 projection.
- 수정 `components/loader.ts`: cached snapshot, view 구독, Prompt 알림, runtime 갱신 후 발행.
- 수정/보강 store 및 DOM 테스트: 렌더 없이 알림/직렬화가 동작하는지 검증.

1. `#changed`를 저장 변경 후처리와 view 갱신 요청으로 분리한다.
2. caption, display properties, runtime completion/error, pending, restore, silent-video correction 모두 발행 경로를 거치게 한다.
3. `render()`와 `#renderSingleImage()`에서 Prompt listener 호출을 제거한다.
4. legacy view는 발행을 받아 기존 방식으로 렌더한다. IME 등으로 렌더를 미뤄도 다른 구독자는 최신 값을 받는다.

완료: 동일 snapshot 참조 안정성, runtime-only 갱신의 history 불변성, unsubscribe/destroy, Prompt 왕복 구독을 테스트로 확인한다.

### 단계 3 — 영구 React root와 첫 Media 전환

작업 파일:

- 신규 `components/loader-react.tsx`: mount/unmount 함수, root, Toolbar/MediaChannel/MediaCard. 처음에는 작은 컴포넌트를 한 파일에 둔다.
- 수정 `components/loader.ts`: view 선택과 React 연결, 기존 일반 DOM listener 중복 실행 방지.
- 확인 `extension.ts`: 현재 `addDOMWidget`/getValue/setValue/onRemove 유지, 크기 측정 연결 검증.
- 확인 `frontend/build.ts`, `frontend/test/build-config.test.ts`: 기존 React 번들 경계 재사용.
- 신규 `frontend/test/reference-loader-react.test.ts`: Controller를 통해 React 경로 검증.

1. GUIDE-free references 모드부터 root를 한 번 mount한다. 일반 갱신마다 createRoot/unmount하지 않는다.
2. Toolbar, 세 채널, 카드, output toggles, caption, upload/pending/status, Snapshot/Undo/Redo를 하나의 수직 기능 단위로 전환한다.
3. `key`는 channel과 media ID로 구성한다. Video와 파생 Audio 카드가 같은 item ID를 공유함을 반영한다.
4. native player/waveform은 안정된 host ref에서 관리한다. unrelated state 갱신으로 재생 element가 교체되지 않아야 한다.
5. 이벤트 소유권을 컴포넌트로 옮긴 영역에는 legacy delegated click/input/drop이 실행되지 않게 한다. React가 관리하는 subtree를 `innerHTML`로 덮어쓰지 않는다.
6. `.rl-channels` 등 extension 높이 측정에 필요한 경계와 기존 `.rl-*` CSS를 유지한다.

완료: GUIDE-free 일반 Media 기능이 Controller→React 경로에서 동작하며 root/player/focus의 생명주기가 유지된다.

ComfyUI 연결은 [공식 extension hooks](https://docs.comfy.org/custom-nodes/js/javascript_hooks)와 [DOM widget 객체 설명](https://docs.comfy.org/custom-nodes/js/javascript_objects_and_hijacking)을 기준으로 기존 경계를 유지한다. React 전환 자체를 이유로 새로운 prototype hook을 추가하지 않는다.

### 단계 4 — 복원·상호작용·single-image 완성

작업 파일: `components/loader-react.tsx`, `components/loader.ts`, `extension.ts`, 기존 DOM/extension/Snapshot 테스트와 React 테스트.

1. single-image 모드도 같은 store/command 경계로 전환하되 미리보기 크기, image-only, 단일 항목 강제를 유지한다.
2. 단일 파일의 replace는 ID/order/caption/stable Prompt identity를 보존한다. 카드 교체, Add tile, 일반 영역 드롭과 내부 reorder를 구분한다.
3. IME 조합, 입력 선택 범위, caption의 Video/Audio override, 편집기 Apply/Cancel, keyboard Undo를 확인한다.
4. Snapshot/workflow restore와 GUIDE legacy 전환, 두 노드 간 상태 독립, 삭제 중 업로드 완료를 검증한다.
5. React commit 이후 크기를 측정해야 하는 지점이 있는지 live ComfyUI에서 확인한다. render 호출 직후 DOM이 완성됐다고 가정하지 않는다.

완료: 두 Loader 모드의 일반 기능 및 lifecycle 검증이 통과한다. GUIDE 복구는 완료 조건에 포함하지 않는다.

### 단계 5 — 이관된 코드 정리와 다음 범위 결정

- legacy GUIDE 경로에서 여전히 쓰는 마크업/이벤트는 유지한다. references GUIDE-free/single-image React 경로에서만 불필요해진 우회 처리를 제거한다.
- `loader.ts`에 남는 책임은 ComfyUI/API transaction, 비동기 리소스, view 연결 및 보존된 GUIDE 경로다. GUIDE 때문에 남은 코드량만으로 추출 실패로 판단하지 않는다.
- Prompt/editor shell 전환과 GUIDE 복구는 별도 후속 작업으로 계획한다.
- `docs/REACT_MIGRATION.md`, `frontend/src/README.md`, `docs/TESTING.md`에 실제 완료 범위와 남은 legacy 경로를 반영한다.

## 7. 검증 기준

| 검증         | 핵심 시나리오                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 저장/history | action no-op, caption merge/IME, undo/redo, restore history 초기화, Snapshot display 복원, 무음 Video past/future 보정 |
| 알림         | DOM render 없이 Prompt 갱신, 같은 snapshot 재사용, 변경 후 새 snapshot, runtime-only는 history 미변경, unsubscribe     |
| 비동기       | restore/Clear/remove/replace/destroy 뒤 지연 결과 무시, object URL 해제, request limit 유지                            |
| React        | root 재생성 없음, input focus 유지, unrelated update 중 재생 유지, 두 인스턴스 독립, 이벤트 1회 처리                   |
| Media        | I/V/VA/A 독립, Video의 파생 Audio caption, 순서별 Prompt ordinal, replace identity                     |
| GUIDE 경계   | disabled지만 데이터가 있는 timeline도 legacy로 복원, GUIDE 데이터 미손실, React에는 GUIDE command 없음                 |
| ComfyUI live | Nodes 2.0/Legacy Canvas의 높이·폭·zoom·drop·저장/재로드·Queue 직전 입력·노드 삭제                                      |

단계별로 관련 테스트와 `bun run typecheck`를 실행한다. 일반 Media 전환 완료 시 저장소 표준 `bun run test:unit`과 `bun run build`를 실행하고 `git diff --check`를 확인한다. 린트/포맷은 기존 repo 명령을 따른다. `bun run test`는 `test:unit`의 alias이므로 같은 검사를 중복 실행하지 않는다.

happy-dom 통과를 실제 ComfyUI 레이아웃/재생 검증으로 간주하지 않는다. backend 코드를 바꾸지 않아도 최종 회귀 검사에서 직렬화 호환성을 확인한다. 패키지 배포 검증은 실제 배포 단계에서 `docs/TESTING.md`의 전체 절차를 따른다.

## 8. 권장 작업 분할

1. **상태 정리 PR:** 단계 0~1. 기존 DOM 유지, store/history 경계만 변경.
2. **알림 정리 PR:** 단계 2. render와 Prompt/state 구독 분리.
3. **React Media PR:** 단계 3. GUIDE-free references 수직 기능 전환.
4. **전환 마무리 PR:** 단계 4~5. single-image, restore/lifecycle, live 확인 및 문서 정리.

각 단계의 완료 조건이 통과한 뒤 다음 단계로 진행한다. Controller 전체 재작성이나 GUIDE 재설계를 첫 PR에 섞지 않는다.

### 단계 5 실행 기록 (2026-09-08)

- 일반 Media와 single-image React 경로의 이벤트 소유권을 `#legacyRoot`와
  React subtree로 분리했다. legacy delegated click/input/change/keyboard와
  카드 drag 처리는 보존된 legacy 경로에만 설치하고, 외부 widget 루트에
  직접 놓이는 drag/drop만 호환 fallback으로 남겼다.
- `h3Timeline`이 활성화되었거나 Start/End, Guide, disabled media ID가 있으면
  restore를 포함해 legacy 경로를 선택한다. Guide 데이터의 silent empty reset은
  하지 않는다.
- `docs/REACT_MIGRATION.md`, `frontend/src/README.md`, `docs/TESTING.md`에
  ordinary Media의 현재 완료 범위, legacy Guide 경계, 미검증 live ComfyUI
  범위를 반영했다.
- Prompt/editor shell 전환과 full Guide 복구는 다음 별도 범위로 남긴다.
