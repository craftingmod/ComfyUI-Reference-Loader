# VIDEO 출력 내장 오디오 독립 토글 구현 계획

## 문서 목적

이 문서는 `Reference Loader`의 VIDEO 출력에 포함되는 내장 오디오를, Audio 목록으로 내보내는 파생 AUDIO와 독립적으로 켜고 끄기 위한 구현 계획이다. 이 문서 자체는 코드 변경을 포함하지 않는다.

검토 기준은 현재 저장소의 상태 모델, manifest, `REFERENCE_LOADER_BUNDLE`, 프론트엔드 미디어 보드 및 ComfyUI 공개 VIDEO API이다.

## 현재 동작과 변경 목표

현재 Video 항목에는 다음 두 상태가 있다.

| 상태           | 현재 의미                                                                     |
| -------------- | ----------------------------------------------------------------------------- |
| `videoEnabled` | 해당 항목을 `videos` 출력 목록에 포함할지 결정한다.                           |
| `audioEnabled` | 같은 파일의 내장 오디오를 추출해 별도 `audios` 출력 목록에 포함할지 결정한다. |

`videoEnabled`가 켜져 있으면 백엔드는 `InputImpl.VideoFromFile`을 그대로 반환하므로, 원본 파일에 오디오 트랙이 있는 경우 VIDEO 객체에도 오디오가 항상 포함된다. Audio 목록의 `A` 토글은 별도 AUDIO 출력만 제어하며 VIDEO 객체의 오디오에는 영향을 주지 않는다.

변경 후에는 Video 항목에 `videoAudioEnabled`를 추가한다.

| 상태                | 변경 후 의미                                       | 기본값  |
| ------------------- | -------------------------------------------------- | ------- |
| `videoEnabled`      | VIDEO 출력 포함 여부                               | `true`  |
| `videoAudioEnabled` | VIDEO 출력 객체가 원본 내장 오디오를 포함할지 여부 | `true`  |
| `audioEnabled`      | 별도 AUDIO 출력 포함 여부                          | `false` |

기본값은 기존 동작을 보존한다. 따라서 이전 워크플로를 열거나 새 Video를 추가했을 때는 VIDEO에 오디오가 포함되며, 별도 AUDIO는 지금처럼 꺼져 있다.

## 기대 동작 조합

오디오 트랙이 있는 Video를 기준으로 다음 조합이 모두 독립적으로 동작해야 한다.

| `videoEnabled` | `videoAudioEnabled` | `audioEnabled` | 결과                                           |
| -------------- | ------------------- | -------------- | ---------------------------------------------- |
| 켬             | 켬                  | 끔             | 오디오가 포함된 VIDEO만 출력                   |
| 켬             | 끔                  | 끔             | 오디오가 제거된 VIDEO만 출력                   |
| 켬             | 켬                  | 켬             | 오디오가 포함된 VIDEO와 별도 AUDIO를 모두 출력 |
| 켬             | 끔                  | 켬             | 오디오가 제거된 VIDEO와 별도 AUDIO를 출력      |
| 끔             | 임의                | 켬             | VIDEO는 출력하지 않고 별도 AUDIO만 출력        |
| 끔             | 임의                | 끔             | 둘 다 출력하지 않음                            |

`videoAudioEnabled`는 Video 출력의 개수, 순서, caption, 출력 번호 또는 Prompt의 `@videoN`에 영향을 주지 않는다. 또한 이 값을 켠다고 `@audioN`이 생겨서는 안 된다. 별도 AUDIO와 `@audioN`은 계속 `audioEnabled`만 따른다.

## 상태 및 호환성 설계

### 필드 이름과 위치

`frontend/src/reference-loader/types.ts`의 `VideoItem`에 다음 필드를 추가한다.

```ts
videoAudioEnabled: boolean
```

이 필드는 `LoaderState`의 전역 설정이나 네 번째 `LoaderChannel`로 만들지 않는다. Video별 설정이며 별도 정렬 목록이나 출력 슬롯을 만들지 않기 때문이다.

### 기본값과 이전 워크플로

- `createMediaItem("video", ...)`는 `videoAudioEnabled: true`를 생성한다.
- 프론트엔드 `validateLoaderState()`는 이전 저장 상태에 필드가 없으면 `true`로 보완한다.
- 백엔드 `parse_reference_state()`도 필드 누락 시 `true`로 해석한다.
- 명시된 값이 boolean이 아니면 프론트엔드는 `true`로 정규화하고, 백엔드의 직접 입력 계약은 오류로 거부한다.
- additive이고 기존 동작으로 안전하게 복원할 수 있으므로 `LOADER_STATE_VERSION`과 snapshot version은 1을 유지한다.
- 기존 `videoAudioPolicy: "preserve"`는 버전 1 상태와 manifest 호환을 위해 유지한다. 새 필드가 없는 상태에서 사용할 기본 정책이라는 의미로 문서를 명확히 한다. 이번 변경에서 별도 migration 계층이나 schema version 2는 만들지 않는다.

Snapshot은 `loader_state` 전체를 포함하므로 별도 snapshot 설정 필드를 추가할 필요가 없다. 현재 직렬화 및 snapshot 경로가 정규화된 `VideoItem`을 그대로 저장하도록 회귀 테스트만 보강한다.

## 프론트엔드 구현

### 1. 타입, 검증 및 reducer

대상 파일:

- `frontend/src/reference-loader/types.ts`
- `frontend/src/reference-loader/validation.ts`
- `frontend/src/reference-loader/reducer.ts`
- `frontend/src/reference-loader/execution.ts`

변경 내용:

1. `VideoItem.videoAudioEnabled`를 추가하고 새 Video의 기본값을 `true`로 설정한다.
2. 상태 복원 시 누락된 값을 `true`로 보완한다.
3. reducer에 Video의 내장 오디오만 토글하는 명시적 action을 추가한다. 예: `toggle-video-audio`.
4. `LoaderChannel`에는 값을 추가하지 않는다. 이 설정에는 독립된 순서, caption 또는 출력 번호가 없기 때문이다.
5. 실행 projection의 Video 항목에 `videoAudioEnabled`를 포함한다. 그래야 이 토글만 바뀌어도 execution fingerprint가 달라져 캐시된 이전 VIDEO가 재사용되지 않는다.

### 2. Videos 카드 UI

대상 파일:

- `frontend/src/reference-loader/components/loader.ts`
- 필요한 경우 `frontend/src/reference-loader/styles/cards.css`

Videos 카드의 기존 `V` 버튼 옆에 VIDEO 내장 오디오 토글을 추가한다.

- action: `toggle-video-audio`
- 표시: 기존 글자형 버튼과 구분되는 speaker 아이콘 또는 `VA`
- 접근성 이름: `Include embedded audio in video output`
- 켜짐/꺼짐은 `aria-pressed`와 기존 `is-on` 스타일로 함께 표현한다.
- tooltip은 `VIDEO output includes embedded audio` / `VIDEO output is muted`처럼 별도 AUDIO 출력과 혼동되지 않게 작성한다.

Audio 보드에 있는 기존 `A` 버튼은 변경하지 않는다. 이 버튼은 계속 파생 AUDIO 출력만 제어한다. 같은 Video가 Videos와 Audio 보드에 각각 보이더라도 두 버튼이 서로의 상태를 바꾸면 안 된다.

출력 badge와 카드의 `is-output-disabled` 상태는 계속 `videoEnabled`만 따른다. `videoAudioEnabled`가 꺼져 있어도 VIDEO 자체는 활성 출력이므로 Video 출력 번호가 유지되어야 한다.

### 3. 무음 Video 처리

metadata의 `hasAudio === false`가 확인된 Video에서는 새 토글을 꺼진 상태로 정규화하고 비활성화한다. 현재 `#disableSilentVideoAudio()`가 파생 AUDIO 토글만 정리하므로 다음 두 상태를 함께 정리하도록 역할을 확장한다.

- `audioEnabled = false`
- `videoAudioEnabled = false`

이 정규화는 현재 상태뿐 아니라 undo/redo history의 같은 항목에도 일관되게 적용해야 한다. 소스에 오디오가 없으므로 이 자동 변경은 실행 결과를 제거하지 않고, UI와 저장 상태를 실제 미디어와 맞춘다.

### 4. Preview 동작

- Videos 카드의 VIDEO preview는 `videoAudioEnabled`를 반영한다. 꺼져 있으면 동일한 영상 preview를 `muted`로 재생한다.
- Audio 카드의 preview는 계속 원본 내장 오디오를 재생하며 `audioEnabled` 경로와 의미를 유지한다.
- 한 preview에서 설정한 `HTMLVideoElement.muted` 값이 다음 preview나 trim editor에 누출되지 않도록 `VideoPreviewPlayer`에 명시적인 muted 설정 경계를 둔다.
- Videos 경로에서 연 trim editor는 VIDEO 출력 설정을 반영하고, Audio 경로에서 연 editor는 오디오 trim을 확인할 수 있도록 소리를 유지한다.

대상 파일:

- `frontend/src/reference-loader/video-preview-player.ts`
- `frontend/src/reference-loader/editors/trim-editor.ts`
- `frontend/src/reference-loader/components/loader.ts`

## 백엔드 구현

### 1. 계약 모델 및 fingerprint

대상 파일:

- `backend/core/reference_contract.py`
- `backend/core/reference_manifest.py`

`ReferenceItem`에 `video_audio_enabled`를 추가한다. Video 파싱에서는 `videoAudioEnabled` 누락을 `True`로 처리하고 명시된 값은 strict boolean으로 검증한다. Image와 Audio 항목에 이 필드가 들어오면 다른 종류 전용 필드와 동일하게 계약 오류로 거부한다.

`execution_projection()`의 Video entry에는 `videoAudioEnabled`를 넣는다. 이 값이 execution fingerprint에 포함되어 토글 변경 시 `Reference Loader` 노드가 다시 실행되어야 한다.

manifest에는 원본 Video 항목의 상태를 다음처럼 기록한다.

```json
{
  "enabled": {
    "video": true,
    "video_audio": false,
    "audio": true
  }
}
```

여기서 `video_audio`는 VIDEO 객체 내부의 내장 오디오이고, `audio`는 `item-id:audio`로 표현되는 별도 AUDIO 출력이다. `parse_reference_manifest_state()`는 `video_audio`가 없는 기존 manifest를 `true`로 복원한다.

`ReferenceOutputPlan`, `ReferenceLoaderBundle`, `[Reference Loader] Media Outputs`의 출력 슬롯 및 caption 목록은 변경하지 않는다. 변경되는 것은 `videos` 튜플 안 VIDEO 객체의 오디오 구성뿐이다.

### 2. VIDEO 로딩 경로

대상 파일:

- `backend/core/reference_media.py`

`load_reference_media()`는 활성 Video를 로드할 때 다음 값을 전달한다.

```py
_load_video(path, crop, include_audio=item.video_audio_enabled)
```

처리 순서는 다음과 같다.

1. 기존처럼 stream layout과 duration/crop을 검증한다.
2. `include_audio=True`이면 현재 `InputImpl.VideoFromFile` 경로를 그대로 반환한다. 기본 경로의 성능과 컨테이너 보존 동작은 바뀌지 않는다.
3. `include_audio=False`이면 crop이 적용된 VIDEO에서 `get_components()`를 호출한다.
4. `dataclasses.replace(components, audio=None)`로 이미지, frame rate, alpha 및 metadata 필드를 유지한 채 audio만 제거한다.
5. 같은 공개 API의 `InputImpl.VideoFromComponents(..., bit_depth=video.get_bit_depth())`로 새 VIDEO 객체를 만든다.

ComfyUI의 공개 API는 `VideoComponents.audio`를 optional로 정의하고 `VideoFromComponents`를 제공하지만, `VideoFromFile` 생성자에는 현재 오디오 포함 여부 인자가 없다. 따라서 초기 구현은 ComfyUI private 메서드를 복사하거나 별도 FFmpeg 실행 경로를 추가하지 않고 공개 component API만 사용한다.

참고한 공식 구현:

- [ComfyUI VideoInput API](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_input/video_types.py)
- [ComfyUI VideoComponents](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_util/video_types.py)
- [ComfyUI VideoFromFile / VideoFromComponents](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_input_impl/video_types.py)
- [ComfyUI CreateVideo / GetVideoComponents](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_video.py)

### 3. 공개 component 경로의 비용과 출하 조건

오디오를 끈 경로는 Video frame을 component tensor로 materialize하고, 저장 시 `VideoFromComponents`가 다시 인코딩할 수 있다. 따라서 원본 `VideoFromFile`을 유지하는 기본 경로보다 메모리 사용량과 처리 시간이 커질 수 있고, 저장된 영상의 codec/container가 정규화될 수 있다.

이 비용은 `videoAudioEnabled=false`인 opt-in 경로에만 발생한다. 다음 검증을 통과하기 전에는 구현 완료로 간주하지 않는다.

- 짧은 MP4에서 audio만 제거되고 frame 수, 해상도, FPS, crop 범위 및 bit depth가 유지되는지 확인한다.
- alpha 또는 metadata가 있는 지원 VIDEO에서 공개 API가 필요한 필드를 유지하는지 확인한다.
- 저장 후 실제 컨테이너를 PyAV로 열어 audio stream이 0개인지 확인한다.
- 최대 허용 크기에 가까운 현실적인 샘플로 peak memory와 실행 시간을 측정한다.

공개 component 경로의 메모리 비용이 허용되지 않으면, 그때만 별도 후속 설계로 packet-copy remux 또는 ComfyUI upstream의 `include_audio` 지원을 검토한다. ComfyUI private `VideoFromFile.save_to()` 구현을 이 저장소에 복제하는 것은 upstream codec, color-space, trim 및 container 변경을 지속해서 따라가야 하므로 이번 변경 범위에 포함하지 않는다.

## 테스트 계획

### 프론트엔드 단위 테스트

대상:

- `frontend/test/reference-loader-state.test.ts`
- `frontend/test/reference-loader-dom.test.ts`
- `frontend/test/reference-loader-snapshot.test.ts`
- VIDEO preview 관련 기존 테스트 파일

필수 검증:

1. 새 Video는 `videoEnabled=true`, `videoAudioEnabled=true`, `audioEnabled=false`이다.
2. 세 토글은 서로 독립적이며 undo/redo와 직렬화 후에도 유지된다.
3. 이전 상태처럼 `videoAudioEnabled`가 없으면 `true`로 복원된다.
4. Videos 카드에 새 토글이 있고 Audio 카드의 기존 `A`와 action/state가 분리된다.
5. 새 토글을 꺼도 Video badge 번호와 `@videoN`은 유지되고 `@audioN` 목록은 변하지 않는다.
6. 무음 Video는 두 오디오 토글이 꺼지고 비활성화된다.
7. Videos preview는 설정에 따라 muted가 바뀌며 Audio preview에는 그 값이 누출되지 않는다.
8. snapshot save/load가 새 필드를 보존한다.

### 백엔드 단위 테스트

대상:

- `tests/backend/test_reference_contract.py`
- `tests/backend/test_reference_media.py`
- `tests/backend/test_reference_loader.py`
- bundle/manifest를 검증하는 관련 테스트

필수 검증:

1. 누락 필드는 `True`, 명시적 `False`는 `False`, 잘못된 타입은 계약 오류가 된다.
2. `videoAudioEnabled`만 바꿔도 execution fingerprint가 달라진다.
3. manifest에 `enabled.video_audio`가 기록되고 기존 manifest는 `true`로 복원된다.
4. `include_audio=True`는 기존 `VideoFromFile` 객체와 trim 동작을 유지한다.
5. `include_audio=False`는 `VideoFromComponents`에 `audio=None`인 components와 원본 bit depth를 전달한다.
6. `audioEnabled=True`이면 VIDEO 오디오 설정과 무관하게 별도 AUDIO가 계속 로드된다.
7. bundle의 Video/AUDIO 개수와 caption alignment는 기존과 같다.

### 실제 미디어 통합 테스트

PyAV가 사용 가능한 환경에서 다음 fixture를 사용한다.

- 오디오가 있는 짧은 MP4
- 무음 MP4
- crop 범위가 설정된 오디오 포함 MP4

각 fixture에 대해 `get_components().audio`뿐 아니라 `save_to()` 결과의 실제 stream layout도 확인한다. mock에서 `audio=None`을 확인하는 것만으로는 최종 VIDEO 파일에서 오디오가 제거됐다고 증명할 수 없다.

### 수동 확인

`docs/TESTING.md`의 Reference Loader 수동 절차에 다음을 추가한다.

1. Videos 카드의 내장 오디오 토글과 Audio 카드의 파생 AUDIO 토글을 각각 조작한다.
2. 위 기대 동작 조합 표의 주요 네 조합을 queue한다.
3. Save Video 또는 Get Video Components에 연결해 VIDEO의 오디오 포함 여부를 확인한다.
4. Media Outputs의 `audios`, `audio_captions`, `videos`, `video_captions`, `manifest_json` 정렬을 확인한다.
5. 저장, ComfyUI 재시작, workflow/snapshot 복원 후 토글 상태가 유지되는지 확인한다.

## 문서 변경

구현과 함께 다음 문서를 갱신한다.

- `docs/REFERENCE_LOADER.md`: `V`, VIDEO 내장 오디오 토글, Audio 보드 `A`의 차이를 설명한다.
- `docs/TESTING.md`: 독립 토글 조합과 실제 VIDEO stream 확인 절차를 추가한다.
- `README.md`: 사용자에게 노출된 미디어 토글 설명이 있으면 동일한 용어로 맞춘다.

용어는 일관되게 다음처럼 사용한다.

- **VIDEO output embedded audio**: VIDEO 객체 안의 내장 오디오
- **derived AUDIO output**: Audio 목록과 `audios` 슬롯으로 나가는 별도 AUDIO

## 구현 순서

1. 프론트엔드/백엔드 상태 계약과 이전 상태 기본값을 먼저 추가한다.
2. execution projection, fingerprint 및 manifest round-trip을 갱신한다.
3. reducer와 Videos 카드 토글을 연결한다.
4. VIDEO preview의 muted 상태를 분리한다.
5. 백엔드의 `include_audio` 분기와 공개 `VideoFromComponents` 경로를 구현한다.
6. 단위 테스트, 실제 미디어 테스트, typecheck 및 전체 테스트를 실행한다.
7. 사용자 문서와 수동 테스트 절차를 갱신한다.

권장 검증 명령:

```powershell
bun run typecheck
bun run test:frontend
bun run test:backend
bun run test
```

## 완료 기준

- VIDEO 내장 오디오와 파생 AUDIO를 모든 조합에서 독립적으로 제어할 수 있다.
- 기존 workflow와 snapshot은 별도 migration 없이 현재 VIDEO-with-audio 동작으로 복원된다.
- 토글 변경이 execution fingerprint와 manifest에 반영된다.
- 출력 슬롯, media order, caption alignment 및 Prompt mention 규칙은 바뀌지 않는다.
- `videoAudioEnabled=true`인 기본 경로는 기존 `VideoFromFile` 동작을 그대로 사용한다.
- `videoAudioEnabled=false`인 VIDEO를 실제로 저장하거나 분해했을 때 audio stream/component가 없다.
- 오디오 제거 경로의 성능 및 필드 보존 검증 결과가 문서화되어 있다.

## 범위 제외

- 여러 audio track 중 하나를 선택하는 기능
- Video별 volume 조절 또는 오디오 편집
- 새로운 ComfyUI 출력 슬롯 추가
- 별도의 audio order/caption 체계 추가
- 외부 FFmpeg 실행 파일 경로 설정
- ComfyUI private VIDEO 구현 복제
- 이번 기능과 무관한 state/snapshot schema 재설계
