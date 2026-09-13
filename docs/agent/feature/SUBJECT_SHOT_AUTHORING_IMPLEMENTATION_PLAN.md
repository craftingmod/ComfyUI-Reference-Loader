# Subject / Shot 독립 작성 및 Timeline 통합 구현 계획

작성일: 2026-09-07  
상태: 계획만 작성. 이 문서의 타입, 함수 이름, 출력 예시는 앞으로 구현할 계약이다.  
대상: 현재 Reference Loader 체크아웃. 아래 순서대로 작은 단계로 구현할 서브 에이전트.

## 1. 구현 목표와 반드시 지킬 기준

Media와 Prompt 사이에 **Subjects & Shots** 구역을 만들고 Subject와 Shot을 각각 카드 배열로 관리한다. 작성·저장·Raw 편집에서는 `#hero`, `#opening` 같은 이름을 그대로 유지하고, 모델에 전달할 최종 출력에서만 `<Subject 1>`, `[Shot 1]`로 바꾼다.

Shot은 정수 프레임 하나에 배치하는 텍스트 지시다. Timeline Guides의 Image / Audio 옆에 Shot 레인을 추가하고 기존 프레임 이동 UI를 재사용한다. Shot의 설명 길이와 무관하게 duration, endFrame, 다음 Shot까지의 자동 구간은 만들지 않는다.

사용자 요구와 구현 완료 기준:

| 요구               | 구현 계약                                              | 확인 방법                    |
| ------------------ | ------------------------------------------------------ | ---------------------------- |
| 독립 정의 구역     | Media 아래, Prompt 위에 Subjects / Shots 카드 스택     | 두 Canvas에서 시각 확인      |
| 이름이 태그        | Subject·Shot 전체에서 유일한 이름, 본문에 `#name` 저장 | 저장 JSON·Raw에 index 없음   |
| Shot 시간 배치     | Shot마다 `frameIndex`, Timeline에 자동 표시            | 카드와 마커 양방향 동기화    |
| 양방향 재사용      | Subject→Subject/Shot, Shot→Subject/Shot 모두 허용      | 네 조합 및 자기 참조 fixture |
| 나머지 Prompt 유지 | 자유 section, Raw, 기존 미디어 참조 계속 사용          | 기존 Prompt 회귀 검사        |
| 최종 출력만 index  | 컴파일마다 Subject 배열 / Shot 시간순 index 계산       | 재정렬 전후 fixture          |
| Shot 카테고리      | Image / Audio / Shot 레인, Shot 개수 별도 표시         | Guide 제한과 독립 확인       |

추가 개선도 이번 범위에 포함한다: 이름 변경 일괄 반영, 미정의 태그 보존, 원본/컴파일 복사 구분, 참조되지 않는 정의 보존, 동일 프레임의 안정적인 순서, Undo/Cancel, 기존 상태 마이그레이션.

## 2. 현재 코드에서 확인한 문제와 수정 시작점

라인 번호는 바뀔 수 있으므로 아래 심볼을 검색해서 작업한다.

| 파일                                                | 현재 동작                                                                         | 필요한 변경                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| `frontend/src/reference-loader/prompt-state.ts`     | v4 `PromptSubject`는 `subjectId`, `label`만 가짐. 정의 본문은 section에 섞여 있음 | v5에 독립 Subject 본문과 Shot 배열 추가 |
| 같은 파일 `compilePromptDocument`, `parseRawPrompt` | Subject를 index로 출력하고 `<Subject N>`을 현재 배열로 역해석                     | 작성용 렌더와 최종 컴파일 분리          |
| `components/prompt-editor.ts`                       | Raw 표시·참조 갱신·Copy에 컴파일 함수 사용                                        | Raw/원본 Copy는 `#tag` 유지             |
| 같은 파일 `#orderedSubjects`                        | section에서 사용 중인 Subject만 남김                                              | v5 정의에 대해 자동 제거 금지           |
| `components/h3-timeline.ts`                         | 24 fps, visual/audio 마커, 드래그·숫자 입력·키보드 이동                           | Shot 마커 종류와 콜백 추가              |
| `components/loader.ts`                              | Timeline과 Guide draft/Apply/Cancel 소유                                          | Shot 데이터 연결 및 종류별 작업 분기    |
| `extension.ts`                                      | Loader/Prompt가 별도 controller와 DOM widget, Snapshot 양쪽 복원                  | controller 간 좁은 연결, 수명주기 정리  |
| `backend/core/prompt_contract.py`                   | Python v4 파서·컴파일·직렬화·미디어 순서 재바인딩                                 | TS와 동일한 v5 계약 구현                |
| `reference_loader_export_prompt_for_llm.py`         | `compile_prompt_sections`로 YAML 생성                                             | 같은 section 컴파일 결과 사용           |
| `reference_bundle.py`                               | 저장된 state 재컴파일 결과와 bundle의 compiled prompt 비교                        | 프런트만 고치면 안 됨                   |

현재 Timeline의 `FPS = 24` 및 wrapper의 24 fps 경로를 기준으로 이 기능도 **24 fps 고정**으로 설계한다. 출력 예시는 본 프로젝트의 작성/내보내기 계약이며, 새로운 H3 네이티브 토큰 지원이나 모델 실행 결과를 주장하지 않는다. ComfyUI API와 advanced hook을 바꾸지 않고 기존 DOM widget 등록을 재사용한다. 구현 중 그 경계를 바꾸게 된다면 먼저 현재 공식 문서를 확인한다.

## 3. 데이터 소유권: 저장 장소를 먼저 고정한다

### 3.1 단일 원본

- Subject, Shot, 일반 Prompt section은 기존 `prompt` widget의 `PromptDocument`에 저장한다.
- Image/Audio Guide는 기존 `loader_state.h3Timeline`에 그대로 저장한다.
- Shot의 프레임은 오직 `PromptDocument.shots[].frameIndex`에 저장한다.
- Timeline은 Shot 배열에서 마커를 계산한다. `h3Timeline.guides`에 Shot 사본이나 가짜 media ID를 넣지 않는다.
- 새 hidden widget, 새 backend 입력, 별도 `shot_state` JSON을 추가하지 않는다.
- UI상의 독립 구역과 저장 widget의 개수는 별개다. Prompt DOM root 안에서 독립된 형제 section으로 렌더하면 Media 아래에 자연스럽게 배치된다.

### 3.2 제안 v5 타입

```ts
// 기존 PromptTextPart, PromptMentionPart 재사용.
// v5에서 Subject/Shot 참조는 text 안의 #tag가 원본이다.
type PromptSectionPart = PromptTextPart | PromptMentionPart

interface PromptSubject {
  tag: string // # 제외. 작성 식별자이며 문서 전체에서 유일
  parts: PromptSectionPart[]
}

interface PromptShot {
  tag: string
  frameIndex: number // 0-based safe integer >= 0
  parts: PromptSectionPart[]
}

interface PromptDocument {
  version: 5
  view: "structured" | "raw"
  subjects: PromptSubject[]
  shots: PromptShot[]
  sections: PromptSection[]
}
```

v4의 `PromptSubjectPart`는 마이그레이션 입력 타입으로만 남긴다. 새 본문에 `subjectId`와 `label`을 중복 저장하지 않는다. 미디어의 기존 stable reference ID는 그대로 유지한다. DOM 포커스나 draft 선택도 태그를 사용하며, rename 시 선택 태그를 같이 갱신한다. React key 같은 요구를 가정해 새 UUID 계층을 추가하지 않는다.

### 3.3 태그 문법

- 기존 label 문법을 기본으로 한글·영문·숫자로 시작, 이후 글자·숫자·`_`·`-`, 최대 64자. `#`는 UI/본문에서만 붙인다.
- Subject와 Shot이 **하나의 이름 공간**을 쓴다. 같은 이름을 양쪽에 만들 수 없다.
- 원문 대소문자를 보존하고 비교는 대소문자 구분으로 통일한다. 기존 v4의 대소문자 무시 중복 검사는 v5에서 명시적으로 교체한다. TS와 Python의 Unicode lower 구현 차이를 새 계약에 넣지 않는다.
- 태그 전체를 읽은 뒤 정확히 조회한다. `#hero`가 `#heroine`의 일부를 바꾸면 안 된다.
- 태그 뒤에는 공백/구두점으로 경계를 둔다. `#hero가`는 `hero가`라는 별도 이름이므로 `#hero 가`로 작성한다. 자동완성은 뒤에 경계가 없으면 공백을 넣는다. 한글 조사를 추측해서 떼어내는 파서는 만들지 않는다.
- 시작 또는 공백/구두점 뒤의 `#`를 인식한다. 글자·숫자·`_`·`-`에 바로 이어진 `#`는 일반 텍스트로 둔다. 동일 경계 함수를 TS/Python fixture로 검증한다.
- `\#hero`는 literal escape로 정의한다. 저장에서는 backslash까지 유지, 컴파일에서는 `#hero`만 출력하고 치환하지 않는다.
- 등록되지 않은 태그는 텍스트 그대로 보존하고 가벼운 미해결 표시를 한다. 자동 생성·자동 삭제·자동 교정하지 않는다.
- invalid rename/add는 현재 상태를 유지한 채 입력 오류를 표시한다. 입력 도중의 빈 이름을 저장해서 기존 정의를 지우지 않는다.

## 4. 참조 의미와 컴파일: 재귀 검사 없이 끝나는 구조

이 계획에서 컴포넌트 재사용은 **이름을 통한 정의 참조**다. 다른 카드 본문을 호출 위치에 재귀적으로 복사하는 매크로 확장은 하지 않는다. 사용자는 어느 방향으로든 이름을 참조할 수 있고, 자기 참조/순환 참조도 그대로 허용한다.

예: `hero.parts = "#costume 착용. #opening 참조."`이면 최종 출력은 `<Subject 2> 착용. [Shot 1] 참조.`다. `costume.parts`나 `opening.parts`를 이 문자열 안으로 다시 펼치지 않는다. 따라서 DFS, cycle detector, 깊이 제한, dependency DAG가 필요 없다. 각 정의를 한 번 출력하고 각 원문 토큰을 한 번만 치환한다. 이후 매크로 확장을 원한다는 별도 요구가 나오면 다른 기능으로 다룬다.

### 4.1 세 함수를 구분한다

1. `renderAuthoringPrompt(document, references)`: 일반 section만 작성용 텍스트로 렌더. `#tag` 유지, 기존 미디어 처리 재사용. Subject/Shot 카드 본문에도 같은 parts 렌더 helper 사용.
2. `parseAuthoringPrompt(text, references, currentDocument)`: 일반 section만 갱신. `subjects`, `shots`는 보존. `<Subject N>` 역매핑은 이 함수의 기본 동작에서 제거.
3. `compilePromptSections(document, references)`: 모든 정의와 section을 최종 출력용으로 컴파일. 문자열 출력 `compilePromptDocument`와 Python `compile_prompt`는 이 결과를 join만 한다.

최종 컴파일 함수를 Raw 화면, 편집 DOM 초기화, 포커스 해제, 일반 paste에 호출하지 않는다. `refreshReferences`가 Raw 전체를 index 텍스트로 다시 쓰는 경로도 교체한다.

### 4.2 index와 시간 결정

- Subject 번호: `subjects` 배열의 순서대로 1부터. 사용 횟수와 무관하다.
- Shot 번호: `frameIndex` 오름차순, 같은 frame이면 `shots` 배열의 순서대로 1부터.
- 먼저 두 종류 전체의 tag→출력 토큰 map을 만들고, 그다음 모든 본문을 컴파일한다. 뒤에 정의된 태그도 참조 가능하다.
- Shot 배열은 카드 순서다. Timeline 이동은 `frameIndex`만 바꾼다. 정렬 과정에서 원본 배열을 mutate하지 않는다.
- `seconds = frameIndex / 24`. 정수 millisecond를 `floor(frameIndex * 1000 / 24 + 0.5)`로 계산하여 소수 셋째 자리까지 출력한다. TS/Python의 round 차이를 피한다.
- UI는 `49f · 2.042s`, 최종 출력은 `[2.042s]:`처럼 sec 단위다. duration 필드는 생성하지 않는다.
- 동일 frame Shot은 허용한다. 시각적으로 위아래로 구분하고 배열 순서로 출력한다. Image/Audio overlap 검사와 32 Guide 제한에 포함시키지 않는다.
- 출력 길이를 모르는 Raw Prompt 경로에서는 끝 프레임을 추측하거나 강제로 clamp하지 않는다. Export 노드처럼 실제 seconds 입력이 있는 곳은 `frameIndex / 24 >= seconds`인 Shot을 이름과 함께 오류로 알린다. 저장/편집은 허용하고 입력값을 보존한다. Timeline의 view extent를 출력 길이로 취급하지 않는다.

### 4.3 최종 section 합성 규칙

- Subject 정의는 `subject_definitions`에 `<Subject N>: 본문` 블록으로 생성한다.
- Shot 정의는 `timeline_direction`에 `[Shot N]\n[S.SSSs]: 본문` 블록으로 생성한다.
- 기존 일반 section의 제목/순서는 유지한다. 해당 제목이 있으면 기존 수동 본문 뒤에 생성 블록을 빈 줄로 연결한다. 같은 제목의 section을 두 개 만들지 않는다.
- 해당 제목이 없으면 생성 Subject section은 맨 앞, 생성 Shot section은 맨 뒤에 추가한다.
- 빈 카드도 유효한 정의로 유지하고 번호를 부여한다. Subject의 빈 본문은 최종 출력에서 `N/A`로 컴파일한다.
- 수동 본문의 `<Subject N>` 및 `[Shot N]` 문자열은 일반 텍스트로 보존한다. 자동으로 다시 번호를 매기지 않는다. index 직접 작성에 대한 안내만 한다.
- 수동 `subject_definitions`, `timeline_direction` 입력을 금지하지 않는다. 카드가 주 작성 경로이고, 수동 텍스트는 별도로 남는다는 설명을 표시한다.
- 어떠한 최종 출력도 원본 document로 다시 저장하지 않는다.

예제 입력:

```text
Subjects: [hero: "붉은 코트의 인물", door: "낡은 문"]
Shots: [enter@48f: "#hero 가 #door 를 연다.", look@0f: "#hero 가 #enter 직전 멈춘다."]
Prompt scene: "#hero 중심의 장면."
```

예상 출력:

```text
subject_definitions:
<Subject 1>: 붉은 코트의 인물

<Subject 2>: 낡은 문

scene:
<Subject 1> 중심의 장면.

timeline_direction:
[Shot 1]
[0.000s]: <Subject 1> 가 [Shot 2] 직전 멈춘다.

[Shot 2]
[2.000s]: <Subject 1> 가 <Subject 2> 를 연다.
```

## 5. 작성 UI 및 복사/붙여넣기

### 5.1 화면 구성

```text
Media
  기존 미디어 카드 / Timeline Guides [Image | Audio | Shot]
Subjects & Shots
  Subjects                         [+ Subject]
    #hero        [위] [아래] [삭제]
    설명 (# 자동완성, @ 미디어 참조)
  Shots                            [+ Shot]
    #opening     0f · 0.000s [Timeline] [위] [아래] [삭제]
    설명 (# 자동완성, @ 미디어 참조)
Prompt
  기존 section 작성 / Raw 전환
  [Copy source] [Copy compiled]
```

새 카드 기본 이름은 전역 이름 공간을 확인해 `subject_1`, `shot_1`부터 빈 번호를 찾는다. 새 Shot은 frame 0에 생성하고 즉시 Timeline에 나타난다. 위치 변경은 숫자 입력 또는 Timeline 버튼으로 접근한다. 1차 구현은 위/아래 버튼과 Alt+Up/Down으로 배열 이동을 제공한다. 드래그 재정렬 라이브러리는 추가하지 않는다.

새 구역은 Prompt root 내부의 독립 section으로 배치하되 Prompt 패널의 Clear/Raw 대상과 분리한다. 긴 카드가 붙어도 Media와 Prompt 사이에 임의의 빈 높이를 만들지 않는다. `extension.ts`의 scrollHeight, 현재 1200 높이 상한, `.rl-prompt-panel` flex 규칙을 두 Canvas에서 함께 점검한다.

### 5.2 자동완성

- Subject 본문, Shot 본문, Structured Prompt, Raw Prompt의 `#`에서 같은 후보 목록을 쓴다.
- 후보에 `Subject` / `Shot` 구분, `#tag`, Shot의 frame/sec, 짧은 본문 미리보기를 표시한다.
- Enter/Tab 선택, 방향키, Escape, 마우스 선택, 한국어 IME composition 처리를 기존 picker에서 재사용한다.
- 선택하면 원문 `#tag`를 삽입한다. v4의 index 숨김 chip을 새로 저장하지 않는다.
- 원문이 source of truth다. 꾸밈을 위해 전체 contenteditable을 매 keystroke 재렌더해서 caret/Undo를 깨뜨리지 않는다.
- 기존 preset의 `subjectMode` 생성 제한은 독립 구역에 적용하지 않는다. 모든 preset에서 등록된 Subject/Shot의 참조를 허용한다. 기존 Freeform/Base의 미등록 `#text`는 그대로 literal이다. preset 변경은 정의를 삭제하지 않는다.
- Prompt에서도 후보 하단에 `+ Subject 만들기`, `+ Shot 만들기`를 제공할 수 있다. 생성은 같은 카드 추가 함수를 사용하며 Shot 기본 frame은 0이다. 별도 문법 파서를 만들지 않는다.

### 5.3 이름 변경·삭제

- rename은 태그 경계 helper를 이용해 모든 Subject/Shot/Prompt 본문의 해당 토큰을 한 번에 바꾼다. escape·부분 문자열·미디어 label은 바꾸지 않는다.
- 이름과 모든 참조 변경은 하나의 history commit이다. 실패 시 아무것도 바꾸지 않는다.
- 삭제는 정의만 지운다. 남은 `#tag`는 미해결 원문으로 유지한다. 참조 개수를 보여주고 Undo할 수 있게 한다.
- 마지막 사용처를 지워도 정의는 남는다. 기존 `#orderedSubjects` 필터를 새 경로에 남기지 않는다.
- Prompt Clear는 `sections`만 삭제한다. Subject/Shot은 각 영역의 삭제 동작으로 관리한다. Media Clear도 Subject/Shot을 보존한다.

### 5.4 두 종류의 Copy와 이식 범위

- `Copy source`: 현재 일반 Prompt section을 `#tag` 유지 상태로 복사한다. Raw와 동일한 텍스트다.
- `Copy compiled`: 독립 정의까지 포함한 최종 모델용 prompt를 복사한다. Raw Prompt 출력 노드는 기존처럼 이 최종 문자열을 낸다.
- 카드 본문 복사/paste도 `#tag`를 그대로 사용한다. 같은 문서에 붙이면 즉시 재사용된다.
- 일반 텍스트만 새 문서에 붙이면 참조는 보존되지만 정의 본문은 따라오지 않는다. 이것을 자동 복원된다고 표시하지 않는다.
- 정의까지 다른 문서로 옮기는 완전한 경로는 기존 Snapshot Save/Load로 제공한다. 새 export 포맷은 만들지 않는다. UI 도움말에 Snapshot이 Media/설정까지 함께 담는다는 범위를 명시한다.
- index로 컴파일된 출력만 가진 경우 원래 이름을 유일하게 복구할 수 없다. 일반 paste에서 현재 배열에 추측 연결하지 않는다. legacy import에만 검증된 v4 map을 사용한다.

## 6. Timeline 통합과 draft/Undo

### 6.1 마커 타입과 이벤트

`H3GuideEntry`에 Shot을 끼워 넣지 말고 Timeline 표시 타입에 discriminated union을 사용한다. Guide 마커는 기존 placement를 유지하고 Shot 마커는 tag/frame을 가진다.

```ts
type TimelineTarget =
  { kind: "guide"; guideId: string; channel: "visual" | "audio" } | { kind: "shot"; tag: string }
// Start/End는 현재 별도 처리 유지. guideId를 억지로 생성하지 않는다.
```

`select`, `change`, `remove` 콜백을 target 기준으로 분기한다. `selectedId` 문자열 하나가 Guide/Shot을 혼동하지 않게 view selection도 종류를 보유한다. 마커는 시간 점이며 점유 span은 1 frame이다. Shot 레인은 같은 위치의 마커 여러 개를 보여줄 수 있게 행 높이를 늘리거나 겹침을 풀어 표시한다.

기존 pointer capture, Escape 취소, horizontal scroll 보정, Shift+Arrow 24f, 포커스 복원, 이벤트 listener 해제를 유지한다. Delete/Backspace는 input/contenteditable에 포커스가 있으면 글자 편집에 양보한다.

### 6.2 controller 연결

`extension.ts`에서 Loader와 Prompt가 모두 준비된 뒤 좁은 bridge를 연결한다. 새 전역 store는 만들지 않는다.

- Prompt → Loader: 읽기 전용 Shot 배열 조회, document 변경 구독.
- Loader → Prompt: Shot 선택, Shot timing draft 시작/변경/Apply/Cancel 요청.
- 양쪽 생성 순서가 바뀌어도 bind 함수 재호출 시 중복 구독 없이 연결한다.
- restore/Snapshot/Undo/삭제 시 Timeline을 다시 투영한다. node 제거 시 양쪽 subscription을 해제한다.
- 임의의 private field에 접근하지 말고 필요한 public 메서드만 만든다.

### 6.3 transaction을 섞지 않는 구체적인 1차 구현

현재 Loader와 Prompt의 history가 분리되어 있으므로, 하나의 Apply가 서로 다른 history에 나눠 기록되는 구조는 만들지 않는다. **한 번에 Guide draft 또는 Shot timing draft 중 하나만 활성화**한다.

- Guide draft는 현재 Loader 경로를 유지한다.
- Shot timing draft는 Prompt controller가 소유한다. 전체 document의 초기값/초안값을 유지하고 frame 변경은 draft에만 적용한다.
- Shot 드래그 종료/숫자 변경 후 Timeline과 카드에는 같은 초안 frame을 표시한다. 직렬화, Copy compiled, backend queue는 Apply 전까지 확정값을 사용한다. 미적용 상태 문구를 표시한다.
- Apply는 Prompt history 한 번 commit, Cancel은 초기 확정값 복원. 이후 Undo 한 번으로 frame이 돌아온다.
- draft 동안 카드 본문/이름 편집은 잠시 잠그고 Apply/Cancel 안내를 제공하여 draft 전체 commit이 새 입력을 덮어쓰지 않게 한다.
- 다른 종류 draft 시작이나 Shot 삭제 요청 시 기존 Apply/Cancel 제어로 먼저 마무리하도록 한다. 조용히 적용하거나 폐기하지 않는다.
- Timeline에서 Shot Remove/Delete는 카드 정의 삭제임을 `Delete Shot`으로 명시한다. duration 없는 Shot은 배치와 정의가 1:1이므로 별도의 미배치 상태를 추가하지 않는다. 삭제 역시 Shot draft에서 Apply해야 확정한다.
- 카드의 직접 삭제/rename/배열 이동은 기존 Prompt history 경로에 하나의 편집으로 기록한다.

미디어 Guide의 ON/OFF는 conditioning에만 적용한다. Shot은 Timeline OFF에서도 표시·편집·컴파일된다. 헤더의 토글 문구를 `Media Guides ON/OFF`로 명확히 바꾸고 `Shot 3` 같은 독립 개수를 표시한다. Shot을 끄는 별도 토글은 이번에 추가하지 않는다.

## 7. v4 및 기존 작업 보존

단순히 VERSION을 5로 올리면 현재 `recoverLegacyPromptDocument`가 v4를 일반 legacy로 처리해서 Subject를 잃을 수 있다. **v4 전용 변환을 generic legacy 처리보다 먼저** 추가한다. backend도 v4 JSON을 받아 같은 의미로 변환해야 프런트를 거치지 않는 API 실행이 동작한다.

v4 변환 순서:

1. 기존 Subject 배열의 순서를 보존하고 `label`을 v5 `tag`로 사용한다. 본문은 빈 `parts`로 시작한다.
2. 모든 v4 `subject` part를 해당 subjectId의 tag 텍스트로 바꾼다. 대상이 없으면 저장된 label의 `#label`을 보존한다.
3. v4 Raw text에 `<Subject N>`이 있는 경우에만 v4 배열의 확정된 ordinal map으로 변환한다. 범위 밖 값은 원문으로 남긴다.
4. 기존 section 텍스트는 유지한다. 사람이 쓴 문단의 어디까지가 한 Subject 본문인지 추측해서 나누지 않는다.
5. 기존 `timeline_direction`도 그대로 둔다. `[Shot N]`이나 시간 문자열을 정규식으로 자동 분해해 Shot을 생성하지 않는다.
6. `shots: []`로 생성하고 “기존 정의 본문은 Prompt에 보존됨. 새 카드로 옮길 수 있음” 안내를 표시한다.
7. 빈 Subject 카드의 생성 heading과 기존 수동 정의가 함께 출력될 수 있음을 미리보기로 드러낸다. 사용자가 기존 문장을 카드 본문으로 옮기고 해당 수동 문장을 지우도록 안내한다. 데이터 유실을 피하기 위해 자동 중복 제거하지 않는다.

v1~v3은 현재 legacy 복구 경로를 유지한 뒤 v5의 빈 정의 배열을 붙인다. 지원하지 않는 미래 버전을 v5로 덮어 저장하지 않는다. frontend 복구 notice와 backend 오류 정책은 구분한다. Snapshot 검증에서 문제가 있는 입력을 먼저 검증한 뒤 적용해야 현재 문서가 부분 변경되지 않는다.

정상 v5 입력은 validate→serialize→deserialize 후 구조와 참조가 동일해야 한다. 크기 제한은 정의 본문까지 합산하며 원문 text를 조용히 잘라 저장하지 않는다. UI에서는 마지막 정상 상태와 입력을 유지하고 오류를 보여주고, backend는 명시적 오류를 반환한다. 기존 제한보다 무조건 크게 늘려 문제를 숨기지 않는다.

## 8. 파일별 구현 구성

아래 새 파일은 계획상 이름이다. 같은 역할이 이미 추출되어 있다면 기존 파일을 재사용한다.

| 파일                                                                              | 구현 내용                                                                                                         |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `frontend/src/reference-loader/prompt-state.ts`                                   | v5 타입/validation/migration, 전체 parts 순회, 작성용 parse/render, tag scanner, section 컴파일, rename 순수 함수 |
| `frontend/src/reference-loader/components/prompt-editor.ts`                       | 독립 구역 mount, source/compiled Copy 분리, 자동 prune 제거, Raw 경로 수정, history/draft 소유                    |
| `frontend/src/reference-loader/components/prompt-definitions.ts` (신규)           | Subject/Shot 카드 DOM와 add/remove/reorder UI. 상태 복제 소유 금지, callback으로 변경 전달                        |
| `frontend/src/reference-loader/components/prompt-autocomplete.ts` (필요 시 신규)  | 기존 picker의 공통 query/후보/삽입만 추출. 완전한 새 editor framework 금지                                        |
| `frontend/src/reference-loader/components/h3-timeline.ts`                         | Shot 마커/레인, selection 종류, frame 이동/삭제 분기, 같은 frame 표시                                             |
| `frontend/src/reference-loader/components/loader.ts`                              | bridge 연결점, Guide/Shot draft 상호 배제, Shot projection, Media Guides 토글 문구                                |
| `frontend/src/reference-loader/extension.ts`                                      | controller bind/dispose, 기존 widget 내부 layout, restore 타이밍                                                  |
| `frontend/src/reference-loader/prompt-presets.ts` 및 `presets/prompt/*.json`      | 새 독립 정의와 구 subjectMode 정책 정리. alias/기존 section 사용은 보존                                           |
| `frontend/src/reference-loader/prompt-i18n.ts`                                    | ko/en 카드/복사/draft/미해결 문구                                                                                 |
| `frontend/src/reference-loader/styles/prompt.css`, `styles/h3-timeline.css`       | 카드 스택, 타입별 태그/마커 구분, 레이아웃/포커스                                                                 |
| `frontend/src/reference-loader/snapshot.ts`                                       | v4 입력 migration 및 v5 보존 검증. outer snapshot 형식은 호환되면 유지                                            |
| `frontend/src/reference-loader/prompt-cache.ts`                                   | 모든 본문과 Shot frame이 저장/캐시 갱신에 포함되는지 확인                                                         |
| `backend/core/prompt_contract.py`                                                 | v5 dataclass/parser/migration/serialize/compiler, 모든 parts 미디어 재바인딩                                      |
| `backend/nodes/reference_loader.py`                                               | v5 입력·직렬화·fingerprint·bundle 생성 통합 확인                                                                  |
| `backend/nodes/reference_bundle.py`                                               | 재컴파일 일관성 확인                                                                                              |
| `backend/nodes/reference_loader_options_override.py`                              | media order 재바인딩이 새 정의 본문에도 적용되는지 확인                                                           |
| `backend/nodes/reference_loader_export_prompt_for_llm.py`                         | 공통 compiler 사용, Shot 범위 검사, YAML 단일 key 유지                                                            |
| `backend/nodes/reference_loader_raw_prompt.py`                                    | 기존 compiled 문자열 추출 계약 유지, 변경 필요 최소화                                                             |
| `tests/backend/test_prompt_contract.py`, `frontend/test/reference-prompt.test.ts` | v5 및 migration/Raw/rename fixture                                                                                |
| `frontend/test/reference-loader-timeline.test.ts`                                 | Shot interaction, draft, keyboard, Guide 회귀                                                                     |
| 기존 snapshot/cache/export/bundle 관련 테스트                                     | 새 필드가 누락되지 않는 경로별 회귀                                                                               |
| `docs/TESTING.md`, `README.md`                                                    | Copy 의미, 새 Clear/preset/Subject 수명 규칙, Shot 레인 설명                                                      |

`types.ts`, `reducer.ts`, `serialization.ts`, `h3-media-guides.ts`, backend reference contract는 미디어 Guide 저장 규칙을 유지한다. 단순히 Timeline에 Shot이 보인다는 이유로 이 파일들에 가짜 media 종류를 추가하지 않는다. wrapper에는 Shot→`MiniMaxH3AddGuide` 호출을 추가하지 않는다.

## 9. 서브 에이전트 실행 순서와 단계별 완료 조건

### 단계 0 — 기준선 확인

1. `git status --short`로 사용자가 작업 중인 파일을 확인하고 수정하지 않는다. 이 계획 작성 시 기존 untracked 계획 문서들이 있었으므로 일괄 삭제/정리하지 않는다.
2. `AGENTS.md`, `docs/TESTING.md`, 이 계획과 표에 있는 실제 코드를 읽는다.
3. `rg`로 compiler, `parseRawPrompt`, `#orderedSubjects`, PromptPart 분기, `PromptDocument` 객체 생성 지점을 전부 찾는다.
4. `bun run typecheck`, `bun run test:unit`으로 기준선 결과를 기록한다. 환경 실패와 테스트 실패를 구분한다.

완료 조건: 현재 경로와 baseline 실패 목록을 설명할 수 있다. UI부터 구현하지 않는다.

### 단계 1 — 계약/컴파일러부터

1. v5 fixture를 작성하고 빈 문서/Subject/Shot 예제의 예상 출력을 고정한다.
2. TS/Python v5 타입, migration, tag scanner, 최종 section 합성을 함께 구현한다.
3. 모든 document 생성/복사/직렬화 지점에 `shots`와 Subject `parts`가 유지되게 고친다.
4. media mention 재바인딩을 sections뿐 아니라 Subject/Shot parts에도 적용한다.

완료 조건: UI 없이 같은 입력에 TS/Python 출력이 일치하고 v4 내용이 보존된다.

### 단계 2 — Raw 및 정의 카드

1. 작성용 렌더/parse를 연결하고 Raw 컴파일 호출을 제거한다.
2. Subject 자동 prune을 제거한다.
3. 새 카드 스택, 배열 이동, 이름 변경, 삭제, Prompt Clear 범위를 구현한다.
4. 공통 자동완성을 세 본문 + Raw에 연결한다.
5. source/compiled Copy와 Snapshot 복구 안내를 구현한다.

완료 조건: Timeline 없이도 카드 데이터가 workflow/Snapshot/Undo에서 보존되고 Raw 왕복에 `#tag`가 남는다.

### 단계 3 — Shot 레인과 timing draft

1. 마커 union과 종류별 콜백을 먼저 적용하고 기존 Image/Audio 테스트를 통과시킨다.
2. Shot projection, 레인, frame 입력, 선택 이동을 연결한다.
3. Prompt 소유 Shot draft, Apply/Cancel/Undo, Guide draft 상호 배제를 구현한다.
4. 동일 frame, 삭제, pointercancel, focus, Media Guides OFF를 검증한다.

완료 조건: 새 Shot이 자동 표시되고 이동 결과가 정확히 한 번 commit되며 기존 Guide 동작이 유지된다.

### 단계 4 — 출력·복원 통합

1. Raw Prompt, Export Prompt for LLM, Options Override, bundle validation, fingerprint/cache 경로를 검증한다.
2. Snapshot import가 v4/v5 모두 처리되는지 확인한다.
3. preset 변경, queue 직전 serialization, node restore 생성 순서, remove cleanup을 검증한다.

완료 조건: frontend에서만 동작하는 상태가 아니라 backend 재컴파일까지 일치한다.

### 단계 5 — 최종 검증과 보고

`docs/TESTING.md`의 현재 명령을 따른다. 이 체크아웃은 prettier/eslint가 아니라 oxfmt/oxlint 및 Ruff repo script를 사용하므로 formatter를 새로 설치하지 않는다.

```powershell
bun run fmt:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
bun run release:check
bun run build:custom-node
git diff --check
```

실패한 파일만 원인을 수정한 뒤 필요한 검사를 다시 한다. `dist/`는 직접 고치지 말고 build로 생성한다. 배포 권한이 있는 경우에만 기존 배포 경로를 사용하고, 사용자가 새 bundle을 받도록 브라우저 새로고침 단계도 보고한다. 이 문서만 작성한 단계에서는 위 제품 검사를 실행했다고 보고하지 않는다.

## 10. 필수 테스트 행렬

작은 공유 JSON fixture를 `tests/fixtures/prompt-authoring-v5.json`에 두고 Bun/Python이 각각 읽는다. 새 테스트 framework는 추가하지 않는다.

| 분야      | 입력/행동                                              | 기대                                     |
| --------- | ------------------------------------------------------ | ---------------------------------------- |
| 원본 보존 | Raw↔Structured, blur, media reorder                    | `#tag` 유지, 정의 배열 보존              |
| 전체 왕복 | workflow 저장/복원, Snapshot, Undo/Redo                | tag/body/frame/배열 순서 동일            |
| 참조 방향 | Subject→Subject, Subject→Shot, Shot→Subject, Shot→Shot | 전체 map에 의해 index 치환               |
| 순환      | A→B→A, 자기 참조                                       | 거부/재귀 확장 없이 종료                 |
| tokenizer | `#hero`, `#heroine`, `#한글`, escape, 미정의           | 정확한 토큰만 치환                       |
| rename    | 정의와 모든 사용처 변경                                | 한 번 Undo로 모두 복구                   |
| 제거      | 마지막 사용처 삭제 / 정의 삭제                         | 정의 유지 / 미해결 원문 유지             |
| 번호      | Subject reorder, Shot frame 변경, 같은 frame           | 배열/시간 tie-break 일관성               |
| 시간      | 0, 1, 23, 24, 49f                                      | 0.000, 0.042, 0.958, 1.000, 2.042s       |
| 입력 오류 | 음수, 소수 frame, NaN, bool, 중복 tag, 크기 초과       | 상태 유실 없이 명시적 오류               |
| duration  | 알려진 seconds 바깥 Shot / Raw 경로                    | Export 오류 / Raw는 임의 clamp 없음      |
| 합성      | 수동 subject_definitions/timeline_direction 존재       | 제목 중복 없이 원문+생성 블록            |
| migration | v4 chips/Raw/index 범위 밖/수동 Shot                   | 확실한 참조만 변환, 본문 보존            |
| media     | Subject/Shot 안의 @ mention 및 by-order                | 기존 활성 media projection과 일치        |
| cache     | Shot frame만 변경, 본문만 변경                         | stale compiled 결과 없음                 |
| Timeline  | drag, Arrow, Shift+Arrow, Escape, Cancel, Apply        | 프레임 정확, 한 번 commit                |
| draft     | Guide 편집 중 Shot 선택 및 반대                        | 미저장 편집 자동 소실 없음               |
| OFF/제한  | Media Guides OFF, Guide 32개+Shot                      | Shot 유지, Guide count 불변              |
| keyboard  | 본문 편집 중 Delete/Backspace                          | Shot 삭제로 전파되지 않음                |
| lifecycle | widget 생성 순서, restore, node remove                 | 구독 중복·누수·유령 callback 없음        |
| preset    | Generic/Reference/Base/Freeform 왕복                   | 등록 태그 사용 가능, 미등록 literal 보존 |

수동 확인은 Nodes 2.0와 Legacy Canvas 양쪽에서 한다. 카드 20개, 긴 본문, 한글 IME, 좁은 폭, Timeline zoom/scroll 중 드래그, selected Shot rename/delete, 미디어 Clear, Prompt Clear, Snapshot cancel을 포함한다. 네이티브 H3 생성은 별도 실행 검증이며 compiler/DOM 테스트 성공을 모델의 의미 이해 검증으로 보고하지 않는다.

## 11. 구현자가 하지 말아야 할 것

- UI만 추가하고 Python v4 validator를 남기는 부분 구현.
- Raw를 최종 출력으로 다시 덮어쓰거나 index 문자열을 자동 역추측하는 구현.
- Subject와 Shot의 이름 공간을 분리해 `#name`이 어느 쪽인지 모호하게 만드는 구현.
- 사용하지 않는 정의를 정리한다며 자동 삭제하는 구현.
- 요청하지 않은 재귀 탐지·매크로 확장·Shot duration·카메라 전용 필드·새 모달 추가.
- Shot을 Guide media로 위장하거나 native conditioning 경로로 보내는 구현.
- Timeline view range, Export seconds, wrapper length를 근거 없이 하나의 값으로 저장/동기화하는 구현.
- 전체 Prompt document를 오래된 draft로 덮어서 사용자의 후속 본문 편집을 잃는 구현.
- 기존 사용자 계획 문서/미커밋 변경이나 생성물이 아닌 소스 외 파일을 임의로 정리하는 작업.

## 12. 최종 인수 조건

- [ ] 사용자 요구 7개와 추가 보존/rename/Copy 규칙이 모두 구현됨.
- [ ] 새 작성 데이터에 `<Subject N>` / `[Shot N]` index 참조를 자동 저장하지 않음.
- [ ] TS/Python 공통 fixture와 output bundle consistency가 통과함.
- [ ] Shot이 정수 frame 하나로 저장되고 최종 출력에서 seconds로 변환됨.
- [ ] 양방향/자기/순환 참조를 막지 않고 컴파일이 종료됨.
- [ ] Subject/Shot 정의는 마지막 사용처 삭제에도 남음.
- [ ] migration·Snapshot·Undo·Cancel·queue·cache에서 손실이 없음.
- [ ] Guide conditioning 및 ordinary media 출력의 기존 계약이 유지됨.
- [ ] 두 Canvas 수동 검사와 실행한 검사/미실행 검사의 구분을 보고함.

구현 완료 보고에는 변경 파일, 핵심 동작, 실행한 검사와 결과, 남은 제한을 적는다. 실제 H3 checkpoint inference를 수행하지 않았다면 모델 실행 확인 완료라고 쓰지 않는다.
