# H3 Guide / Timeline React UI 구현 명세

작성: 2026-09-11. 상태: **구현 완료; 실제 브라우저 레이아웃 미검증**. 이 문서의 설계와 자동 검증 범위에 따라 제품 코드와 테스트를 구현했다.

## 1. 목표와 최종 결정

**Media에서 소스를 고르고, 고정 높이의 Timeline에서 배치하고, Inspector에서 정확히 수정한다.**

기존 카드 위에 긴 Guide 폼을 덮는 구조를 폐기한다. Media 카드는 미디어와 짧은 역할 표시를 유지한다. Guide 연필 버튼은 같은 노드 안의 Timeline 작업 영역을 열고 해당 소스를 선택한다. 새 모달, 별도 Media 라이브러리, 전체 화면 편집기를 만들지 않는다.

이 계획에서 '현대적'이라는 말은 특정 2026 유행의 재현이 아니다. 안정적인 공간 배치, 명확한 정보 위계, 직접 조작과 수치 입력의 동등한 지원, 실제 데이터에 근거한 피드백, 일관된 선택 상태를 뜻한다. 아래 크기와 시각 규칙은 이 프로젝트를 위한 설계 결정이다.

완료 조건:

- 펼친 Timeline 외곽은 콘텐츠 수, 선택, 오류, 드래그, 메타데이터 도착에 관계없이 **480 CSS px**이다.
- 좁은 노드에서도 외곽 높이는 480px이며, 상세 편집부 위치만 바뀐다.
- Guide가 있는 workflow도 기존 Media React root를 유지한다.
- Guide 상태/검증/Undo, Media 출력, Prompt Shot 의미는 보존한다.
- 실제 Nodes 2.0 / Legacy Canvas에서 높이와 상호작용을 검증한다.

## 2. 현재 코드에서 확인한 출발점

아래는 현재 checkout을 읽은 결과다. 이전 계획 문서와 충돌할 경우 실제 구현과 이 문서의 새 UI 결정을 우선한다. 과거 문서의 'Guide를 React에서 제외' 규칙은 첫 마이그레이션 단계의 제한이며, 이번 단계의 최종 요구사항이 아니다.

| 파일 / 심볼                                                               | 현재 역할                                        | 이번 작업                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `frontend/src/reference-loader/components/loader.ts`의 `#canUseReactView` | Guide 상태를 기준으로 React/legacy를 나누던 경계 | 제거됨. references 모드의 Guide 상태도 같은 React root 사용            |
| 같은 파일의 `#h3Markup`, `#mountH3Timeline`                               | header/axis/details/recovery를 DOM으로 생성      | 제거됨. React 작업 영역이 소유                                         |
| 같은 파일의 `#h3Editor`, `#applyH3Editor`, `#h3DraftIssue`                | Guide draft, 검증, 저장 소유                     | 유지하고 typed callbacks로 연결                                        |
| `components/h3-guide-editor.tsx`                                          | 카드 배치 목록 React + footer portal             | Inspector용 controlled component로 변경                                |
| `components/h3-timeline.ts`                                               | projection 함수와 imperative `H3Timeline` 클래스 | 순수 projection/math/type만 유지; 클래스 제거                          |
| `components/loader-react.tsx`                                             | 일반 Media React root/actions/player host        | H3 카드 동작과 작업 영역 추가                                          |
| `view-model.ts`, `loader-store.ts`                                        | snapshot, 표시 모델, 저장 history                | 기존 경계 확장; 별도 저장 store 금지                                   |
| `h3-media-guides.ts`                                                      | eligibility/placements/counts/검증               | 반드시 재사용                                                          |
| `styles/h3-timeline.css`                                                  | 카드 overlay, 콘텐츠 크기 폼, axis               | 고정 shell/inspector/track 레이아웃으로 교체; legacy overlay/axis 제거 |
| `extension.ts`의 `contentHeight`                                          | `.rl-channels` 끝까지 DOM widget 높이 측정       | `data-loader-content` wrapper 끝까지 측정하도록 수정                   |
| `components/prompt-editor.ts`, `extension.ts`의 `setPromptShots` 연결     | Shot draft/Apply/Cancel/Prompt 연동              | 소유권 유지, footer adapter만 추가                                     |

### 2.1 이전 구현에서 확인한 높이 변화 원인

1. `h3-timeline.css`: `.rl-h3-editor--stack`의 `flex: 1 0 auto`, placements의 `overflow: visible`, 조건부 오류/role/paired 행이 콘텐츠 높이를 확장한다.
2. footer가 다른 카드 영역으로 portal되고, preview는 absolute background다. 편집 폼과 미디어가 서로 다른 높이 기준을 가진다.
3. `H3Timeline.#draw()`는 충돌 회피 행 수에 따라 lane 높이를 `rows * 42 + 6`으로 바꾼다. scroller에는 `max-height`만 있으므로 작은 콘텐츠에서는 축 자체가 작아진다.
4. End, warnings, draft actions, Placement details가 axis 아래에 조건부로 나타난다.
5. legacy render가 axis를 destroy/recreate하고 Guide React 컨테이너를 옮긴다. 상태 보존 코드가 있어도 공간 안정성을 보장하지 않는다.

이는 코드상 원인 후보/확장 경로 확인이다. 이번 문서 작성에서 실제 브라우저의 높이 변화량을 측정하지 않았으므로 특정 한 줄이 유일한 원인이라고 단정하지 않는다.

## 3. 범위와 금지 사항

### 포함

- H3 summary, enable, Media 역할 표시/버튼, Guide Inspector, incomplete recovery, visual/audio/Shot timeline, precise list의 React 렌더링.
- 고정 shell, 내부 overflow, 반응형 배치, 키보드/focus, draft footer, 기존 DnD 복원.
- 기존 Guide-free React 경계의 해제와 workflow/Snapshot restore 확인.
- 한 번의 Guide Apply에 한 번의 기존 Guide history commit. Shot은 기존 Prompt history 사용.

### 제외

- backend, H3 모델 호출, VAE/conditioning, schema/serialization 버전 변경.
- Prompt v6 AST/Lexical 재설계, Subject 편집 UI 변경, Shot duration 저장.
- 실제 생성 영상 재생, playhead/scrubbing, 오디오 믹서, 가짜 waveform, clip trim 핸들.
- 자동 프레임 재배치, 자동 overlap 해결, 자동 Guide 삭제, 출력 duration 입력 추가.
- Zustand/Redux, DnD/timeline/component 라이브러리 추가. 설치된 React와 DOM/CSS로 구현한다.
- node 전체 높이 고정, 일반 Media 전체에 새 내부 scrollbar 추가, 불필요한 ComfyUI hook 변경.

## 4. 화면 구조와 정확한 크기

Timeline은 **Media 채널 목록 바로 아래, Prompt 위**에 둔다. 첫 진입은 기존처럼 접힘이며 toolbar의 Timeline 버튼과 카드 Guide 연필로 펼칠 수 있다. 펼침은 명시적인 사용자 행동이므로 높이 변경을 허용한다. 펼친 뒤 선택/편집으로 높이가 변하면 실패다.

### 4.1 넓은 작업 영역: container width >= 760px

```text
Media cards: [thumbnail + Ref/Guide badges + existing controls]
┌ H3 Timeline                  [Media Guides: On/Off]       [⌄] ┐ 44
│ 24 fps · View range only    [Timeline | List] [1× ▾] [Fit]     │ 40
├──────────────────────────────────────┬────────────────────────┤
│ ruler: 0s       2s       4s       6s │ Inspector              │
│ Images   ◆ G1       ◆ G2            │ thumbnail / filename   │
│ Audio       [G1 source span─────]    │ Frame [48]   2.000s    │ 320
│ Shots    ◆ SH1           ◆ SH2      │ connections / add      │
│ End image: [none / thumbnail]       │ placement list         │
├──────────────────────────────────────┴────────────────────────┤
│ Ready / 1 issue: concise message → Details                    │ 28
│ Guide changes pending                         [Cancel] [Apply]│ 46
└──────────────────────────────────────────────────────────────┘
```

외곽 border 1px × 2 + 행 높이 44 + 40 + 320 + 28 + 46 = 480px이다. 행 구분선은 각 행의 border-box에 포함한다. shell에 추가 상하 padding/gap을 넣지 않는다.

본문은 `grid-template-columns: minmax(0, 1fr) 280px`로 나눈다. 왼쪽 Timeline만 가로 스크롤한다. Inspector는 선택이 없어도 280px 공간을 유지하고 `Select a Guide or a Media source`를 표시한다.

### 4.2 좁은 작업 영역: container width < 760px

외곽480px와 header/tools/status/footer 높이는 동일하다. 본문320px를 `148px 172px` 두 행으로 나눈다. 위148px는 Timeline/List, 아래172px는 Inspector다. 선택할 때 Inspector를 새로 아래에 삽입하지 않는다.

- 설계 하한은320px다. 실제 노드의 기존 최소 너비를 바꾸지 않는다. 320px는 독립 컴포넌트 fixture로 검증한다.
- Header: 좁으면 title을 `Timeline`, enable을 `Guides`로 줄인다. accessible name은 완전한 의미를 유지한다.
- **Timeline/List 전환은 tools 행에만 둔다.** header에는 title, Guides toggle, collapse만 둔다.
- tools에는 `24 fps`, Timeline/List, zoom, Fit을 배치한다. 좁으면 긴 `View range only` 설명은 Info 버튼으로 옮긴다. Info는 Inspector의 Help 화면을 연다.
- 너비 변경으로 form을 unmount하지 않는다. CSS container query로 같은 DOM을 재배치한다.
- 글자를 자동 축소해서 공간을 맞추지 않는다. 긴 소스 이름만 ellipsis 처리한다.

### 4.3 CSS 골격

아래는 구현 출발점이다. 기존 전역 selector와의 우선순위까지 확인한다.

```css
.rl-h3-workspace-container {
  container-type: inline-size;
  min-width: 0;
}
.rl-h3-workspace {
  box-sizing: border-box;
  height: 480px;
  min-height: 480px;
  max-height: 480px;
  display: grid;
  grid-template-rows: 44px 40px minmax(0, 1fr) 28px 46px;
  overflow: hidden;
  border: 1px solid var(--rl-border);
  border-radius: 10px;
}
.rl-h3-workspace *,
.rl-h3-workspace *::before,
.rl-h3-workspace *::after {
  box-sizing: border-box;
}
.rl-h3-workspace__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  min-width: 0;
  min-height: 0;
}
.rl-h3-stage,
.rl-h3-inspector {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.rl-h3-stage {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 40px;
}
.rl-h3-inspector {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
}
.rl-h3-track-scroll,
.rl-h3-list,
.rl-h3-inspector__scroll {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.rl-h3-workspace.is-collapsed {
  height: 46px;
  min-height: 46px;
  max-height: 46px;
  grid-template-rows: 44px;
}
.rl-h3-workspace [hidden] {
  display: none;
}
@container (max-width: 759px) {
  .rl-h3-workspace__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 148px 172px;
  }
}
```

Inspector의 직계 scroll child까지 높이 제약을 전달한다. End dock40px는 End가 없어도 유지한다. List 모드도 같은 stage 공간을 사용한다. 접을 때 header만 보이고 나머지는 hidden으로 유지한다. 펼칠 때마다 root/form을 다시 만들지 않는다.

### 4.4 시각 규칙

- 배경은 기존 `--rl-bg` / `--rl-panel`. 사진 위 blur 폼, 강한 gradient, 중첩 카드 테두리는 제거한다.
- spacing은4/8/12/16px. 본문12px, 제목13px, 보조11px. 숫자는 tabular-nums.
- 일반 버튼32px 높이, 작은 icon도 hit target24px 이상. Apply만 primary 채움, Cancel은 neutral.
- Image Guide는 `--rl-guide-edit`, Audio는 `--rl-accent`, Shot은 기존 녹색을 유지한다.
- 선택 상태는2px outline과 선택 라벨로도 구분한다. 색만으로 종류/오류를 전달하지 않는다.
- Guide는 `G1`, Shot은 `SH1`와 실제 thumbnail/type icon으로 표시한다. 번호는 표시용이며 React key로 쓰지 않는다.
- 오류는 해당 field/marker와 status에 표시한다. 작업 영역 전체를 붉게 만들지 않는다.
- hover/focus 색상만100–150ms transition. height/width/drag 위치 animation은 금지한다. reduced-motion에서는 transition을 끈다.
- thumbnail 미로딩 시 같은 크기의 placeholder를 사용한다. 실제 데이터 없는 waveform/진행률/재생 버튼은 추가하지 않는다.

## 5. 사용자 흐름과 동작 표

화면 문구는 기존 제품에 맞춰 영어를 사용한다.

| 조작                                | 결과                                                              | 저장 시점             |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------- |
| Media의 Guide 연필                  | workspace를 펼치고 해당 source를 Inspector에 표시, 카드 외형 유지 | 저장 없음             |
| 미설정 Media의 G                    | 기존 requireGuide 조건으로 source 편집 시작                       | Apply                 |
| 설정된 Media의 G                    | 기존 Guide enable/disable 처리                                    | 기존 직접 commit 유지 |
| 전체 Guides Off                     | 배치를 보존하고 paused 표시, Shot은 유지                          | 기존 직접 commit 유지 |
| marker 선택                         | 해당 Guide 전체 또는 Shot을 Inspector에 표시                      | 저장 없음             |
| marker drag / 전체 Guide frame 수정 | 연결된 두 channel을 함께 이동                                     | draft 후 Apply        |
| source별 placement frame 확정       | 선택한 source 연결만 수정, paired면 기존 split 규칙               | draft 후 Apply        |
| Timeline Remove Guide               | entry 전체 삭제                                                   | draft 후 Apply        |
| Inspector Disconnect image/audio    | 해당 연결만 해제, 상대 연결 보존                                  | draft 후 Apply        |
| Start/End 제거                      | 해당 역할만 해제                                                  | draft 후 Apply        |
| Apply                               | 현재 scope 검증 후 기존 owner에 commit                            | scope당 기존 commit   |
| Cancel                              | 현재 scope draft 폐기, 저장 상태로 복귀                           | history 추가 없음     |

### 5.1 Source Inspector

구성 순서를 고정한다.

1. 40px thumbnail/type icon, filename, 짧은 Ref/Guide 역할 표시.
2. Image는 `Start / At frame / End` radio group. Audio는 `At frame`만 제공.
3. Frame 정수 input, 읽기 전용 seconds, `Add placement`. Start/End를 골라도 frame 행의 높이를 남기고 disabled 처리한다.
4. 기존 placements를 frame순으로 표시한다. 각 행은 role 또는 frame input, seconds, Disconnect를 포함한다. paired 설명도 같은 내부 scroll에 둔다.
5. Apply/Cancel은 workspace footer에만 둔다. 폼 안에 중복 버튼을 만들지 않는다.

입력 규칙:

- 빈칸/입력 중 값은 string으로 보존한다. 빈칸을0으로 바꾸지 않는다.
- 음수/소수/unsafe integer는 유효하지 않다. 24fps이며 seconds는 소수3자리로 표시한다.
- 기존 `#inputH3DraftFrame`과 `#commitH3DraftFrame`의 역할을 유지한다. React onChange를 확정으로 취급해 매 키 입력마다 paired split을 일으키지 않는다.
- native change 또는 blur 확정 경로를 한 곳에 모으고 Enter→blur로 두 번 처리되지 않게 한다.
- Apply는 현재 유효한 입력을 한 번 확정한 뒤 검증한다. 무효 입력이면 저장하지 않고 field에 focus를 준다.
- Cancel 클릭 때문에 blur가 발생해도 저장 state로 commit하지 않는다. draft 폐기 후 늦게 온 input callback도 무시한다.
- metadata/다른 board 갱신으로 사용자가 입력 중인 frame을 이전 props 값으로 되돌리지 않는다.

### 5.2 Guide 전체 Inspector

`Guide G1`, `Frame [48] · 2.000s`, 연결 Image/Audio, `Move together` 설명, `Remove Guide`를 표시한다.

- 같은 guideId의 visual/audio marker를 함께 선택 표시한다.
- source 한쪽 편집은 `Edit image connection` / `Edit audio connection`이라는 명시적 버튼으로 전환한다.
- Start는 frame0 고정, End는 `Final output frame`이다. 두 역할에는 숫자 이동 input을 제공하지 않는다.
- 선택만으로 dirty를 만들지 않는다.

### 5.3 List, recovery, Help

- Timeline/List는 왼쪽 stage를 전환한다. 아래에 details 행을 추가로 펼치지 않는다.
- List 행: type icon, G/SH, source명, frame/seconds, 상태. 선택하면 Inspector에서 수정한다.
- 정렬: Start → frame순 Guide/Shot(동일 frame은 안정 순서) → End.
- 검색/필터/가상화는 초기 범위에 넣지 않는다. Guide 최대32에 기존 단순 렌더링을 사용한다.
- source가 없는 Guide도 `Missing source`로 표시한다. 기존 recovery Image/Audio select와 처리 함수를 Inspector로 옮긴다.
- 일반적인 소스 선택은 기존 Media Grid에서 한다. recovery용 select를 별도의 Media 라이브러리로 확대하지 않는다.
- source 자동 대체/삭제는 금지한다. 한쪽 연결 삭제 시 상대를 보존한다.
- 기존 `allowIncomplete` 저장 규칙을 유지한다. 저장 가능한 draft와 모델 실행 가능한 conditioning을 동일시하지 않는다.
- status28px에는 `Ready`, `Unsaved changes`, `2 issues · Details` 중 해당 상태를 표시한다.
- 장문은1행 ellipsis로 제한하고 Details가 Inspector의 Issues 화면을 연다. 오류 발생만으로 입력 중 Inspector를 자동 교체하지 않는다.
- Help도 Inspector 내부 화면이다. Back으로 이전 selection/form을 복원한다. Help를 열면서 미확정 입력을 폐기하지 않는다.

### 5.4 Draft와 Shot의 소유권

**Guide와 Shot을 하나의 저장 모델 또는 원자적 복합 commit으로 통합하지 않는다.**

- footer는1개이며 `Guide changes` / `Shot changes`로 scope를 표시한다.
- Guide draft는 Loader controller, Shot draft는 Prompt controller에 남긴다.
- Shot은 기존 `setShotFrameDraft` / `applyShotDraft` / `cancelShotDraft`를 호출한다.
- dirty Guide 중 Shot 수정/다른 source 수정/전체 enable 변경은 실행하지 않는다. `Apply or cancel Guide changes first.`를 status에 표시한다.
- dirty Shot 중 Guide 수정도 같은 방식으로 막는다. 자동 저장/폐기/새 확인 모달을 만들지 않는다.
- 같은 timeline Guide draft 내 다른 Guide 선택은 허용한다. source-specific draft에서 다른 편집 scope로 이동하는 경우 기존 guard를 유지한다.
- 다른 scope를 읽기 전용으로 보는 것은 가능하다. 다만 footer는 dirty owner를 계속 표시하며, 다른 scope의 입력/삭제/drag 시작을 막는다.
- collapse는 draft를 유지한다. header에 pending dot을 표시하고 재확장 시 session/input을 복원한다.
- Prompt의 Subjects & Shots 카드 직접 frame 편집은 현재처럼 즉시 commit한다. Timeline Shot draft와의 충돌 처리는 현재 Prompt 코드에서 확인하고 재사용한다. 오래된 draft로 새 Prompt 값을 조용히 덮어쓰지 않는다.
- Undo/Redo/workflow restore/node 삭제는 기존 restore/cleanup 경계에서 draft/gesture를 종료한다. 종료한 session의 React buffer를 다시 보내지 않는다.
- `extension.ts`의 `setPromptShots` 연결에 필요한 dirty/Apply/Cancel adapter만 보탠다. React에서 Prompt 내부 state에 직접 접근하지 않는다.

## 6. Timeline 데이터와 조작 구현

### 6.1 의미 보존

- FPS=24, 저장 단위는0-based 정수 frame.
- `timelineMarks`, `timelineExtent`, `draggedFrame`를 재사용한다. 기존 동작 변경이 필요하면 해당 경계 테스트를 먼저 추가한다.
- extent는 보기 범위다. 실제 출력 길이는 Wrapper 소유다. End를 현재 화면 우측 frame으로 저장하지 않는다.
- Audio bar는 crop/metadata 기반 source span이다. duration 미확정이면 고정폭 점선 chip과 `Duration unknown`을 표시한다.
- Shot은 cut point다. duration/resize handle/guide와의 shotId 연결을 추가하지 않는다.
- Guide 최대32와 별도 Start/End 제한을 유지한다. Video 및 video-derived Audio는 Guide에 사용할 수 없다.

### 6.2 기하와 안정성

1. ruler28px, Image/Audio/Shot lane을 항상 표시한다. lane 최소48px, marker32px, subrow pitch40px.
2. 가까운 marker는 현재처럼 subrow로 분산한다. 늘어나는 것은 scroll content뿐이다.
3. ruler sticky top, label sticky left. label gutter64px를 시간 좌표 영역에서 분리한다.
4. `x = frame / extent * trackWidth`. trackWidth는 zoom 적용 후의 시간 영역만 뜻한다.
5. marker는 실제 frame의 세로 기준선에서 시작한다. 긴 라벨 때문에 frame 위치를 옮기지 않는다.
6. zoom은1/2/4/8, Fit은zoom1/scroll0. selection/매 render에서 auto Fit을 하지 않는다.
7. 편집 session 중 extent를 고정하고 drag 중 metadata 변화로 축을 재계산하지 않는다.
8. 화면 밖 frame을 숫자로 유효하게 입력한 뒤 또는 명시적 Fit에서 보기 범위를 확장할 수 있다. 저장 frame을 rescale하지 않는다.
9. 오른쪽 끝 marker를0폭으로 잘라버리지 않는다. scroll 가능한 시각 여백을 제공하고 정확한 시간은 Inspector에서도 읽을 수 있게 한다.
10. marker 밀집과 실제 overlap은 다르다. warning은 기존 projection/validator 결과를 사용한다.
11. End dock40px는 비어 있어도 유지하고 `End image: None` 또는 thumbnail/역할을 표시한다.

### 6.3 Pointer lifecycle

- React capture handler 또는 scope가 제한된 native capture listener 한 경로를 사용한다. Nodes 2.0의 bubble 중단을 피하되 같은 이벤트를 두 번 처리하지 않는다.
- primary pointer만 시작한다. id/pointerId/startFrame/clientX/trackRect/extent/scrollLeft를 ref에 기록한다.
- 이동3px 미만은 클릭이다.
- clientX와 getBoundingClientRect의 screen-space 단위를 맞춘다. CSS width와 canvas transform 후 width를 혼합하지 않는다.
- 스크롤 변화도 같은 단위로 환산하거나 최신 rect 차이로 보정한다.
- pointermove는 gesture preview만 갱신한다. 필요하면 requestAnimationFrame으로 한 frame당1회 렌더한다.
- move마다 저장 store/history에 dispatch하지 않는다. paired marker는 같은 previewFrame을 사용한다.
- pointerup에서 controller draft change를 한 번 호출한다.
- Escape/pointercancel/window blur/lost capture/node remove는 현재 gesture를 취소한다. 기존에 편집해 둔 draft 전체를 취소하지 않는다.
- drag 중 외부 view 갱신으로 root를 재생성하지 않는다. 재projection은 종료 후 필요한 것만 적용한다.
- 종료 시 listeners/RAF/capture를 정리한다. drag 직후 click으로 엉뚱한 source 편집이 열리지 않게 suppress한다.
- document listener를 쓴다면 활성 pointerId 외의 이벤트를 소비하지 않는다.

### 6.4 DnD와 접근성

- 기존 Media dragScope/payload를 재사용한다. Image→Image lane, standalone Audio→Audio lane만 허용한다.
- Shot lane, 다른 node scope, Video/derived Audio는 거부한다.
- `#h3GuideDragSource` 검증을 재사용한다. Timeline drop과 카드 reorder/file upload가 동시에 실행되지 않게 한다.
- drop 좌표는 실제 track rect와 scroll/canvas zoom을 반영한다. caret에 배치될 frame을 표시한다.
- drop 후 새 Guide를 draft에 만들고 선택한다. Apply 전 저장하지 않는다.
- marker에서 좌우 화살표±1frame, Shift±24frame, 최솟값0.
- marker에서 Delete/Backspace는 Guide 전체 또는 Shot 삭제다. input/textarea/contenteditable에서는 텍스트 편집만 한다.
- marker는 native button과 aria-pressed, type/source/time을 포함하는 accessible name을 사용한다. 초기 구현에 slider role을 도입하지 않는다.
- Timeline/List는 native button group과 aria-pressed를 사용한다. 불완전한 tab 역할을 붙이지 않는다. 위치는 native radio group이다.
- 모든 drag 작업을 숫자 입력/Add/Remove로도 수행할 수 있어야 한다.
- focus는 stable identity로 복원한다. 삭제 후 다음 marker→이전 marker→stage 순으로 이동한다.
- 편집 종료 시 시작한 Guide 버튼으로 focus를 돌린다.
- live region은 확정/오류만 알리고 pointermove마다 시간을 읽지 않는다.

## 7. 파일별 구현 경계

### 7.1 생산 코드 추가는 기본2개

| 파일                                     | 작업                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| 신규 `components/h3-workspace-react.tsx` | shell/tools/status/footer/List/Inspector 전환. 작은 하위 component는 같은 파일    |
| 신규 `components/h3-timeline-react.tsx`  | ruler/lanes/markers/End/gesture                                                   |
| 기존 `h3-guide-editor.tsx`               | export 가능한 controlled `H3GuideInspector`로 변경. 최종 root/portal factory 제거 |
| 기존 `h3-timeline.ts`                    | 순수 projection/math/type 유지, 최종 imperative H3Timeline 클래스 제거            |
| `loader-react.tsx`                       | workspace와 카드 Guide controls 연결. 기존 player host 유지                       |
| `loader.ts`                              | H3 snapshot/actions 제공, 기존 draft 로직 유지, legacy H3 markup/mount 제거       |
| `view-model.ts`                          | 카드 역할/Guide 표시 및 H3 view snapshot 확장                                     |
| `extension.ts`                           | contentHeight 측정 대상과 Shot adapter 수정                                       |
| `styles/h3-timeline.css`                 | 새 shell/Inspector/axis CSS. 사용하지 않는 overlay CSS 제거                       |
| `styles/tokens.css`                      | 꼭 필요한 semantic token만 추가                                                   |
| 기존 frontend tests                      | 회귀/입력/height fixture 검증                                                     |
| migration/architecture/testing docs      | 완료된 범위와 실제 검증 상태 갱신                                                 |

`h3-media-guides.ts`, reducer, serialization의 의미는 재사용한다. 타입 노출을 위한 최소 수정 외에 상태 모델을 재설계하지 않는다.

### 7.2 View와 callback 계약

아래는 **새로 추가할 타입의 골격**이며 현재 존재하는 API가 아니다.

```ts
type H3Selection =
  | { kind: "source"; mediaId: string; channel: "visual" | "audio" }
  | { kind: "guide"; guideId: string; channel: "visual" | "audio" }
  | { kind: "start" | "end" }
  | { kind: "shot"; tag: string }
  | undefined

interface H3WorkspaceView {
  collapsed: boolean
  selection: H3Selection
  editScope: "none" | "source" | "guide" | "shot"
  sessionId: number // controller 소유, 비저장 counter
  dirty: boolean
  canApply: boolean
  issue?: string
  // marks, roles, source placements, counts는 기존 타입을 재사용
}
```

- 기존 LoaderViewSnapshot/subscription에 H3 표시 snapshot을 추가한다.
- getSnapshot은 알림이 없는 동안 동일한 object를 반환해야 한다. render마다 새 snapshot을 만들어 무한 갱신하지 않는다.
- runtime Map은 읽기 전용 projection에만 사용한다. fetch/player는 controller가 계속 소유한다.
- Guide React key는 guideId+channel, Start/End는 고정 role key다. 배열 index나 frame은 key로 쓰지 않는다.
- 현재 Shot callback은 tag 기반이다. 별도 저장 UUID를 새로 만들지 않는다. Prompt가 stable ID를 이미 공개하면 key에 사용하고, 없으면 기존 tag 경로와 rename 시 selection 재해석/해제를 유지한다.
- React local state는 mode, 미확정 input, Help/Issues, gesture만 소유한다. timeline/Prompt 전체를 useState에 복사하지 않는다.
- sessionId는 restore/새 편집 session에만 변경한다. 같은 session의 metadata 알림마다 form을 초기화하지 않는다.
- 늦게 도착한 callback은 sessionId가 다르면 무시한다.

callback은 다음 기존 메서드에 위임한다.

| 용도                  | 기존 메서드                                              |
| --------------------- | -------------------------------------------------------- |
| source placement 추가 | `#addH3DraftPlacement`                                   |
| Start/End 해제        | `#removeH3DraftRole`                                     |
| source 한쪽 연결 삭제 | `#deleteH3DraftPlacement`                                |
| 입력/확정 분리        | `#inputH3DraftFrame`, `#commitH3DraftFrame`              |
| 전체 Guide 이동/삭제  | `#moveH3TimelineGuide`, `#removeH3TimelineGuide`         |
| 저장/취소             | `#applyH3Editor`, `#closeH3Editor`                       |
| recovery source 수정  | 기존 native change의 해당 분기를 typed callback으로 추출 |
| Shot 편집             | extension의 Prompt callback adapter                      |

selection callback과 mutation callback을 분리한다. React에서 private 메서드 접근을 강제 cast하지 말고 기존 LoaderReactActions와 같은 typed adapter를 추가한다. 검증 로직을 JSX 안에 복제하지 않는다.

### 7.3 Root, DOM, widget 높이

- node당 LoaderReactMount는1개다. H3 enable/draft/restore로 root를 재생성하지 않는다.
- React 소유 subtree에 innerHTML/replaceChildren/append로 개입하지 않는다.
- 기존 native player 전용 host는 유지한다. 그 외 axis/form은 React가 소유한다.
- 최종적으로 `#h3ReactEditor` 컨테이너 이동, axis mount loop, querySelector 중심 focus 처리를 제거한다.
- focus는 stable ref와 필요한 layout effect로 복원한다. 이벤트마다 flushSync를 추가하지 않는다.
- Timeline이 channels 아래에 있으므로 현재 contentHeight의 `.rl-channels` 끝 측정은 부족하다.
- **Media 전체 콘텐츠와 Timeline을 함께 감싸는 `data-loader-content` wrapper**를 두고 기존 min/max callback이 그 끝을 측정하게 한다.
- 현재 root offset-parent 전제를 확인한다. wrapper의 offsetTop+offsetHeight가 실제 끝과 일치해야 한다. 바깥 margin 대신 포함 가능한 padding/gap을 사용한다.
- single-image의250px 하한/남는 공간 preview 사용 규칙은 보존한다. references의360px 하한과 Prompt 인접 배치도 유지한다.
- ResizeObserver에서 읽은 높이를 같은 요소에 계속 쓰는 loop, 매 render node.setSize 호출은 금지한다.
- Media 행 수 변경/명시적 collapse/사용자의 너비 변경으로 전체 node 높이는 달라질 수 있다. 높이 안정 비교 조건은 **동일 너비·동일 Media 상태·동일 펼침 상태의 Timeline 내부 조작**이다.

## 8. 단계별 구현 순서

현재 구현은 Phase 0~4를 완료했고 Phase 5의 자동 검증까지 수행했다. 실제
ComfyUI Nodes 2.0/Legacy Canvas에서의 레이아웃·focus·DnD 수동 검증은 아직
수행하지 않았다.

### Phase 0 — baseline과 계약 확인

1. git status를 기록하고 기존 미커밋 변경을 보존한다.
2. 위 표의 private methods, Prompt callback, recovery handler를 읽는다.
3. 기존 typecheck/frontend tests를 실행하고 기존 실패를 기록한다.
4. 가능하면 현재 UI의 empty/selected/error/many-guide 화면과 실측 높이를 저장한다. 브라우저가 없으면 미검증으로 기록하고 독립 작업은 진행한다.

완료 기준: paired source 편집과 전체 Guide 이동의 차이, Apply/Cancel 소유권을 확인했다.

### Phase 1 — 읽기 전용 고정 shell

1. 새 TSX2개와 CSS를 추가한다.
2. 실제 projection으로 Timeline/List/empty Inspector/status/footer를 렌더한다.
3. Guide-free React에 workspace를 연결하되 아직 기존 H3 legacy gate는 해제하지 않는다.
4. data-loader-content 높이 측정을 연결한다.
5. fixture에서 너비320/560/760/1000/1200 및 Guide0/1/32를 확인한다.

완료 기준: 내용 수와 선택에 관계없이480px이며 Prompt가 Timeline을 덮지 않는다.

### Phase 2 — Media 진입과 Inspector

1. H3 snapshot/action adapter와 React 카드 badge/G/연필을 연결한다.
2. Guide form을 Inspector로 옮기고 새 경로에서 카드 preview overlay/footer portal을 제거한다.
3. source/whole Guide/recovery 편집을 구분한다.
4. input/commit, paired split,32상한,Start/End,Apply/Cancel/Undo를 확인한다.
5. 다른 board 갱신 때 input/selection/focus/scroll이 유지되는지 확인한다.

완료 기준: React 경로에서 source 편집과 recovery가 기존 저장 결과를 만든다.

### Phase 3 — Timeline 조작

1. selection→숫자→keyboard→pointer→DnD 순서로 연결한다.
2. paired preview, cancel, transform 좌표, drag 후 click 억제를 확인한다.
3. Shot callback과 footer scope를 연결한다.
4. dirty scope 전환 방어와 Prompt history 중복 기록 여부를 확인한다.

완료 기준: 모든 직접 조작에 수치/키보드 대안이 있고, drag 중 저장 state가 변경되지 않는다.

### Phase 4 — React 전환 완료와 legacy 제거

1. enabled/Start만/End만/disabled IDs만/incomplete/Shot만 있는 저장 상태를 새 UI에서 확인한다.
2. 그다음 `#canUseReactView`의 Guide 제외 조건을 해제한다. single-image 분기는 유지한다.
3. legacy H3 markup/mount/recovery/card overlay와 imperative H3Timeline 클래스를 호출 검색 후 제거한다.
4. 이전 'H3이면 legacy' 테스트를 '같은 React root, H3 데이터 유지'로 수정한다. 기존 behavior assertion은 유지한다.
5. node remove에서 listener/observer/root/player를 각 소유자가 한 번만 정리한다.

완료 기준: H3 상태 변화로 native board로 바뀌지 않고, 새 CSS와 이전 overlay CSS가 경쟁하지 않는다.

### Phase 5 — 검증과 문서화

아래 자동/브라우저 검증을 수행한다. REACT_MIGRATION/ARCHITECTURE/TESTING에는 실제 완료한 내용만 기록한다. native H3 실행을 하지 않았다면 UI 검증과 분리해 보고한다.

## 9. 검증 명세

### 9.1 자동 검증

기존 테스트를 우선 확장한다.

- `frontend/test/h3-guide-react.test.ts`
- `frontend/test/reference-loader-timeline.test.ts`
- `frontend/test/reference-loader-h3-media-guides.test.ts`
- `frontend/test/reference-loader-react.test.ts`
- `frontend/test/stylesheet.test.ts`

| 영역      | 필수 시나리오 / 기대값                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 저장      | 같은 fixture의 serialized Loader/Prompt 동등성. selection/zoom/view만 바꿔서는 저장 차이 없음             |
| lifecycle | H3 enabled/disabled/draft/restore에도 같은 root,2 nodes 입력 독립,remove 후 listener 무반응               |
| pairing   | image A+audio B의 G1을48→72f 이동하면 양쪽72. source96 입력 중 split 없음,확정 때 기존 규칙으로 한쪽 변경 |
| history   | 여러 Guide draft 수정→Apply→Undo1회로 원상 복귀. Cancel은 history 증가 없음                               |
| 입력      | 빈칸/-1/1.5/unsafe integer 거부,49f=2.042s,Enter/blur/Apply 이중 처리 없음                                |
| roles     | Image Start/End,Audio frame만,32상한,Video/derived Audio 거부                                             |
| 출력 독립 | Guide-only가 일반 ref배열/번호/caption/Prompt mention을 바꾸지 않음                                       |
| recovery  | source 부족 상태 표시/재연결/entry 삭제,한쪽 disconnect는 상대 보존                                       |
| pointer   | threshold,scroll 좌표,cancel/blur/unmount,paired preview,pointerup1회 draft 변경                          |
| keyboard  | ±1/Shift24,Delete/Backspace,input에서는 텍스트 삭제                                                       |
| DnD       | channel/node scope 검사,reorder/upload 중복 처리 없음                                                     |
| scope     | dirty Guide와Shot 사이 mutation 차단,읽기/접기/펼치기 draft 보존                                          |
| metadata  | duration 조회 완료 때 입력/selection 유지,unknown에서 실제 span으로 전환                                  |

기존 fixture/helper를 사용한다. CSS 문자열 assertion은 실제 높이를 증명하지 않는다. 필요하면 기존 timeline 테스트에 변환/스크롤 좌표 경계 테스트를 보탠다. 테스트 프레임워크는 추가하지 않는다.

### 9.2 실제 브라우저 수용 기준

Nodes 2.0과 Legacy Canvas 각각에서 수행한다. 너비는 window가 아니라 workspace container 실측값이다. 실제 노드 가능한560/760/1000px와 독립 fixture320px를 확인한다. canvas zoom0.75/1/1.25를 포함한다.

1. 동일 너비/펼침 상태에서 empty→선택→Guide1/8/32→긴 파일명→복수 오류→audio metadata 도착→List/Timeline 전환을 수행한다.
2. getBoundingClientRect와 computed style로 shell/body/stage/Inspector/footer를 기록한다.
3. canvas transform이 있으면 screen-space 측정을 scale로 정규화한다. 기대 외곽은480 CSS px, 상태 간 차이는1px 이내다.
4. footer의 shell 대비 Y좌표도1px 이내로 유지한다. drag 중에도 동일해야 한다.
5. Guide32/근접 marker는 내부 scroll로 마지막 항목까지 도달할 수 있어야 한다. overflow:hidden으로 내용을 잘라서 성공 처리하지 않는다.
6. 긴 오류/Help/List 전환에도 Apply가 사라지거나 버튼이 밀리지 않는다. 좁은 header가 가로로 넘치지 않는다.
7. 입력 중 unrelated Media metadata/Prompt 알림을 발생시키고 input DOM identity/focus/value/selection을 확인한다.
8. 펼침/접기 후 Media widget 끝과 Prompt 시작이 인접한다. Timeline이 가려지거나 큰 공백이 생기지 않는다.
9. 가로 scroll 후 각각의 canvas zoom에서48→72f drag/drop/keyboard/Cancel을 확인한다.
10. wide idle,wide selected,narrow selected,32-guide scroll,error/recovery의5종 screenshot을 저장해 시각 QA한다.

브라우저 미실행 시 **자동 검증 완료, 실제 레이아웃 미검증**으로 보고한다. height 문제가 해결됐다고 확정하지 않는다.

### 9.3 명령과 결과 보고

리포지토리 script를 우선한다. test와test:unit은 같은 경로이므로 중복 실행하지 않는다.

```powershell
bun run typecheck
bun run test:frontend
bun run fmt:check
bun run lint
bun run test:unit
bun run build
git diff --check
```

개발 중에는 기존 preload로 해당 frontend test만 실행해도 된다. 최종 test:unit에는 frontend 재실행이 포함된다. backend는 최종 검증에서1회 확인하고 UI 편집마다 반복하지 않는다.

Python 직접 실행은uv를 사용한다. Windows temp 권한 문제는 새 workspace 내 basetemp로 구분한다. 기존 무관한 format/lint 실패를 이번 변경의 회귀로 단정하거나 다른 파일까지 전면 수정하지 않는다.

dist는 직접 수정하지 않는다. 기존 build/dev의 CSS 배포 및 cache invalidation 경로를 확인하고 필요한 기존 버전 갱신과 ComfyUI 새로고침 방법을 보고한다. 배포/공개/릴리스는 이번 계획의 범위가 아니다.

### 9.4 이번 구현 결과

자동 검증은 `bun run typecheck`, 전체 frontend test, `bun run test:unit`,
`bun run build`, `bun run fmt:check`, `bun run lint`, `git diff --check` 순으로
실행하고 결과를 최종 응답에 기록한다. 브라우저/실제 ComfyUI가 실행되지 않은
경우에는 Nodes 2.0과 Legacy Canvas의 높이·focus·DnD를 미검증으로 남긴다.

## 10. 구현자 최종 체크리스트

- [x] 새 경로에서 카드의 가변 높이 Guide overlay를 제거했다.
- [x] 펼침480px/접힘46px/좁은 본문148+172px 계약을 CSS와 fixture에서 고정했다.
- [x] 빈 상태/선택/오류/End/32 placements가 외곽 높이를 바꾸지 않도록 shell을 고정했다.
- [x] source 한쪽 변경과 Guide 전체 이동의 paired 의미를 구분했다.
- [x] root/input/stable key/node별 session이 유지된다.
- [x] Guide/Shot owner와 Apply/Cancel/Undo 횟수를 자동 테스트했다.
- [x] Guide가 있는 restore도 React이고 일반 Media/player 경계를 보존한다.
- [x] channels 아래 Timeline이 widget 높이 측정에 포함된다.
- [x] 사용하지 않는 renderer/portal/imperative axis/CSS를 호출 검색 후 제거했다. 외부 파일 drop의 위젯 경계 listener는 호환성을 위해 유지했다.
- [ ] 실제 양쪽 canvas의 높이/focus/DnD를 확인했거나 미검증을 명시했다.
- [x] backend/schema/Prompt AST/new duration/new dependency로 범위를 넓히지 않았다.

## 11. 근거와 참고

파일 경계와 원인 후보는2026-09-11 로컬 코드를 확인한 결과다.480px의 사용성과 시각 완성도는 설계 제안이며 실브라우저 테스트에서 확인한다.

- [React: Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state): component 위치/type/key와 입력 보존의 관계. root/key를 매 갱신 변경하지 않는 근거.
- [React: Choosing the State Structure](https://react.dev/learn/choosing-the-state-structure): 중복 state를 피하는 원칙. 저장 timeline을React에 이중 보관하지 않는다.
- [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/): 역할과 키보드 동작을 함께 구현한다. 이 계획은 native button/input/radio를 우선한다.
- [ComfyUI: Javascript Extensions](https://docs.comfy.org/custom-nodes/js/javascript_overview), [Comfy Hooks](https://docs.comfy.org/custom-nodes/js/javascript_hooks): 기존 extension 경계를 유지하고 UI 변경을 이유로 prototype 개입을 추가하지 않는다.

최종 구현 보고는 변경 파일,단계별 완료 범위,자동 검사 결과,브라우저 결과,미검증 사항을 구분한다. UI test 통과를 native H3 checkpoint 실행 성공으로 표현하지 않는다.
