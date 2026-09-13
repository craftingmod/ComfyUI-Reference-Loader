# Reference Loader H3 Timeline Guides 구현 계획

> UI 통합 상태: Prompt 아래 독립 패널 제안은 `docs/H3_MEDIA_GUIDES_INTEGRATION_PLAN.md`의 Media-owned editor 구현으로 대체되었다. 이 문서의 상태·backend·native H3 계약과 미검증 범위는 계속 유효하다.

작성일: 2026-09-07  
상태: Media 통합 UI와 Guide source 제한은 구현되었고, 실제 H3 checkpoint 생성 및 두 Canvas 수동 검증은 미완료다.  
대상: `ComfyUI-Reference-Loader`를 구현할 개발자 및 서브 에이전트.

## 1. 목표와 읽는 순서

Reference Loader의 **Media 내부**에 `H3 Timeline Guides` 요약과 카드별 편집기를 추가한다. 사용자는 이미 업로드한 미디어를 선택하여 시작 프레임, 끝 프레임, N개의 중간 이미지/standalone 오디오 Guide를 지정한다. H3 Wrapper는 기존 reference conditioning에 이 시간 조건을 추가한다.

사용 예:

- 고양이 이미지는 기존 `<Picture 1>` reference로 사용한다.
- 다른 이미지는 시작 프레임으로만 사용한다.
- 48프레임에는 특정 포즈의 이미지를 배치한다.
- 72프레임부터 오디오 Guide를 배치한다.
- 끝 프레임에는 마지막 구도의 이미지를 배치한다.

개발자는 2~~5절에서 요구사항을 이해하고, 6~~10절의 데이터/실행 계약을 읽은 뒤, 12절의 작업 순서를 따른다. 각 단계의 완료 조건을 충족한 후 다음 단계로 이동한다. 화면부터 만든 뒤 데이터 구조를 끼워 맞추지 않는다.

### 1.1 사용자 요청과 계획상의 결정 구분

**대화에서 확인된 방향**:

1. 외부 Hybrid 노드의 기능을 이 Reference Loader에 적용하는 것이 목적이다.
2. First Frame, Last Frame, 임의 프레임 Guide를 함께 지정하고 싶다.
3. Guide는 별도 Prompt 입력 없이 시간 위치를 가진 latent 조건으로 사용한다.
4. UI는 Media 카드와 같은 영역에 배치하는 방향이다.
5. 현재 요청의 산출물은 상세한 Markdown 계획서다.

**이 문서에서 구현 기준으로 제안하는 세부 정책**:

- 접기와 활성화를 분리하고 초기값은 비활성/접힘으로 한다.
- 미디어 역할을 카드의 단일 선택값으로 만들지 않고 Timeline에서 ID로 참조한다.
- reference 출력이 꺼진 미디어도 Guide로 선택할 수 있다.
- Start/End는 이미지 전용, 중간 Guide는 이미지와 선택적 standalone AUDIO를 지원한다. VIDEO와 video-derived AUDIO는 Guide에서 제외한다.
- 같은 종류의 조건이 시간상 겹치면 명확한 오류를 낸다.
- 프레임 정수를 입력하고 초는 읽기 전용으로 표시한다.
- 일반 Loader와 기존 출력 노드의 계약은 유지하고 H3 Wrapper가 Timeline을 소비한다.

이 정책들은 사용자가 모든 세부 항목을 명시적으로 확정한 기록이 아니라, 개발자가 일관되게 구현할 수 있도록 정한 기본안이다. 변경이 필요하면 문서와 테스트의 기대값부터 함께 수정한다.

## 2. 용어와 앞선 설명의 보완

| 용어        | 의미                                               | Prompt 태그                   |
| ----------- | -------------------------------------------------- | ----------------------------- |
| Reference   | 기존 이미지·영상·오디오 reference 입력             | 기존 규칙대로 생성            |
| Start       | 출력 영상 0프레임에 놓는 이미지 Guide              | 자동 생성하지 않음            |
| End         | 실제 출력 영상의 마지막 프레임에 놓는 이미지 Guide | 자동 생성하지 않음            |
| Guide       | 지정한 위치의 이미지 또는 standalone 오디오 조건   | 자동 생성하지 않음            |
| Latent      | VAE가 미디어를 변환한 모델 입력 표현               | 텍스트가 아님                 |
| Bundle      | Loader가 출력 노드에 전달하는 런타임 묶음          | 미디어와 manifest 등을 보유   |
| Manifest    | 미디어 ID, 출처, 설정을 기록한 JSON                | 미디어 바이트를 포함하지 않음 |
| Fingerprint | 입력 변경에 따라 캐시를 무효화하는 식별값          | 사용자 편집 대상 아님         |

Guide는 지정 위치의 조건을 모델에 제공한다. **최종 프레임을 입력 이미지로 교체하거나 WAV를 결과에 그대로 붙이는 편집 기능이 아니다.** 픽셀/파형이 정확히 동일하다고 UI나 문서에 보장하지 않는다.

Start/End도 이 기능에서는 Guide의 위치 별칭으로 다룬다. 공식 `Image to Video` 노드는 이미지의 text/vision encoder 입력도 구성하므로, Start/End Guide만 추가한 결과가 공식 FL2VA 경로와 완전히 동일하다고 설명하면 안 된다.

외부 Hybrid 노드의 모델별 품질 우선순위 설명은 사용 경험에 관한 안내다. FL2VA와 Ref2VA 중 어떤 checkpoint가 항상 더 강하게 조건을 유지하는지는 이번 구현의 보장 사항이 아니다.

### 2.1 이전 제안 중 그대로 구현하면 안 되는 사항

- **첫 두 이미지를 자동으로 Start/End로 소비하지 않는다.** 명시적으로 선택한다.
- **지원되는 Guide 전용 미디어를 선택 목록에서 제외하지 않는다.** 기존 출력 off는 reference off이며 Guide off와 다르다. Video와 video-derived Audio는 Guide source가 아니다.
- **Guide를 추가했다고 Picture/Audio 번호를 바꾸지 않는다.** 기존 reference 활성 목록이 그대로이면 번호도 그대로다.
- **Prompt preset으로 실행을 제어하지 않는다.** preset은 기존 코드에서 UI용이다.
- **End를 123 같은 숫자로 저장하지 않는다.** `end` 의미를 저장하고 실행 때 실제 길이로 계산한다.
- **외부 `model_base_patch.py`를 바로 복사하지 않는다.** 현재 ComfyUI의 Guide/reference 혼합 처리 호환성을 먼저 확인한다.
- **Guide를 별도 노드로 먼저 출시하는 단계는 필수가 아니다.** 최종 방향은 Prompt 아래 통합 패널과 기존 H3 Wrapper의 소비다.

## 3. 현재 구현에서 재사용할 것

아래 경로는 저장소 루트 기준이다. 작업 시작 시 파일이 바뀌었는지 다시 확인한다.

| 영역           | 파일                                                                         | 현재 역할 / 활용                                                   |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Loader 진입    | `backend/nodes/reference_loader.py`                                          | state 해석, media loading, manifest와 bundle 생성                  |
| 공통 계약      | `backend/core/reference_contract.py`                                         | Python 상태 검증, 실행 projection, fingerprint                     |
| 미디어 로더    | `backend/core/reference_media.py`                                            | 안전한 경로 확인, 이미지 편집 적용, AUDIO/VIDEO trim               |
| Manifest       | `backend/core/reference_manifest.py`                                         | active 출력 목록 및 원본 상태 복원                                 |
| Bundle         | `backend/nodes/reference_bundle.py`                                          | 타입과 미디어/manifest 정합성 검증                                 |
| H3 Wrapper     | `backend/nodes/minimax_h3_reference_wrapper.py`                              | native R2V 호출, 24fps 변환, soundtrack pairing, Audio 번호 재매핑 |
| Start/End 출력 | `backend/nodes/reference_loader_start_end_frames.py`                         | 기존 I2V/L2V/FL2V 모드의 nullable IMAGE 출력                       |
| 옵션 재적용    | `backend/nodes/reference_loader_options_override.py`                         | 이미지 설정 변경 후 bundle 재생성                                  |
| FE 계약        | `frontend/src/reference-loader/types.ts`, `validation.ts`, `execution.ts`    | 브라우저 상태와 검증/실행 projection                               |
| 상태 변경      | `frontend/src/reference-loader/reducer.ts`, `history.ts`, `serialization.ts` | 편집, undo/redo, 저장                                              |
| 복원           | `frontend/src/reference-loader/snapshot.ts`                                  | Snapshot Save/Load                                                 |
| 화면 연결      | `frontend/src/reference-loader/extension.ts`                                 | Media/Prompt DOM widget 생성 및 lifecycle                          |
| 화면 본체      | `frontend/src/reference-loader/components/loader.ts`                         | 업로드/카드/편집기 관리                                            |
| Prompt         | `frontend/src/reference-loader/components/prompt-editor.ts`                  | Prompt 전용 편집기                                                 |
| 스타일         | `frontend/src/reference-loader/styles/loader.css` 등                         | Nodes 2.0/Legacy 레이아웃                                          |

기존에 이미 있는 비디오 오디오 분리, 24fps 변환, reference 크기 옵션, Prompt 편집, Audio 번호 재매핑을 새로 구현하지 않는다.

기존 `Start/End Frames` 출력 노드는 enabled IMAGE 순서와 최대 2개 검증 계약을 유지한다. 새 Timeline 설정이 이 노드의 결과를 몰래 바꾸면 안 된다.

## 4. UI 사양

### 4.1 위치와 구조

```text
Media
  Images  [I] [G] ... [I-pencil] [G-pencil]
  Videos  [V] [VA] ... [I-pencil]
  Audio   [A] [G] ... [I-pencil] [G-pencil]
  ▸ H3 Timeline Guides                       [사용 OFF]

Prompt
  기존 Prompt 편집기
```

펼친 상태:

```text
▾ H3 Timeline Guides                       [사용 ON]
  24 fps · End는 H3 Wrapper의 실제 출력 길이에 맞춰 계산됩니다.

  Start Frame   [없음 / 이미지 선택 ▼]       0f
  End Frame     [없음 / 이미지 선택 ▼]       End

  Guide 1       Frame [48]    2.00s
                Visual [이미지 선택 ▼]
                Audio  [없음 / standalone 오디오 선택 ▼] [삭제]

  Guide 2       Frame [72]    3.00s
                Visual [없음 ▼]
                Audio  [door.wav ▼]                   [삭제]

  [+ Guide 추가]
```

레이아웃은 폭이 좁아지면 각 Guide의 Visual/Audio 선택을 세로로 배치한다. 별도 타임라인 캔버스, 드래그 가능한 시간 ruler, 새 UI 라이브러리는 만들지 않는다.

### 4.2 활성화와 표시

1. 초기 상태는 OFF, 접힘이다.
2. 접는 동작은 실행 여부를 바꾸지 않는다.
3. OFF로 바꾸면 값은 보존하되 실행하지 않는다. 저장된 역할은 계속 보이며 편집은 가능하다.
4. 모든 Prompt preset에서 접힌 헤더는 접근 가능하게 둔다. H3 preset 변경은 enable/disable을 실행하지 않는다.
5. `Load Reference Image` 단일 이미지 UI에는 표시하지 않는다.
6. 접힌 헤더에 `OFF` 또는 `ON · Start · Guides 2 · End`처럼 구성 요약을 표시한다.
7. Loader는 downstream Wrapper의 실제 길이를 알 수 없으므로 `End 123f`처럼 추정한 숫자를 표시하지 않는다.
8. 활성화된 미완성/오류 행이 있으면 접힌 상태에서도 오류 개수를 표시한다.

### 4.3 미디어 선택 규칙

- 드롭다운의 값은 filename, 배열 index, `<Picture N>`이 아니라 **안정적인 media ID**다.
- 화면에는 filename과 구분 가능한 짧은 ID를 표시한다. 같은 이름 파일도 구분되어야 한다.
- Start/End는 업로드된 IMAGE만 선택한다.
- Guide Visual은 IMAGE 하나만 선택한다.
- Guide Audio는 standalone AUDIO만 선택한다.
- reference 출력이 OFF인 항목도 선택할 수 있다. 선택만으로 기존 출력 토글을 ON으로 바꾸지 않는다.
- VIDEO와 video-derived AUDIO는 Guide source 목록에 표시하지 않는다. Video의 ordinary V/VA/A 출력 정책은 별도로 유지한다.
- 같은 미디어를 여러 시점에 재사용할 수 있다.
- Guide 추가 직후 빈 행은 허용한다. 그러나 ON 상태의 빈 행은 실행 오류다.

### 4.4 편집과 삭제

- Start/End의 `없음` 선택은 해당 역할만 해제한다.
- Guide 삭제는 해당 행만 지운다. 원본 미디어는 남긴다.
- 원본 미디어 삭제 시 해당 ID를 쓰는 Start/End와 Guide 슬롯을 해제하고 안내한다. Guide의 반대 슬롯과 frame 값은 보존한다.
- Media Clear는 미디어와 모든 Timeline 할당을 함께 비운다. Prompt Clear는 Timeline을 유지한다.
- 위 변경은 기존 undo/redo 한 번으로 함께 되돌릴 수 있어야 한다.
- 외부 JSON에 존재하지 않는 ID가 있으면 정상 복원인 것처럼 자동 교체하지 않는다. 검증 오류로 거부한다.

### 4.5 프레임 입력

- 중간 Guide는 0 이상의 정수 프레임 번호를 저장한다. 0-based이며 `48 / 24 = 2.00초`다.
- 초는 읽기 전용 보조 정보다. 초 입력/왕복 반올림 기능은 후속 범위로 남긴다.
- 일반 Guide의 음수 입력은 이번 UI에서 허용하지 않는다. End만 의미적으로 마지막 위치를 나타낸다.
- H3의 출력 프레임 수 정렬과 Guide 위치는 다르다. Guide의 48을 `17k+5`로 반올림하지 않는다.
- 프레임 수 상한과 실제 범위 검사는 Wrapper의 출력 latent를 기준으로 서버에서 한다.

## 5. Reference와 Guide의 독립성

| 기존 reference 출력 | Timeline 사용 | 결과                                              |
| ------------------- | ------------- | ------------------------------------------------- |
| ON                  | 없음          | 기존 reference 출력과 Prompt 태그만 존재          |
| OFF                 | 있음          | Guide 전용. reference 목록/태그에는 들어가지 않음 |
| ON                  | 있음          | reference와 Guide 양쪽에서 사용                   |
| OFF                 | 없음          | 실행에 사용하지 않음                              |

예: 이미지 B의 reference 출력을 OFF로 하고 48f Guide로 선택했다면 B를 `references.images`에 추가하면 안 된다. Guide용 데이터는 별도로 전달한다. 그렇지 않으면 Picture 번호와 caption 정렬, 기존 Start/End 출력, LLM export가 모두 바뀐다.

기존 reference 출력 자체를 토글할 때 생기는 태그 변화는 기존 규칙을 따른다. Timeline 행을 추가하거나 이동하는 것만으로 Prompt 텍스트/태그가 바뀌면 실패다.

## 6. 저장 데이터 계약

### 6.1 저장 위치

`loader_state`에 선택적인 `h3Timeline` 필드를 추가한다. Prompt JSON 내부에는 넣지 않는다. 별도 상태 입력을 추가해 같은 값을 이중 저장하지 않는다.

기존 version 1 상태에서 필드가 없으면 아래 빈 값으로 해석한다. 새 필드 자체에도 `version: 1`을 두고 미지원 버전은 거부한다. 이는 새 코드가 구 워크플로우를 읽는 호환성이다. 구 코드가 새 Timeline을 실행할 수 있다는 의미는 아니다.

```json
{
  "h3Timeline": {
    "version": 1,
    "enabled": true,
    "startImageId": "image-a",
    "endImageId": "image-d",
    "guides": [
      {
        "id": "guide-uuid-1",
        "frameIndex": 48,
        "visualId": "image-b",
        "audioId": null
      },
      {
        "id": "guide-uuid-2",
        "frameIndex": 72,
        "visualId": null,
        "audioId": "video-a:audio"
      }
    ]
  }
}
```

빈 값: `enabled=false`, Start/End는 `null`, `guides=[]`.

필수 검증:

1. version과 enabled의 정확한 타입을 검사한다.
2. Guide ID는 비어 있지 않은 문자열이며 목록에서 유일해야 한다.
3. frameIndex는 정수다. Python에서는 `bool`을 정수로 받아들이지 않는다.
4. source ID의 존재와 매체 종류를 검사한다.
5. Guide `audioId`는 standalone AUDIO 원본이어야 한다. `video-id:audio`는 ordinary reference projection일 뿐 Guide source가 아니다.
6. 임의 파일 경로, 바이트, tensor, preview URL을 이 객체에 허용하지 않는다.
7. 제안 상한은 중간 Guide 32개다. H3 모델의 공식 제한이 아니라 UI/입력 크기를 제한하는 제품 정책이라고 문서화한다.
8. 저장 가능한 미완성 행과 실행 가능한 행을 구분한다. 타입/ID 검증은 항상 하고, 빈 슬롯·범위·충돌 같은 실행 검증은 ON일 때 한다.

### 6.2 Manifest, Snapshot, runtime

- Manifest에는 대응하는 `h3_timeline` 메타데이터를 저장한다. 기존 camelCase/snake_case 변환 관례를 따른다.
- `build_reference_manifest()`와 `parse_reference_manifest_state()`의 round-trip이 Timeline까지 보존해야 한다.
- Snapshot은 `loader_state`에 포함된 Timeline을 그대로 Save/Load한다. 별도 중복 키는 추가하지 않는다.
- UI 접힘은 frontend UI 속성으로 보관하고 실행 fingerprint에서는 제외한다.
- Bundle에는 기본값이 빈 매핑인 `guide_media` 필드를 제안한다. 예: `{ "image-b": IMAGE, "audio-a": AUDIO }`.
- Timeline 구성의 원본은 manifest/state 하나다. Bundle에 별도의 수정 가능한 Timeline 사본을 또 만들지 않는다.
- Bundle은 런타임 값이므로 `guide_media`에 tensor가 들어갈 수 있다. 이를 JSON으로 직렬화하면 안 된다.
- 모든 Bundle 생성 지점을 검색하여 새 필드가 사라지지 않게 한다. 특히 Options Override를 반드시 수정한다.

## 7. 미디어 로딩과 캐시

### 7.1 Guide 전용 미디어 로딩

현재 Loader는 활성 reference만 로딩한다. 이번 작업에서는 실제 필요한 집합을 다음처럼 계산한다.

```text
필요한 미디어 = 기존 활성 reference + ON인 Timeline이 참조하는 미디어
```

단, 결과는 reference 목록과 Guide 매핑으로 나눈다.

1. 기존 `build_reference_output_plan()` 결과를 보존한다.
2. ON인 Timeline의 ID를 모아 중복 제거한다.
3. reference로 이미 로딩한 같은 ID/같은 설정 값은 재사용한다.
4. 나머지 Guide 전용 ID를 기존 안전한 미디어 로딩 경로로 로딩한다.
5. reference tuple과 caption tuple에는 Guide 전용 항목을 넣지 않는다.
6. IMAGE 편집/회전/alpha/pixel limit, VIDEO/AUDIO trim은 기존 설정을 적용한다.
7. VIDEO의 VA 토글과 파생 AUDIO의 A 토글은 기존 reference 경로 의미를 유지한다. Guide는 standalone AUDIO만 명시적으로 고를 수 있으며 reference A가 OFF여도 로딩한다.

`ReferenceState`의 사용자 enabled 값을 임시로 수정한 상태를 manifest나 Prompt에 다시 저장하지 않는다. 필요한 ID를 명시적으로 전달하는 로더 확장 또는 제한된 내부 projection을 사용한다.

### 7.2 소스 검증과 메모리

- Guide-only 소스도 queue fingerprint 검사와 실제 로딩에서 파일 크기, hash, 경로 포함관계, link/junction, mask 의존성을 검증한다.
- 현재 파일/디코딩 크기 제한을 유지한다. Guide용 별도 호출로 aggregate 메모리 제한을 우회하지 않는다.
- 동일 tensor를 여러 Guide가 참조할 때 메모리 사용량을 중복 합산하지 않도록 하되, 새로 생성한 데이터는 계산한다.
- OFF Timeline 때문에 비활성 파일을 디코딩하거나 VAE를 로딩하지 않는다.

### 7.3 Fingerprint와 Prompt Cache

- Timeline ON/OFF, media ID, frame 변경 및 사용 중인 소스 변경은 H3 실행 캐시를 무효화해야 한다.
- Guide-only 파일이 외부에서 변경되어도 소스 검증을 건너뛰지 않는다.
- UI 접힘, 미리보기, 카드 표시 설정은 결과를 바꾸지 않는다.
- OFF일 때 설정을 보존하는 metadata 때문에 Loader의 fingerprint가 변하는 것은 허용한다. 최적화보다 bundle 상태가 최신인 것이 우선이다.
- 현재 `reference_fingerprint`를 쓰는 Prompt Cache도 Timeline 변경으로 갱신될 수 있다. 1차에서는 이를 보수적인 동작으로 허용하고 문서화한다. Guide 이동마다 LLM 결과가 반드시 달라진다는 의미는 아니다.
- 새로운 prompt 전용 hash 체계를 이번 기능에 끼워 넣지 않는다.

### 7.4 Options Override

이미지 limit/alpha 설정을 Override하면 Guide IMAGE도 동일 설정으로 다시 구성되어야 한다. Guide AUDIO와 Timeline 메타데이터는 보존한다. 기존 reference IMAGE만 다시 로딩하고 Guide IMAGE를 예전 설정으로 남기면 실패다.

## 8. H3 Wrapper 실행 설계

### 8.1 기본 경로

Timeline OFF 또는 ON이지만 Start/End/Guide가 모두 없는 경우 기존 R2V 위임 경로를 유지한다. 빈 Guide 행이 있는 경우는 빈 Timeline과 다르며 실행 오류다.

Timeline ON이며 항목이 있으면 다음 순서로 처리한다.

```text
Reference bundle 검증
  → 기존 reference 입력과 Audio 태그 매핑 생성
  → native MiniMaxH3ReferenceToVideo 실행
  → positive와 AV latent 추출
  → latent에서 실제 출력 길이 확인 및 Timeline 실행 계획 검증
  → native MiniMaxH3AddGuide를 각 항목에 적용
  → 최종 positive + 처음 만든 AV latent 반환
```

위 순서는 개념적이다. 미디어 누락/타입/필요 VAE 검사는 가능한 한 비싼 CLIP/VAE 실행 전에 수행한다. 출력 길이 계산도 설치된 공식 함수로 사전 확인할 수 있으면 먼저 검증하고 실제 latent와 일치하는지 확인한다.

실제 `NodeOutput`의 결과 접근법은 설치된 ComfyUI API와 기존 테스트 fixture를 확인해서 쓴다. `.result`나 배열 unpack이 된다고 추측하지 않는다.

### 8.2 위치 계산

- Start: `frame_idx=0`.
- End: 공식 Add Guide의 지원이 확인되면 `frame_idx=-1`을 전달한다.
- 일반 Guide: 저장된 frameIndex를 전달한다.
- UI의 입력 `length`는 유효 프레임 수로 정렬될 수 있다. 항상 실제 AV latent 또는 공식 temporal helper의 결과로 `F`를 얻는다.
- 예: 실제 F가 124이면 마지막 위치는 123이다. `length=120`을 곧바로 마지막 위치 119로 쓰지 않는다.
- 순회는 실제 시작 위치 기준으로 정렬하며 같은 위치의 다른 종류 항목은 stable ID로 순서를 고정한다.

### 8.3 VIDEO와 AUDIO

- 이미지 한 장은 한 위치의 visual guide다.
- AUDIO는 공식 Add Guide의 남은 길이 crop 동작을 재사용한다. UI/문서에서 crop 가능성을 안내한다.

### 8.4 VAE와 기능 검사

- Visual Guide가 있으면 video VAE가 필요하다.
- Audio Guide가 있으면 audio VAE가 필요하다.
- Optional schema를 복사했더라도 Wrapper `execute()`에 기본값이 없으면 연결 생략 시 실패할 수 있다. 현재 시그니처를 검사하고 `vae=None`, `audio_vae=None`을 안전한 키워드 인수 위치에 둔다.
- Guide가 필요할 때 `MiniMaxH3AddGuide`가 없으면 업데이트가 필요하다는 오류를 낸다.
- OFF인 기존 워크플로우가 Add Guide 부재 때문에 실패하지 않게 한다.
- 일반 Loader 등록 시 H3 내부 모듈을 새로 강제 import하지 않는다.

## 9. 반드시 먼저 해결할 H3 호환성 게이트

외부 Hybrid 노드는 `MiniMaxH3.extra_conds`에 runtime patch를 설치한다. 이것은 단순 UI 구현과 별개로 확인해야 할 부분이다.

확인 순서:

1. 실제 테스트할 ComfyUI commit을 기록한다.
2. `comfy_extras/nodes_minimax_h3.py`의 R2V와 Add Guide 구현을 읽는다.
3. `comfy/model_base.py`의 MiniMaxH3 `extra_conds`가 keyframe과 reference의 visual/audio latent를 어떻게 모으는지 읽는다.
4. `comfy/ldm/minimax/model.py`의 PackedLayout 순서와 비교한다.
5. image Guide + image reference와 audio-only Guide + audio reference를 테스트하고, VIDEO/video-derived AUDIO에는 Guide UI가 없음을 확인한다.
6. 이미 올바르게 병합하면 공식 API 조합을 사용한다.
7. 잘못 병합하면 원인, 필요한 upstream revision, 재현 fixture를 문서화한다. 지원 가능한 upstream 버전을 최소 조건으로 삼는다.

외부 patch는 keyframe마다 `latent`가 있다고 가정하고 오디오를 reference에서만 모으므로 audio-only Guide까지 안전하다고 가정해서는 안 된다. 현재 모델의 latent 정규화 등 전처리를 덮어쓰는지도 확인해야 한다.

**이 계획의 기본안은 프로세스 전역 monkey patch를 추가하지 않는 것이다.** 지원 가능한 공식 버전이 확인되지 않으면 UI/계약 작업은 진행할 수 있지만 Hybrid 실행 완료로 표시하지 않는다. 별도 patch가 필요한 것으로 결론 나면 해당 변경 범위를 따로 검토한다.

## 10. 충돌 정책

무조건 같은 frame 숫자만 비교하는 방식으로는 부족하다. 영상/오디오는 길이가 있기 때문이다.

제안 정책:

- visual 조건끼리 실제 시간 범위가 겹치면 오류.
- audio 조건끼리 실제 시간 범위가 겹치면 오류.
- 같은 위치에 visual 하나와 audio 하나는 허용.
- 한 Guide 행에 Visual+Audio를 함께 선택하는 것을 기본 사용법으로 안내.
- Start/End도 visual 충돌 검사에 포함.
- 같은 이미지를 서로 다른 위치에 재사용하는 것은 허용.

visual 구간은 `[start, start + 유효 프레임 수)`로 비교한다. 단일 이미지는 길이 1이다. 오디오는 VAE/공식 코드가 사용하는 시간축과 crop 후 실제 길이에 맞춰 비교한다. 오디오 sample 수를 video frame 수로 그대로 비교하지 않는다. 반올림으로 경계가 달라지는 경우 공식 시간 변환과 일치시킨다.

예:

- Start + visual Guide 0f: 오류.
- Start + audio-only Guide 0f: 허용.
- F=124, End + visual Guide 123f: 오류.
- 48f의 visual Guide와 48f의 audio Guide: 허용.

브라우저는 알려진 충돌을 즉시 표시한다. 최종 길이와 latent 시간축은 서버만 확정할 수 있으므로 서버 검증을 생략하지 않는다. 자동 덮어쓰기/자동 병합은 하지 않는다.

## 11. 화면 구현 경계

Media-owned `ReferenceLoaderController` markup과 `h3-media-guides.ts` 순수 helper를 사용한다. 저장 값은 Loader reducer를 통해 변경하고 별도 컴포넌트에 영속 state를 만들지 않는다.

H3 영역 배치는 `loader.ts`의 실제 Media DOM과 기존 widget 연결을 기준으로 구현한다. 별도 표시용 DOM widget으로 만들 경우 JSON을 또 저장하지 말고 Loader state를 구독하는 view로 둔다. widget 생성을 위해 별도 native input이 꼭 필요한지는 현재 API에서 확인하고, input이 필요하면 UI-only임을 명확히 한다.

현재 레이아웃은 Media와 Prompt 두 영역의 높이에 맞춰져 있다. Timeline을 추가할 때:

1. Legacy Canvas의 minimum size 계산에 펼친 패널 높이를 반영한다.
2. Nodes 2.0의 grid를 실제 widget 행 수에 맞춰 수정한다. 개념적으로 Media는 내용 높이, Prompt는 남은 높이, Timeline은 내용 높이다.
3. 순서에 의존하는 고정 CSS가 unrelated native widget 행까지 바꾸지 않게 한다.
4. 패널을 펼쳐도 Prompt 입력 영역이 0 높이가 되거나 겹치지 않게 한다.
5. Ctrl+Z, 노드 재생성, workflow restore 후 구독과 DOM을 복원한다.
6. `onRemoved`에서 구독과 listener를 정리한다.
7. `<button>`, `<select>`, 숫자 input의 label, focus, keyboard 접근을 제공한다.
8. 기존 카드 스타일 수정과 동작을 유지한다.

계획 작성 당시 worktree에는 loader/reducer/stylesheet와 관련 테스트의 사용자 수정이 있었다. 구현 시 `git status --short`와 해당 diff를 먼저 읽고 파일 전체 교체나 되돌리기를 하지 않는다.

## 12. 구현 작업 순서와 단계별 완료 조건

### 단계 0 — 현재 코드와 공식 API 확인

작업:

1. `AGENTS.md`, 이 문서, `docs/ARCHITECTURE.md`, `docs/TESTING.md`를 읽는다.
2. git status와 기존 수정 파일 diff를 확인한다.
3. 3절 파일과 기존 H3 wrapper 테스트를 읽는다.
4. 9절의 공식 API/혼합 payload 게이트를 확인한다.
5. ComfyUI 버전, 검증된 호출 방법, 알려진 차이를 작업 기록에 남긴다.

완료 조건: 지원할 공식 경로와 미검증 범위가 명시되어 있다. 데이터 구조를 추측한 monkey patch가 없다.

### 단계 1 — 상태 계약과 reducer

작업:

1. FE `H3TimelineState`, `H3GuideEntry` 타입과 기본값을 추가한다.
2. FE validation/serialization/execution projection에 필드를 연결한다.
3. Python 상태 타입과 parser에 같은 규칙을 구현한다.
4. toggle, Start/End 선택, Guide 추가/편집/삭제 reducer action을 만든다.
5. 미디어 삭제/Clear와 Timeline 슬롯 해제를 같은 history 작업으로 연결한다.
6. 기존 state/Snapshot이 빈 Timeline으로 복원되는 테스트를 추가한다.

완료 조건: UI 없이도 상태 round-trip, invalid ID/type 거부, undo/redo를 테스트로 증명한다.

### 단계 2 — Manifest, 로딩, Bundle

작업:

1. Manifest 생성/역변환에 Timeline 메타데이터를 추가한다.
2. ON Timeline의 필요한 media ID 집합을 계산한다.
3. 기존 source 검증/로딩을 확장하여 Guide-only 미디어를 읽는다.
4. Bundle에 `guide_media`를 추가하고 정합성을 검사한다.
5. 기존 reference 배열과 caption 개수가 변하지 않는지 확인한다.
6. Options Override와 모든 Bundle 생성 호출을 갱신한다.
7. fingerprint와 Prompt Cache 영향 테스트를 추가한다.

완료 조건: reference OFF인 미디어가 Guide로 로딩되고 Prompt/export에는 들어가지 않는다. 경로 및 aggregate 메모리 제한을 동일하게 적용한다.

### 단계 3 — H3 실행 연결

작업:

1. Wrapper에서 Timeline 메타데이터와 Guide media를 읽는다.
2. VAE/기능 검사를 추가하고 optional execute signature를 맞춘다.
3. 기존 R2V 호출 결과에 공식 Add Guide를 순서대로 적용한다.
4. 실제 길이, VIDEO 유효 길이, 오디오 crop, 충돌 정책을 적용한다.
5. 예외 메시지에 Guide 행/미디어 이름/요청 위치/허용 범위를 포함한다. 절대 파일 경로는 노출하지 않는다.
6. 입력 conditioning을 in-place 변경해 다른 branch가 오염되지 않는지 확인한다.

완료 조건: native API fake를 사용한 routing 테스트와 설치된 ComfyUI의 실제 payload 검사가 모두 통과한다. fake 통과만으로 모델 호환성 완료를 선언하지 않는다.

### 단계 4 — Prompt 아래 패널

작업:

1. 4절 wireframe의 접이식 패널을 만든다.
2. native select/number input으로 media ID와 위치를 편집한다.
3. disabled reference 선택, 미완성 행, 오류 표시를 연결한다.
4. Loader state 변경을 구독해 filename/삭제/undo에 대응한다.
5. 두 Canvas의 높이와 복원 lifecycle을 수정한다.
6. Snapshot, preset 전환, 접힘/ON 상태 저장을 확인한다.

완료 조건: 키보드로 모든 값을 설정할 수 있고, Prompt 아래 위치와 간격이 두 Canvas에서 유지된다.

### 단계 5 — 회귀 검사, 문서, 실제 생성

작업:

1. 아래 검증표와 저장소 명령을 실행한다.
2. 지원 버전의 H3에서 짧은 생성 테스트를 수행한다.
3. README, `docs/REFERENCE_LOADER.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`를 갱신한다.
4. runtime 검증이 불가능하면 환경/모델 미제공 등 구체적인 이유와 남은 테스트를 기록한다.

완료 조건: 구현/자동 검사/실제 생성의 완료 여부가 구분되어 있으며 사용자가 재현할 수 있는 예제가 있다.

## 13. 테스트 표

기존 테스트 파일에 관련 사례를 추가하고 새로운 계약/패널은 전용 테스트 파일을 만든다. 단순 필드 존재 검사만으로 끝내지 않는다.

| 사례                                           | 기대 결과                                           |
| ---------------------------------------------- | --------------------------------------------------- |
| 구 version 1 Loader/Snapshot                   | 빈 OFF Timeline으로 복원                            |
| OFF Timeline의 값 변경                         | 값 보존, Guide 실행/디코딩 없음                     |
| ref OFF 이미지 + 48f Guide                     | Guide만 로딩, Picture 번호 불변                     |
| ref ON 이미지 + 48f Guide                      | 양쪽 사용, reference 중복 추가 없음                 |
| 같은 이미지 24f/72f                            | 두 위치에 전달, 소스 데이터 중복 로딩 최소화        |
| Start+End+중간 이미지+오디오                   | 각 위치와 종류가 정확히 전달                        |
| raw Prompt와 structured Prompt                 | Timeline 변경으로 텍스트/태그 불변                  |
| 비디오 reference soundtrack와 standalone audio | 기존 Audio remap 결과 유지                          |
| video-derived Guide audio, A OFF               | contract에서 거부, 일반 reference audio 경로는 유지 |
| 사운드 없는 VIDEO의 audio ID                   | 설명 가능한 서버 오류                               |
| 입력 length가 정렬되는 경우                    | End가 실제 마지막 프레임에 적용                     |
| visual 같은 시점 충돌                          | 오류, 자동 덮어쓰기 없음                            |
| visual+audio 같은 시점                         | 허용                                                |
| Video/video-derived Audio Guide                | UI와 contract에서 source로 제외                     |
| audio-only Guide + refs                        | KeyError/latent 누락 없이 혼합                      |
| guide-only 파일 hash 변경                      | cache hit로 통과하지 않고 검증 실패                 |
| Preview 설정 변경                              | Guide 실행 의미 불변                                |
| Options Override                               | Guide 이미지에도 설정 반영, Audio 보존              |
| 삭제→Undo→Redo                                 | 미디어와 Timeline 연결이 원자적으로 복원            |
| 미지원 Add Guide + Timeline OFF                | 기존 R2V 사용 가능                                  |
| 미지원 Add Guide + ON 사용                     | 친절한 기능 미지원 오류                             |
| prompt preset 변경                             | Timeline 값과 enabled 유지                          |
| 동일 bundle의 별도 branch                      | conditioning/state mutation 누수 없음               |
| H3 없는 환경의 일반 Loader                     | 새 import 의존성으로 등록 실패하지 않음             |
| Load Reference Image                           | 기존 화면/IMAGE/MASK 계약 유지                      |

### 13.1 자동 검사 명령

프로젝트 루트에서 실행한다. 의존성이 준비되어 있으면 불필요하게 재설치하지 않는다.

```powershell
bun run typecheck
bun run test:unit
bun run fmt:check
bun run lint
bun run build
git diff --check
```

배포 archive까지 검증하는 단계에서는 추가로 실행한다.

```powershell
bun run release:check
bun run build:custom-node
```

부분 실행 예:

```powershell
bun test --preload ./frontend/test/setup.ts frontend/test/reference-loader-state.test.ts
uv run pytest tests/backend/test_minimax_h3_reference_wrapper.py -q
```

Python은 `uv`를 사용한다. Windows cache/temp 권한 오류는 코드 오류와 구분하고 저장소 내부의 writable cache/temp를 지정한다. 기존 사용자 cache나 광범위한 폴더를 삭제하지 않는다. 종료 코드와 skip 사유를 기록한다.

### 13.2 수동 확인

1. Nodes 2.0과 Legacy Canvas 각각에서 패널을 펼치고 노드 크기를 바꾼다.
2. 이미지 4개, VIDEO 1개, AUDIO 1개를 등록한다.
3. 한 이미지는 reference ON, 나머지는 OFF로 두고 Start/End/48f Guide로 고른다.
4. 72f AUDIO Guide를 추가한다.
5. 저장/새로고침/Snapshot/Undo 후 동일 ID와 frame이 복원되는지 확인한다.
6. 기존 Media Outputs와 Raw Prompt를 비교해 Guide-only 항목이 추가되지 않았는지 확인한다.
7. H3 Wrapper로 queue하고 resolved frame과 payload 구성을 확인한다.
8. 같은 seed와 설정에서 Guide OFF/ON을 비교한다. 입력 픽셀과의 정확한 일치를 합격 기준으로 삼지 않는다.
9. 시각 Guide, audio-only Guide, reference+Guide 혼합을 각각 실행한다.
10. 사용한 ComfyUI commit/checkpoint와 오류 유무, 실제 conditioning 전달 증거를 기록한다.

## 14. 이번 범위에서 제외

- LLM이 Guide 위치를 자동 생성하는 기능.
- Guide를 Prompt 문장이나 새로운 Picture/Audio 태그로 자동 변환.
- 카드에 하나의 배타적인 역할만 부여하는 방식.
- 모델 checkpoint 자동 선택/혼합, weight merge, Sigma Shift 노드 복제.
- 새 업로드/디코더/FFmpeg 경로 설정 시스템.
- 파형 믹싱, 크로스페이드, 결과 프레임/오디오 직접 붙여넣기.
- 화면에 초 입력과 프레임 입력을 동시에 editable로 제공.
- 전용 시간 ruler/드래그 캔버스 및 새 UI 라이브러리.
- 전역 H3 monkey patch의 무검증 이식.
- 기존 Start/End Frames 노드의 모드/출력 변경.

## 15. 개발 완료 보고 템플릿

```text
구현한 기능:
-

핵심 변경 파일:
-

기존 workflow 호환성:
- Timeline OFF 회귀 결과
- Guide-only 미디어와 Prompt/reference 분리 결과

자동 검사:
- 명령 / 종료 코드 / 결과

실제 H3 검증:
- ComfyUI commit:
- checkpoint:
- image/audio guide 사례:
- reference + guide payload 혼합:

미완료 및 재현 방법:
-
```

UI만 구현했거나 mock 테스트만 통과했다면 그대로 적는다. payload가 생성되었다는 사실과 모델이 기대한 시각/오디오 결과를 냈다는 사실을 구분한다.

## 16. 근거와 구현 시 재확인할 공식 소스

- [외부 Hybrid Cond 저장소](https://github.com/kitsune123150/minimax-h3-hybrid-cond): reference와 keyframe을 함께 다루는 출발점.
- [외부 payload patch](https://github.com/kitsune123150/minimax-h3-hybrid-cond/blob/main/model_base_patch.py): 그대로 이식하지 말고 설치된 core와 비교할 대상.
- [공식 H3 노드 구현](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py): Add Guide 실행, 시간 위치, VAE 조건 및 R2V 위임 계약. 2026-09-07 웹 확인 기준.
- [공식 model_base](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/model_base.py): 구현 시작 전 실제 설치 commit에서 extra_conds 혼합 순서와 전처리를 확인할 대상.
- [공식 H3 model](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/ldm/minimax/model.py): PackedLayout과 visual/audio 시간축을 확인할 대상.
- [공식 tokenizer](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/minimax.py): Guide와 reference의 text/vision 입력 차이를 확인할 대상.

웹의 master 링크는 변한다. 구현 시작 시 테스트 대상 commit 링크로 작업 기록을 남긴다. 이 문서는 실제 설치 환경의 Hybrid 호환성이나 생성 품질을 검증한 결과가 아니다.
