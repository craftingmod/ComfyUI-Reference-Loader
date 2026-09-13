# Reference Loader — Media와 H3 Guide 통합 추가 개발 계획

작성일: 2026-09-07. 대상: 현재 작업 트리의 Timeline Guides 구현 위에 이어서 개발할 구현 에이전트.

이 문서는 구현 기준과 완료 기록이다. 아래 계획에 따라 Media 통합 UI와 frontend 계약을 구현했으며, 실제 ComfyUI 화면 조작이나 모델 생성 검증은 이 작업에서 수행하지 않았다.

> 구현 상태 (2026-09-07): 단계 1–4의 Media-owned editor, 역할 배지/요약, 원자적 reducer action, source 선택, incomplete Guide 복구/삭제, 기존 Prompt Timeline mount 제거를 완료했다. 기존 backend Timeline/manifest/bundle/Wrapper 경계를 유지하면서 Guide source를 Image와 standalone Audio로 제한했고, 기존 테스트로 회귀를 확인했다. 단계 5의 실제 H3 checkpoint 생성과 두 Canvas 수동 검증은 미완료다.

## 1. 목표와 기존 계획과의 관계

사용자는 첫 번째 **Media** 영역 안에서 이미지와 오디오를 확인하면서 가이드를 추가·편집·삭제하고, 어떤 미디어가 첫 프레임·마지막 프레임·특정 프레임에 배치됐는지 한눈에 확인하려 한다. 한 이미지는 **레퍼런스만 / 가이드만 / 둘 다** 사용할 수 있어야 한다.

권장 구현은 **기존 Media 카드 + 상단 배치 요약 + 선택한 카드의 가이드 편집 영역**이다. 별도 파일명 선택 패널을 위로 옮기는 것만으로 완료하지 않는다. 썸네일, 파형, 재생, 이미지 편집, 트림을 기존 Media 기능에서 사용한다.

`docs/H3_TIMELINE_GUIDES_IMPLEMENTATION_PLAN.md`의 데이터 계약과 backend 실행 경계는 유지한다. 그 문서의 4절 화면 제안, 11절 화면 구현 경계, 단계 4의 “Prompt 아래 패널” 및 관련 수동 검증은 **이 문서의 UI 계획으로 대체**한다. 기존 문서의 native H3 호환성·실제 생성 미검증 사항은 이 UI 작업으로 해결됐다고 간주하지 않는다.

### 완료 판단의 핵심

1. Prompt 아래 독립 Timeline Guides 패널이 없다.
2. Media에서 Start/End/특정 프레임과 연결 미디어를 시각적으로 확인한다.
3. Media 카드에서 가이드 전용·레퍼런스 전용·겸용을 설정한다.
4. 이미지 보기, 오디오 듣기, 가이드 편집을 오가는 동안 대상이 명확하다.
5. 기존 Timeline workflow를 열면 같은 미디어 ID와 frame 값으로 새 UI가 복원된다.
6. Guide-only 미디어는 일반 reference 배열·caption 배열·Prompt 태그에 추가되지 않는다.

## 2. 현재 구현에서 확인한 사항

경로는 저장소 루트 기준이며 줄 번호는 작성 당시 위치다. 구현 시 심볼을 다시 검색한다.

| 위치                                                                                               | 확인한 구현                                                           | 개발 의미                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `frontend/src/reference-loader/components/loader.ts`의 `#h3Markup`/`#h3EditorMarkup`               | 접이식 H3 패널과 Media 카드별 편집기를 함께 렌더링                    | 썸네일·파형·재생이 있는 Media 흐름 안에서 Guide를 고름            |
| `frontend/src/reference-loader/extension.ts`의 widget 연결 경로                                    | H3 UI를 별도 Prompt DOM에 mount하지 않음                              | 단순 CSS 이동이나 독립 controller를 만들지 않음                   |
| `components/loader.ts`의 `render`                                                                  | Media 헤더·H3 영역·세 channel을 `root.innerHTML`로 재생성             | 하위 controller를 한 번 append하면 다음 render에서 사라질 수 있음 |
| `components/loader.ts`의 `#cardMarkup`                                                             | 썸네일, 파형, I/V/VA/A, 재생, 캡션, 편집이 이미 있음                  | 새 미디어 브라우저·플레이어를 만들 필요 없음                      |
| `styles/cards.css:69`                                                                              | reference 출력 OFF이면 이미지·비디오·파형에 grayscale/brightness 적용 | guide-only가 사용 중이어도 비활성처럼 보임                        |
| `types.ts:8`의 `H3GuideEntry`, `H3TimelineState`                                                   | stable ID와 `visualId`, `audioId`, Start/End ID가 이미 분리됨         | 카드 역할은 파생값으로 계산 가능. 새 영속 `usage` 필드 불필요     |
| `reducer.ts:94`의 `clearTimelineReferences`                                                        | 삭제한 media 연결을 null로 바꾸고 guide 행은 보존                     | 미완성 행을 새 화면에서도 발견·복구할 수 있어야 함                |
| `components/loader.ts:1983`의 `#dispatch`                                                          | action마다 history commit                                             | 역할 변경을 여러 dispatch로 구현하면 Undo가 중간 상태를 복원함    |
| `validation.ts`의 `sanitizeH3Timeline`                                                             | 구 상태 기본값, ID/type 검사, 최대 32개 Guide                         | 이번 UI 때문에 version을 바꾸거나 parser를 복제하지 않음          |
| `backend/nodes/minimax_h3_reference_wrapper.py`의 `_timeline_entries`, `_validate_timeline_ranges` | 실제 출력 길이, visual/audio별 겹침 검사, native Guide 호출 경로 존재 | FE는 알려진 오류 안내를 추가하고 최종 판정은 서버에 유지          |

현재 git status에는 Timeline 관련 파일을 포함한 다수의 수정과 미추적 파일이 있다. 시작 시 `git status --short`와 관련 diff를 읽고 기존 수정을 보존한다. 계획에 등장하는 파일이 HEAD와 다르다고 되돌리거나 전체 교체하지 않는다.

## 3. 권장 화면 구성

```text
Media                                      Add  Undo  Redo  Clear  Snapshot
미디어 6개 · 레퍼런스 2개 · 가이드 배치 4개

H3 Guides [ON]                               [Disable]
[첫 프레임 · 작은 이미지] [48f · 이미지+오디오] [마지막 · 작은 이미지]
                                              [전체 배치 보기: 4]

Images
┌ 기존 이미지 카드 ─────────┐  ┌ 기존 이미지 카드 ─────────┐
│ 실제 썸네일               │  │ 실제 썸네일               │
│ Reference  / 48f · [I][G] │  │ Start / End · [I][G]     │
│ 기존 캡션·편집·정렬 · I✎ G✎│  │ 기존 캡션·편집·정렬 · I✎ G✎│
└───────────────────────────┘  └───────────────────────────┘

선택한 이미지: scene.png                    [Guide editor · Cancel]
Start [✓]  End [ ]
Guide 1: 출력 프레임 [72] · 3.00초 · 24fps
Visual [scene.png]  Audio [voice.wav]         [Delete]
                                           [Apply]

Videos … 기존 미리보기·트림·V/VA … (Guide controls 없음)
Audio  … 기존 파형·재생·트림·A/G, I✎/G✎ …

Prompt … 기존 Prompt UI …
```

이 와이어프레임의 버튼명은 의미를 설명하기 위한 한글이다. 제품의 기존 영문 UI에 맞춰 `Reference only`, `Guide only`, `Both`, `Unused`, `Start`, `End`, `At frame…`, `Apply`, `Cancel`로 일관되게 작성한다.

### 3.1 상단 배치 요약

- Media toolbar 다음, 미디어 channel들 전에 둔다. 가이드 요약은 편집 영역을 접어도 남긴다.
- Start와 End에는 실제 작은 썸네일을 사용한다. 특정 프레임은 `48f · 2.00s`와 visual 썸네일/Audio 표시를 보여준다. 오디오에는 기존 파형을 활용할 수 있는 크기에서 파형을 쓰고, 좁은 요약 배지는 Audio 아이콘과 파일명으로 충분하다.
- 배치 클릭 시 연결된 원래 Media 카드를 강조·스크롤하고 편집기를 연다. visual+audio 행은 양쪽 대상이 구분된다.
- 순서는 Start → frameIndex 오름차순 Guide → End. 정렬은 표시용 복사본에만 적용하고 `guides` 저장 순서나 reference order를 수정하지 않는다. 같은 frame은 원래 배열 순서를 유지한다.
- End는 `End / 마지막 프레임`으로 표시한다. Loader에는 실제 생성 길이가 확정되지 않으므로 `119f`처럼 임의로 계산하지 않는다.
- 많은 항목은 상단에 Start/End와 일반 Guide 일부를 표시하고 `전체 배치 보기 N`으로 펼친다. 펼친 목록은 Media 내부의 줄바꿈 목록이며 새 시간축 canvas나 강제 가로 스크롤을 만들지 않는다.
- 미완성 행은 연결 카드가 없어도 상단에 `48f · 미디어 필요`로 나타나며 선택·복구·삭제할 수 있다.
- count는 뜻을 분리한다. 미디어 수=items 수, 레퍼런스 수=활성 reference channel 수, 배치 수=지정된 Start/End 수+guides.length. video+audio reference는 두 channel로 집계됨을 tooltip에 설명한다. 미완성 행 수는 별도 표시한다.

### 3.2 카드 표시

- 썸네일 아래 전용 역할 줄에 `Reference`, `Start`, `End`, `48f` 같은 텍스트 배지를 둔다. 기존 output `#N`과 겹치지 않게 한다.
- 가이드가 많으면 처음 두 배지와 `+N`으로 축약하고 클릭 시 전체 배치를 편집한다. stable ID를 사용자 제목으로 노출하지 않는다.
- 이미지·파형은 guide-only에서도 정상 밝기로 보여준다. `reference OFF`와 `아무 용도로도 사용 안 함`을 CSS에서 구별한다.
- 전체 Timeline OFF일 때도 저장된 역할과 정상 미리보기는 유지하고 배지에 `Paused`를 표시한다. 사용 모드가 바뀐 것처럼 보이면 안 된다.
- 같은 파일명의 서로 다른 item은 썸네일·kind·기존 identity 시각 표시로 구분한다. 출력 번호를 identity로 저장하지 않는다.
- 카드 하나에 전체 Guide 폼을 반복하지 않는다. 선택한 대상의 편집 영역 한 개만 해당 channel 아래에 렌더한다.

### 3.3 기존 미디어를 보면서 지정하는 흐름

1. 이미지 카드를 보고 `Guides`를 누른다. 해당 카드 아래 편집 영역이 열리고 카드가 강조된다.
2. 사용 모드를 선택하고 Start/End/특정 프레임을 지정한다.
3. 특정 프레임은 생성 결과에 삽입할 **출력 프레임**을 입력한다. 0-based이며 0이 첫 프레임이다.
4. 오디오를 함께 사용할 경우 `오디오 선택`을 누른다. 기존 Audio channel의 호환 카드에 `이 오디오 사용` 버튼이 나타난다. 사용자는 기존 재생 버튼으로 듣고 선택한다.
5. 카드 본문 클릭은 기존 선택 동작을 유지한다. 선택 모드에서만 명시적인 `사용` 버튼으로 연결한다. 재생·편집·업로드 버튼 클릭을 source 선택으로 오인하지 않는다.
6. Apply 한 번으로 commit한다. Cancel/Escape는 원래 상태를 유지하고 호출한 버튼으로 focus를 돌린다.

Image 또는 standalone Audio 카드의 G/G-pencil이 같은 편집기를 연다. G를 처음 켜면 해당 source를 가진 draft를 만들고, 기존 Guide를 편집할 때는 paired source와 Start/End 값을 함께 보존한다. **저장된 빈 Guide 행을 새로 만들지 않는다.** 입력 중 상태는 임시 draft로 보관한다.

## 4. 사용 모드와 역할의 정확한 의미

### 4.1 이미지의 세 가지 요청 모드 + 기존 미사용 상태

`R = imageEnabled`, `G = Start/End/일반 Guide 중 해당 이미지 연결이 하나 이상 있음`으로 계산한다. G 계산에는 `timeline.enabled`를 섞지 않는다.

| 화면 모드      | R     | G     | Apply 결과                                            |
| -------------- | ----- | ----- | ----------------------------------------------------- |
| Reference only | true  | false | 이미지의 모든 가이드 연결을 해제하고 reference 활성화 |
| Guide only     | false | true  | 적어도 한 배치를 지정하고 reference 비활성화          |
| Both           | true  | true  | 적어도 한 배치를 지정하고 reference 활성화            |
| Unused         | false | false | reference 비활성화 및 해당 이미지의 모든 배치 해제    |

미사용은 기존 업로드·disabled workflow를 손실 없이 표현하기 위해 필요하다. 사용자 요청의 세 모드를 모두 제공하되 기존 네 번째 상태를 거짓으로 분류하지 않는다.

- Guide only/Both를 고르고 배치가 없으면 Apply를 비활성화하며 배치 지정을 요청한다. 임의 frame 0을 저장하지 않는다.
- Reference only/Unused로 바꿀 때 적용 전에 `Start와 2개 프레임 배치를 해제합니다`를 편집 영역에 표시한다. 별도 반복 확인 dialog 대신 이 Apply가 확정 단계다.
- Start/End는 한 이미지에 동시에 지정할 수 있고, 같은 이미지를 여러 일반 frame에서 재사용할 수 있다. 단일 `role: start|end|guide` enum을 영속 상태에 추가하지 않는다.
- 이미 다른 이미지가 Start/End를 점유하면 현재 썸네일과 교체 대상을 보여준다. Apply로 해당 슬롯만 교체하며 이전 이미지의 reference flag와 다른 배치는 유지한다.
- Guide 전체 OFF는 실행을 일시 중지할 뿐 배치를 삭제하지 않는다. OFF에서도 draft를 편집할 수 있다. Apply는 OFF를 유지하고 `저장됨 · Guides OFF`를 표시한다. 활성화는 상단 ON toggle의 명시적 동작이다.

### 4.2 영상과 오디오의 channel 경계

| 대상                 | 일반 reference flag | 가이드 ID                 | 가능한 배치          |
| -------------------- | ------------------- | ------------------------- | -------------------- |
| 이미지               | `imageEnabled`      | item.id를 visualId로 사용 | Start/End/특정 frame |
| 영상 시각 채널       | `videoEnabled`      | Guide source 아님         | 없음                 |
| 독립 오디오          | `audioEnabled`      | item.id를 audioId로 사용  | 특정 frame           |
| 영상에서 나온 오디오 | `audioEnabled`      | Guide source 아님         | 없음                 |

- VIDEO 카드와 Audio board에 나타난 video-derived Audio는 일반 V/VA/A 출력에는 남기되 Guide 대상에서 제외한다. Guide 배지와 G-pencil은 standalone Image/Audio 카드에만 표시한다.
- 영상의 `videoAudioEnabled`(VA)는 영상 컨테이너의 소리 정책이다. Guide 지정이나 사용 모드 변경으로 이를 변경하지 않는다. A와 VA를 합치지 않는다.
- 영상 카드에서 Guide only를 선택해도 Audio board의 reference A를 자동으로 끄지 않는다. 문구에 `Visual usage` / `Audio usage`를 사용한다.
- 영상 시각 가이드 선택이 audioId를 자동 추가하지 않게 한다. 소리도 가이드로 사용할 때는 Audio 카드를 별도로 지정한다.
- Video 및 video-derived Audio는 Guide source 선택지 자체에서 제외한다. standalone Audio는 Guide로 사용할 수 있고, Video의 ordinary VA/A 동작과 metadata 기반 무음 처리는 그대로 유지한다.

### 4.3 가이드 삭제와 소스 삭제

- `이 배치에서 이미지 해제`는 visualId만 null로 바꾼다. audioId가 남으면 행과 ID/frame을 보존한다. 반대도 동일하다.
- 명시적으로 사용 모드 변경/연결 해제를 수행하여 양쪽이 빈 행이 되면 그 행을 같은 transaction에서 제거한다. 이미 존재하던 다른 미완성 행까지 일괄 정리하지 않는다.
- `배치 삭제`는 visual+audio 행 전체를 삭제하므로 버튼 설명에 양쪽 연결이 제거됨을 표시한다. 소스 미디어 자체는 남긴다.
- 기존 Media 삭제 경로의 null 연결·미완성 행 보존 정책은 유지한다. 이것은 source가 없어졌음을 복구할 수 있게 하는 별도 동작이다.
- Clear Media는 미디어와 Timeline을 함께 초기화하고 Prompt를 유지하는 기존 경계를 따른다. items가 없지만 미완성 guides가 있는 경우도 Clear를 사용할 수 있도록 toolbar enable 조건을 확인한다.

## 5. 시간, 미리보기, 오류 정책

- 숫자 입력의 label은 `Output frame (0-based)`로 한다. 초는 `frame / 24`의 읽기 전용 보조 표시다. 빈 문자열을 `Number('') === 0`으로 처리하지 않는다.
- source video 재생 시점이나 audio trim 시작은 **원본 시간**이다. Guide의 frameIndex는 **생성 영상 배치 위치**다. 플레이헤드 이동으로 frameIndex를 바꾸지 않는다.
- 이번 범위의 “특정 프레임”은 생성 영상의 배치 프레임이다. 원본 비디오에서 정지 이미지를 추출해 Start/End로 쓰는 신규 기능은 포함하지 않는다. Video 자체와 video-derived Audio는 Guide 경로에 포함하지 않는다.
- 영상·오디오의 기존 crop/trim이 reference와 guide에 공유된다는 설명을 편집 영역에 둔다. 배치별 별도 crop 값을 만들지 않는다. 서로 다른 편집본이 필요하면 별도 미디어로 추가하는 기존 흐름을 사용한다.
- 썸네일/파형은 기존 runtime proxy와 waveform 데이터를 사용한다. 미리보기 실패가 발생하면 filename+오류를 보여주고 저장된 연결을 삭제하지 않는다.
- 즉시 검증: 음수/소수/빈 frame, 없는 ID/잘못된 kind, 32개 초과, Start와 visual 0f, 같은 frame의 visual 두 개 또는 audio 두 개. 오류는 해당 field와 상단 요약에 연결한다.
- visual과 audio의 같은 frame은 허용한다. 서로 다른 행을 자동 병합하지 않는다. 한 행에서 짝지은 visual/audio는 frame을 함께 이동한다는 설명을 한다.
- 서로 다른 frame에서의 clip 구간 겹침, End의 실제 위치 충돌, native 영상 길이 조정, 오디오 crop 후 겹침은 서버가 최종 판정한다. FE 추정값을 검증 완료로 표시하지 않는다.
- 오류로 Apply가 막혀도 draft와 focus를 보존한다. 무효값을 0이나 마지막 frame으로 자동 보정하지 않는다.
- 현재 연결된 downstream Wrapper의 길이를 몰래 찾아 읽는 graph 탐색 로직은 추가하지 않는다. UI에 임의 duration/FPS 설정도 추가하지 않는다.

## 6. 구현 설계: 기존 계약에 얹는 최소 변경

### 6.1 영속 상태와 임시 상태

유일한 영속 원본은 현재 `LoaderState.items`와 `LoaderState.h3Timeline`이다. 기존 serialization, execution projection, Snapshot 계약을 재사용한다.

새로 필요한 임시 UI 상태는 선택한 `(mediaId, channel)`, 편집 중 guide ID 또는 Start/End, draft 값, source 선택 모드, 요약 펼침 여부 정도다. controller 인스턴스에 보관하고 workflow/manifest/backend로 보내지 않는다. 모든 item에 역할 복사본을 저장하거나 별도 Timeline store를 만들지 않는다.

가이드 연결 조회와 사용 모드 계산은 `h3-media-guides.ts`의 작은 순수 helper로 한 곳에서 구현한다. 카드·요약·편집기마다 계산을 복제하지 않는다.

### 6.2 한 번의 사용자 확정 = 한 번의 history commit

기존 단일 toggle/set action은 유지한다. 새 Apply는 목적이 분명한 action 하나(예: `apply-h3-media-edit`)로 reference flag와 Timeline 변경을 함께 적용한다. 범용 action batch 프레임워크는 만들지 않는다.

권장 구현 순서:

1. Apply 직전 현재 item/guide가 여전히 존재하는지 확인한다.
2. draft가 의도한 해당 슬롯·연결만 **현재 state**에 적용한 candidate를 만든다. 편집 시작 때의 LoaderState 전체를 덮어쓰지 않는다.
3. 사용 모드별 reference flag와 배치 정리 규칙을 적용한다. 다른 channel, caption, crop, Prompt, unrelated guides는 보존한다.
4. 확정 가능한 오류를 검증한다. 신규 Apply도 기존 Media 상태 판정 경계를 거친다.
5. 유효하면 action 하나로 `#dispatch`하여 graph change/history를 한 번 기록한다. 완전히 같은 값이면 기존 state를 반환한다.

reducer는 ID/type/frame/limit 정합성도 지킨다. 예상한 편집 대상이 삭제되거나 교체된 draft는 안내와 함께 취소하며 이전 데이터를 부활시키지 않는다. generation state 변경을 임시 editor 내부에서 직접 mutate하지 않는다.

### 6.3 렌더링 소유권과 lifecycle

- 통합 뷰의 소유자는 `ReferenceLoaderController`다. `extension.ts`의 `timelineControllers` WeakMap과 Prompt mount/cleanup을 제거한다. 기존 Loader/Prompt widget 생성·복원 경로는 보존한다.
- `loader.render()`가 만드는 Media markup에 요약과 편집 영역을 함께 포함시킨다. `h3-media-guides.ts`는 순수 파생 모델만 제공하고 markup은 Loader가 소유한다. 영속 DOM을 append하고 구독 callback으로 다시 render하는 이중 구조는 만들지 않는다.
- root의 기존 이벤트 위임 패턴을 재사용한다. Guide 관련 버튼은 충돌 없는 `data-action` 값을 사용하고, source를 고를 때 media ID와 channel을 함께 전달한다.
- `render()`는 현재 textarea/IME만 일부 보호한다. frame input과 select의 draft/focus도 보호한다. 숫자 타이핑마다 state commit/full render하지 말고 draft 갱신 후 Apply에서 저장한다.
- runtime load 완료처럼 외부 render가 필요할 때 안정적인 field key로 focus/selection을 복원하거나 편집 subtree를 보존한다. 숫자 타이핑 중 썸네일 로딩 완료로 입력이 날아가는 테스트가 필요하다.
- 기존 AudioPreviewPlayer, VideoPreviewPlayer, `#editItem`, `#drawWaveforms`, `#syncPlaybackUi`를 호출한다. 요약은 카드로 이동시키는 역할로 시작하고 별도 player 인스턴스를 추가하지 않는다.
- waveform canvas를 여러 위치에 표시하면 `#drawWaveforms`가 하나만 갱신하지 않는지 확인한다. source ID로 동일한 runtime 데이터에 연결한다.
- node 제거, restore, Snapshot load, graph Undo 재생성 시 draft/source 선택을 정리하고 player/listener/예약 render를 기존 destroy 경로에서 해제한다.
- callback 하나가 구독 → render → 구독으로 재진입하지 않게 한다. Media 통합 후 기존 `subscribeH3Timeline` bridge와 listener set은 사용처가 없어 제거했다.
- single-image 모드의 `Load Reference Image`에는 Guide UI를 만들지 않는다. 두 노드가 controller를 공유하므로 mode 분기를 먼저 확인한다.

### 6.4 레이아웃과 접근성

- 기존 `styles/loader.css`, `styles/cards.css`, `styles/h3-timeline.css`를 활용한다. import를 유지하거나 불필요해진 스타일을 제거하고 중복된 새 파일을 늘리지 않는다.
- `prompt.css`의 `auto minmax(110px, 1fr) auto`는 Prompt 내부 구조도 담당한다. Timeline 제거를 이유로 세 번째 row를 무조건 삭제하지 말고 실제 자식과 현재 diff를 확인한다.
- Media 높이 계산이 통합 영역을 포함하도록 한다. `extension.ts`의 현재 `scrollHeight` 및 1200px cap이 펼친 32개 배치에 미치는 영향을 검사한다. 내용 잘림을 발견하면 Loader에 한정하여 계산을 조정한다.
- Nodes 2.0과 Legacy Canvas 모두에서 Media 내용이 보이고 Prompt가 바로 이어져야 한다. Media 내부에 강제 세로 스크롤을 추가하지 않는다.
- 1열 및 다열 카드, 좁은 node에서 controls를 줄바꿈한다. 버튼이 캡션이나 재생 controls를 덮지 않게 한다.
- 버튼과 input에 label, `aria-pressed`/`aria-expanded`, field 오류의 `aria-describedby`를 제공한다. 색만으로 역할을 구별하지 않는다.
- card drag/Alt+정렬은 기존 순서 변경용이다. 편집 input에서 화살표/Space/Enter가 카드 이동·노드 삭제로 전파되지 않게 기존 key handler를 점검한다. 새 시간축 drag 기능은 만들지 않는다.

## 7. 구현 단계와 에이전트 인계 단위

단계를 순서대로 수행한다. 각 단계 종료 시 바꾼 파일, 검증 명령과 결과, 다음 단계에 필요한 사실을 기록한다. 앞 단계의 계약을 임의로 바꾸지 않는다.

### 단계 0 — 기준선 확인

- `AGENTS.md`, 본 문서, 기존 H3 계획서, `docs/TESTING.md`를 읽는다.
- 관련 diff와 위 표의 심볼 및 frontend 테스트 fixture를 확인한다.
- `bun run typecheck`, `bun run test:unit`으로 현재 결과를 기록한다. 기존 실패는 새 변경의 실패와 분리한다.
- 가능하면 실제 두 Canvas에서 현재 Media/Timeline 배치를 캡처해 비교 기준을 남긴다. 실행 환경이 없으면 그 사실을 적고 코드·DOM fixture 작업을 계속한다.

완료 조건: 현재 변경을 보존할 수 있고 baseline의 통과/실패/실행 불가가 기록되어 있다.

### 단계 1 — 역할 계산과 원자적 편집

- channel별 reference flag, 연결 목록, 사용 모드, 요약 순서 helper를 구현한다.
- `apply-h3-media-edit` action과 candidate 검증을 구현한다.
- Start/End 교체, paired guide 부분 해제, guide limit을 테스트한다.
- 기존 field 이름과 state version을 유지한다. 새 저장 필드가 정말 필요하다고 판단하면 우선 이 설계로 표현 불가능한 구체적인 동작을 증명한다.

완료 조건: UI 없이 역할 전환과 Undo 한 번의 복원 동작을 검증한다.

### 단계 2 — Media 요약과 카드 역할 표시

- 기존 카드에 역할 배지와 `Guides` 진입점을 추가한다.
- Media 상단 요약과 paused/empty/incomplete 상태를 구현한다.
- guide-only 미리보기 밝기와 reference #N을 분리한다.
- Timeline OFF여도 저장된 배치가 표시되고 preset 전환으로 사라지지 않게 한다.

완료 조건: 저장된 기존 Timeline 상태만으로 모든 연결이 Media에 표시된다. 아직 편집 미완성이면 이 단계만으로 전체 완료를 선언하지 않는다.

### 단계 3 — 카드 기반 편집과 source 선택

- 하나의 선택 대상 편집 영역에 모드·Start/End·frame·paired source·삭제를 연결한다.
- Add/Cancel/Apply, 기존 카드에서 시각·오디오 source 선택, 재생·Edit·Trim 복귀를 구현한다.
- source picker에서 새 파일이 필요하면 기존 Add 업로드 경로를 이용한다. 업로드 자체는 기존 별도 history 동작으로 취급하며 Guide Cancel로 새 미디어까지 삭제하지 않는다. 업로드 완료만으로 Guide 연결을 자동 확정하지 않는다.
- 전역 OFF에서는 draft 저장과 실행 ON 전환을 구별한다.
- 새 draft와 복원된 미완성 행을 각각 다루고 오류 설명·focus 처리를 구현한다.

완료 조건: ID/select 목록을 외워서 고를 필요 없이 이미지와 오디오를 확인하며 모든 요청 동작이 가능하다.

### 단계 4 — 기존 패널 제거와 복원·레이아웃 완성

- 단계 3 완료 후 `extension.ts`의 Prompt Timeline mount/WeakMap/cleanup 경로를 제거한다.
- 구 패널용 select UI, 사용하지 않는 subscription 및 CSS를 정리한다. parser, backend, native Guide 기능은 삭제하지 않는다.
- Nodes 2.0, Legacy Canvas, node clone, graph Undo, workflow/Snapshot restore, single-image 회귀를 점검한다.
- node 크기 변경과 32개 Guide에서 Media 높이·Prompt 인접 배치를 검증한다.

완료 조건: 별도 Timeline 패널이 없어도 기능 손실이 없고, 복원 후 중복 DOM/listener가 없다.

### 단계 5 — 전체 검증 및 사용자 문서 갱신

- 아래 테스트 표를 수행하고 repo 검사 명령을 실행한다.
- `README.md`, `docs/REFERENCE_LOADER.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`의 UI 설명을 최종 화면 기준으로 수정한다.
- 기존 H3 계획에는 해당 UI 절이 본 문서로 대체됐음을 구현 완료 시 짧게 명시한다. 이전 조사 내용 전체를 재작성하지 않는다.
- 실제 H3 실행이 가능하면 변경 전과 같은 입력·배치로 reference/guide 전달을 확인한다. 모델 실행이 없으면 UI/자동 검증만 완료했다고 기록한다.

## 8. 테스트 사례와 예상 결과

기존 테스트의 fixture를 확장한다. 문자열에 버튼 이름이 있는지만 검사하지 말고 **클릭 → 상태 → 표시 → Undo** 연결을 확인한다.

| 대상 테스트 파일                                         | 필수 사례                                                 | 예상 결과                                                            |
| -------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `frontend/test/reference-loader-state.test.ts`           | 이미지 ref-only → guide-only(Start) → both                | 정확한 flag/ID, 각 Apply 한 번의 Undo로 완전 복원                    |
| 동일                                                     | 한 이미지 Start+End+24f+72f                               | 모든 역할 유지, 단일 role로 덮이지 않음                              |
| 동일                                                     | paired visual/audio에서 visual만 해제                     | audio, guide ID, frame 보존                                          |
| 동일                                                     | ref-only 전환으로 마지막 연결 해제                        | 해당 빈 행만 제거, unrelated 미완성 행 보존                          |
| 동일                                                     | 영상 visual mode 변경                                     | A/VA/audio guide 불변                                                |
| 동일                                                     | Media 삭제/동일 kind 파일 교체/Clear                      | 삭제는 기존 null 연결 정책, 교체는 ID·배치 보존, Clear는 Prompt 보존 |
| `frontend/test/reference-loader-h3-media-guides.test.ts` | 상단 Start/End/48f 배지와 편집 연결                       | 썸네일 대상·frame 정확, ID가 제목에 노출되지 않음                    |
| 동일                                                     | blank/-1/1.5, 32개 초과                                   | Apply 불가, draft·focus 보존, state 불변                             |
| 동일                                                     | visual 0f+Start, 같은 frame audio+visual                  | 전자는 충돌 안내, 후자는 허용                                        |
| 동일                                                     | 취소, Escape, OFF에서 편집                                | 취소는 무변경, OFF 편집은 값만 저장하고 OFF 유지                     |
| `frontend/test/reference-loader-dom.test.ts`             | ref OFF + guide ON 카드                                   | 이미지·파형 정상 미리보기, #N 미생성                                 |
| 동일                                                     | Audio 재생 중 가이드 source 선택                          | 기존 player/trim 경로 사용, 재생 클릭으로 source 미확정              |
| 동일                                                     | runtime 완료와 frame 입력 동시 발생                       | 입력 중 값·focus 손실 없음                                           |
| 동일                                                     | 같은 VIDEO의 Videos/Audio 카드                            | visual/audio 역할과 행동 대상 구별                                   |
| 동일                                                     | 미디어가 없는 미완성 Guide, missing preview               | 상단에서 편집·삭제 가능, Clear 가능                                  |
| `frontend/test/reference-loader-extension.test.ts`       | 새 node/graph Undo/restore/제거                           | Media 통합 뷰 한 개, Prompt 하위 Timeline 0개, 누수 없음             |
| `frontend/test/reference-loader-snapshot.test.ts`        | 기존 Timeline JSON 로드 후 저장                           | ID/frame/enabled/배치 의미 동일, draft 비직렬화                      |
| `frontend/test/reference-image-loader.test.ts`           | single-image 렌더 및 Edit                                 | Guide UI 없음, 기존 동작 유지                                        |
| 기존 Prompt/state 테스트                                 | guide-only + 일반 reference 재정렬                        | Picture/Video/Audio 태그·caption 정렬 유지                           |
| 기존 backend contract/media/wrapper 테스트               | UI가 만든 기존 형식 state 전달                            | guide-only reference 배열 불포함, h3_timeline/guide_media 경로 유지  |

### 8.1 자동 검사 명령

```powershell
bun run typecheck
bun run test:unit
bun run fmt:check
bun run lint
bun run build
git diff --check
```

집중 실행 시:

```powershell
bun test --preload ./frontend/test/setup.ts frontend/test/reference-loader-state.test.ts frontend/test/reference-loader-h3-media-guides.test.ts frontend/test/reference-loader-dom.test.ts frontend/test/reference-loader-extension.test.ts frontend/test/reference-loader-snapshot.test.ts frontend/test/reference-image-loader.test.ts
uv run pytest tests/backend/test_reference_contract.py tests/backend/test_reference_media.py tests/backend/test_minimax_h3_reference_wrapper.py -q
```

배포 archive를 만드는 요청까지 진행할 경우에만 `bun run release:check`, `bun run build:custom-node`를 추가한다. `dist/`는 직접 편집하지 않는다. Python은 uv를 사용한다. formatter가 기존 사용자 변경까지 광범위하게 바꾸지 않도록 수정 파일 중심으로 실행하고 전체 검사 실패 원인은 구분해 기록한다.

### 8.2 실제 화면에서의 인수 시나리오

1. 이미지 A/B/C, standalone audio D, 소리 있는 video E, 무음 video F를 기존 Add로 등록한다.
2. A의 G를 켜서 Start, B의 G를 켜서 End, C의 G-pencil에서 48f Guide를 설정한다. 일반 IMAGE 출력은 I가 켜진 항목만 포함돼야 한다.
3. D를 재생해 확인한 뒤 C의 48f 행에 연결한다. 오디오 reference A는 독립적으로 유지한다. 같은 frame의 visual+audio가 UI 오류로 막히면 실패다.
4. A의 Start를 유지한 채 72f 배치를 추가한다. 상단과 A 카드에 두 역할이 보여야 한다.
5. C 행을 96f로 변경하고 Undo 한 번을 수행한다. visual/audio 모두 48f로 돌아와야 한다.
6. 해당 행에서 C만 해제한다. D의 48f 배치는 남아야 한다. Undo로 복원한다.
7. Guide 전체 OFF로 전환한다. 저장 배지에 Paused가 보이고 일반 reference 출력은 동일해야 한다. ON으로 되돌리면 배치가 그대로 돌아온다.
8. E/F의 Video/AUDIO 카드에서 G/G-pencil이 표시되지 않고, V/VA/A가 기존처럼 독립 동작하는지 확인한다.
9. 이미지 Edit·영상/오디오 Trim 후 같은 Media로 돌아와 preview·crop이 갱신되고 배치 ID/frame은 유지되는지 확인한다.
10. 파일명이 같은 이미지 둘을 추가하고 재정렬한다. Guide 배지는 원래 item을 따라가야 하며 출력 순번이 이동해도 source가 바뀌면 실패다.
11. workflow 저장/재로드, Snapshot 저장/복원, node 복제, graph Undo/Redo 후 모든 값을 비교한다.
12. 한 열과 여러 열, 좁은 node와 큰 node, 펼친 32개 Guide를 두 Canvas에서 확인한다. Prompt 아래에 독립 패널이 없고 Media가 잘리지 않아야 한다.
13. 키보드만으로 source 선택·frame 변경·Apply·Cancel을 실행한다. 재생/편집 중 accidental card drag가 없어야 한다.
14. 실제 native H3 환경에서 queue가 가능하면 동일한 reference/guide source와 위치가 전달되는지 확인한다. native payload 검증과 생성 품질 판단은 별도로 기록한다.

## 9. 범위 밖과 구현 시 금지할 우회

- backend/native H3 계약 재설계, monkey patch 추가, 새로운 decoder/업로드/FFmpeg 설정.
- Guide를 별도 Picture/Audio reference 태그로 자동 추가하는 동작.
- 저장된 card usage와 h3Timeline을 양쪽에서 수정·동기화하는 이중 원본.
- 단일 start/end/guide role enum으로 다중 배치를 잃는 모델.
- Timeline OFF 시 연결 삭제 또는 reference flag 일괄 변경.
- 원본 playback time을 생성 Guide frame으로 자동 복사하는 동작.
- NLE 형태의 시간축 canvas, 드래그 ruler, 새 UI 라이브러리, 음원 믹싱.
- guide별 독립 이미지 편집/trim recipe, 비디오 정지 프레임 추출 기능.
- 현재 Start/End Frames 출력 노드의 의미 변경.
- UI 계획 작업을 이유로 기존 테스트 전체 교체, unrelated 코드 포맷 변경, 사용자 변경 되돌리기.

## 10. 구현 완료 보고 형식

```text
완료한 사용자 흐름:
- Media에서 배치 확인:
- 이미지/오디오 확인 후 지정:
- Reference only / Guide only / Both:
- 기존 Timeline 패널 제거:

상태/호환성:
- 기존 workflow 및 Snapshot:
- Undo/Redo 원자성:
- guide-only reference/Prompt 제외:
- Video visual / derived audio / VA 독립성:

검증:
- 명령 / 종료 코드 / 실패·skip 사유:
- Nodes 2.0:
- Legacy Canvas:
- 실제 H3 실행 여부와 환경:

남은 문제와 재현 방법:
-
```

## 11. 공식 문서 확인 범위

2026-09-07에 [ComfyUI JavaScript Extensions](https://docs.comfy.org/custom-nodes/js/javascript_overview)와 [Comfy Hooks](https://docs.comfy.org/custom-nodes/js/javascript_hooks)를 확인했다. 공식 extension 경로를 유지하고 새 prototype hijack을 추가하지 않는 방향으로 계획했다. 고급 hook이나 widget lifecycle을 새로 변경할 필요가 생기면 설치된 frontend 버전과 공식 API를 다시 확인한다.

이 문서의 구체적인 카드·reducer·H3 동작 판단은 현재 저장소 코드 검토에 근거한다. 공식 문서 확인만으로 두 Canvas 호환성이나 native 모델 실행 성공이 검증된 것은 아니다.
