# CSS 부채 분석

분석일: 2026-09-12 · 기준 HEAD: `28e5b2f` · 현재 작업 트리 기준.

결론: CSS 규모의 주원인은 H3와 편집 인터랙션이지만, 구 H3 화면과 Prompt migration 잔재, 공통 컨트롤의 cascade 충돌, 파일 간 책임 혼합은 분리해서 정리할 수 있다. 전체 CSS 재작성이나 Tailwind 전환보다 **미사용 규칙 삭제와 동일 선언 병합부터** 시작하는 편이 안전하다.

이 작업은 분석 보고서만 추가했다. 기존 소스·테스트·dist 및 사용자의 수정 중인 문서는 수정하지 않았다. 아래 위치는 분석 당시 파일의 줄 번호다. 경로의 `styles/`, `components/`, `editors/`는 `frontend/src/reference-loader/` 아래를 뜻한다.

## 1. 현황

### 크기와 규칙 수

| stylesheet | lines | bytes (UTF-8) | style rule 수 | selector 수 |
| --- | ---: | ---: | ---: | ---: |
| styles/index.css | 7 | 183 | 0 | 0 |
| styles/tokens.css | 153 | 4,025 | 15 | 62 |
| styles/loader.css | 435 | 9,796 | 57 | 68 |
| styles/cards.css | 363 | 9,280 | 57 | 73 |
| styles/prompt.css | 820 | 17,685 | 114 | 119 |
| styles/h3-timeline.css | 1,380 | 26,691 | 199 | 240 |
| styles/image-editor.css | 328 | 7,155 | 62 | 74 |
| styles/trim-editor.css | 177 | 3,732 | 24 | 24 |
| **소스 합계** | **3,663** | **78,547** | **528** | **660** |
| dist/index.css | 1 | 66,776 | 538 | 659 |

측정 방법: Bun으로 파일을 읽어 물리적 줄 수와 UTF-8 byte 수를 집계했다. 주석을 제외한 leaf declaration block 중 `@` 규칙 및 keyframe step을 빼서 style rule을 세고, selector list의 괄호·attribute 내부를 제외한 쉼표로 selector를 나눴다. 중복 selector도 출현 횟수에 포함한다. 범용 CSS AST 분석기나 브라우저 coverage는 아니며, 현재 파일의 평평한 CSS와 media/container 구조를 대상으로 한 정적 집계다. dist는 minifier의 규칙 분할·병합과 pseudo 표기 정규화가 있어 소스 규칙 수와 일대일 대응하지 않는다.

### selector·상태 분포

아래 값은 해당 구문을 포함하는 selector 수이며 서로 중첩된다. class는 파일 내 고유 class 이름 수다. pseudo-class는 hover/focus/disabled/empty/not 등, pseudo-element는 `::before`, `::after`, `::backdrop`, `::placeholder`, range track/thumb 등을 포함한다.

| 파일 | 고유 class | .is-* 포함 | data-* 포함 | pseudo-class 포함 | pseudo-element 포함 | !important 선언 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tokens.css | 8 | 0 | 2 | 23 | 0 | 4 |
| loader.css | 37 | 18 | 14 | 7 | 6 | 0 |
| cards.css | 39 | 20 | 10 | 5 | 7 | 23 |
| prompt.css | 65 | 25 | 2 | 20 | 5 | 0 |
| h3-timeline.css | 111 | 32 | 0 | 10 | 2 | 1 |
| image-editor.css | 32 | 14 | 10 | 1 | 5 | 1 |
| trim-editor.css | 14 | 0 | 1 | 2 | 5 | 0 |

소스 `!important`는 총 **29개**, 그중 **23개가 cards.css**에 집중되어 있다. H3 CSS에 data selector가 없다는 것은 DOM 계약이 없다는 뜻이 아니다. Controller는 `data-timeline-guide`, `data-h3-draft-field` 등으로 H3 DOM을 찾는다(`components/loader.ts:1142,1541,1732`). `.has-error`, `.has-issue`, `[aria-pressed]`, `[aria-checked]`, `[aria-disabled]`, `[hidden]`도 별도 상태 계약이다.

반응형/접근성 규칙은 H3의 `@container` 320px·759px와 reduced-motion, trim 파일의 viewport 760px media query다. Loader에는 spinner keyframes가 있다. `min-width: 0` 81회, `color: var(--rl-muted)` 63회, `display: grid` 56회, `font-size: 10px` 32회가 반복된다. 이러한 빈도는 추출 후보를 찾는 지표일 뿐, 각각의 flex/grid 축소 조건까지 중복 부채라는 뜻은 아니다.

### 생성·로딩 경로

1. `frontend/src/index.ts:7`에서 `styles/index.css`를 import한다.
2. `styles/index.css:1`의 순서는 tokens → loader → cards → prompt → H3 → image editor → trim editor다. **현재 cascade 계약의 일부**다.
3. `frontend/build.ts:9`의 Bun browser ESM/minify 설정이 CSS를 별도 번들로 만든다. `buildFrontend()`는 먼저 dist를 지우고 재생성한다(`:24`). `package.json`의 `build`는 typecheck 뒤 이 함수를 실행한다.
4. `__init__.py:16`의 `WEB_DIRECTORY = "./dist"`로 ComfyUI가 배포물을 제공한다.
5. `frontend/src/index.ts:10` → `frontend/src/stylesheet.ts:4`의 `installStylesheet()`가 module URL 옆 `index.css?v=23`을 `<link>`로 설치한다. 고정 ID로 중복 link를 방지하고 오래된 href를 갱신한다.

현재 dist는 65.2 KiB의 비압축 minified CSS다. 네트워크 전송 압축 크기나 실제 style recalculation 시간은 측정하지 않았다. 크기만으로 사용자 체감 성능 저하를 단정할 수 없다. 동일 buildConfig로 outdir만 생략한 메모리 빌드 결과가 현재 dist CSS와 문자열까지 일치했다.

### 기능 복잡도와 부채의 구분

- **필요한 복잡도:** H3 lane/겹침 행/marker/End dock/숫자 frame 편집/확대·가로 스크롤, 별도 Guide·Shot 상태, Media의 추가·교체·정렬 drop overlay, waveform/player, crop/mask/pan canvas, native dialog, Prompt의 Lexical contenteditable·chip·picker, 반응형과 키보드 상태. H3+Prompt가 소스 byte의 약 56.5%지만 이 전체를 부채로 볼 수 없다.
- **정리 가능한 부채:** 남아 있는 구 H3 header/summary, 이전 Prompt tag/body host CSS, 완전히 같은 declaration block, 공통 button 위에 다시 쓰는 색상/크기, tokens의 layout 책임, image/trim 상호 의존, 문자열 테스트에 고정된 옛 CSS.
- **유지보수 위험:** tokens의 광범위한 descendant button 규칙을 개별 class가 이기려고 `!important`를 쌓는다. 예를 들어 `.reference-loader button`은 `(0,1,1)`, `.rl-edit-button`은 `(0,1,0)`이다. 단순히 important만 제거하면 후자의 색이 유지되지 않는다. Loader 파일 drag 강조 selector 중에는 `(0,6,0)`인 것도 있지만, media 종류와 대상 상태를 함께 표현하는 부분이므로 specificity만으로 삭제 대상은 아니다(`loader.css:260`).

### 최근 증가 원인: git evidence

| commit | CSS 변화 | 해석 |
| --- | --- | --- |
| `519c1d3` (09-11) | H3 +719/-219, 순증 500줄 | React workspace, Timeline/List/Inspector 추가. 구 card overlay 일부는 제거했으나 앞부분 header/summary 규칙은 남음 |
| `439d31f` (09-12) | H3 +23줄 | FPS/frames 표시 추가 |
| `28e5b2f` (09-12) | H3 +97/-35, 순증 62줄 | FPS/frame 표시와 관련 UI 확장 |
| `c3e3297` (09-09) | Prompt +102/-41 | Prompt category UI 개선 |
| `34bc887` (09-10) | Prompt +18줄 | v5 → v6 정리 중 Lexical 관련 스타일 추가 |
| `40e1a90` (09-10) | Prompt +6/-2 | rich editor/reference chip 변경에 비해 CSS 잔재 정리가 작음 |

이는 최근 변경을 설명하는 근거이며, 모든 추가 줄을 불필요한 증가로 계산한 것은 아니다. `git log --stat`와 `git show`로 확인했다.

## 2. 파일별 책임과 문제

| 파일 | 현재 책임 | 문제 | 위험도 | 근거 위치 |
| --- | --- | --- | --- | --- |
| tokens.css | theme token, 기본 글꼴·컨트롤, widget/root 레이아웃 | token과 surface sizing·Nodes 2.0 override·primary variant 혼합. 광범위 button selector가 후속 override를 유발 | 높음 | `:1`, `:27`, `:56`, `:77`, `:106`, `:149`; `extension.ts:440` |
| loader.css | Media toolbar/channel/grid/upload, single-image sizing | Prompt Clear/heading과 동일 선언. 숨긴 file input 반복. single-image/card override가 cards.css와 교차 | 중간; sizing은 높음 | `:23`, `:45`, `:60`, `:222`, `:296`, `:368`; `prompt.css:24,71` |
| cards.css | card media/player host/배지·output·edit/상태 | direct media와 native-host video 선언 동일. 23개 important. H3 배지 일부는 H3 파일에 있음 | 높음 | `:104`, `:123`, `:178`, `:245`, `:297`, `:315`; `loader.ts:1287,1336` |
| prompt.css | Prompt shell/definition/section/Lexical/picker | 구 body-host·tag 규칙 잔존. Clear 공통화 가능. 오래된 CSS 문자열 테스트가 잔재 보존 | 높음 | `:71`, `:380`, `:494`, `:506`, `:572`; `prompt-reference-node.tsx:35`; `stylesheet.test.ts:210` |
| h3-timeline.css | 구 shell + Guide editor + Media badges + 현재 workspace/Timeline/List | 삭제된 shell과 현행 UI 혼재, track-scroll 두 블록, primary의 효과 없는 override, 긴 inspector descendant override | 높음 | `:1`, `:94`, `:184`, `:545`, `:596`, `:838`, `:851`, `:1271` |
| image-editor.css | 공통 modal + 이미지 stage/crop/mask/controls | 공통 modal과 trim field/footer까지 담당. trim 파일을 읽어야 이미지 responsive 규칙을 찾음 | 높음 | `:1`, `:90`, `:172`, `:293`, `:314`; `trim-editor.css:170` |
| trim-editor.css | video preview, waveform, selection/playhead, range/transport | image editor 파일의 modal·field 기반 스타일에 의존. 마지막 media query는 image layout 책임 | 높음 | `:1`, `:25`, `:55`, `:80`, `:151`, `:170`; `trim-editor.ts:164,266,292` |
| styles/index.css | import 순서 | 파일 이동 시 cascade를 바꾸기 쉬움. 자체 중복은 없음 | 중간 | `:1` |
| stylesheet.ts / build.ts / dist/index.css | 배포·캐시·로딩 | source와 dist 직접 수정 혼용 금지. 변경 시 cache version과 테스트 기대값 동기화 필요 | 중간 | `stylesheet.ts:2`; `build.ts:24`; `stylesheet.test.ts:179` |
| docs/REACT_MIGRATION.md | migration 경계 설명 | 상단은 H3 React 완료, 하단은 Timeline native/Guide 추후 복원으로 서술하여 현재와 초기 계획 혼재 | 중간 | `:3`, `:92`, `:103`, `:155`, `:178` |

문서보다 현재 코드를 우선했다. H3는 현재 React interaction이며 native Timeline으로 되돌리는 계획은 부적절하다. Prompt 역시 현재 `PromptRichEditor`/Lexical과 `PromptReferenceNode`를 사용한다. native island 보존 원칙은 유효하되, 구 Prompt body host를 현행 host로 오인해서는 안 된다.

## 3. 정리 후보

### 사용처 확인 방법과 한계

CSS의 class 이름을 추출하여 **frontend/src 전체 TS/TSX**와 대조한 뒤, `rg`로 template literal, `classList`, `dataset`, `querySelector`, `closest`, native editor markup 및 관련 테스트를 다시 확인했다. components만 보면 `extension.ts`의 widget class를 놓치므로 검색 범위를 넓혔다. 테스트의 문자열 출현을 런타임 사용으로 계산하지 않았다.

단순 문자열 대조에서 40개 파일별 class 후보가 나왔지만 이것은 미사용 수가 아니다. 예를 들어 `rl-kind--${card.kind}`(`loader-react.tsx:575`), `rl-prompt-definition--${definition.kind}`(`prompt-definitions-react.tsx:85`), `is-${alias.command}`(`prompt-react.tsx:532`), reference icon의 동적 kind/missing(`prompt-reference-node.tsx:96`)은 실제 사용된다. selector 전체가 DOM에서 매칭되는지는 브라우저 coverage로 별도 확인해야 한다.

| 분류 | 후보 | 근거·처리 경계 |
| --- | --- | --- |
| **삭제** | 구 `.rl-h3-timeline` shell와 `__header/collapse/toggle/status/summary/body/hint/error`, `.rl-h3-media-counts`, `.rl-h3-summary-*` | `h3-timeline.css:1–90,98–182`; 현재 TS/TSX에 해당 class 생성 없음. 현재 shell은 `h3-workspace-react.tsx:490`. **94줄의 `.rl-h3-media-guides`와 현행 `rl-h3-timeline__lane/mark` 등은 제외** |
| **삭제** | `.rl-h3-editor__roles`, `.rl-card__guide-badges`, `.rl-h3-workspace__info`의 미사용 가지 | `h3-timeline.css:258,307,545,720,728`; TS/TSX 사용처 없음. selector list 전체를 지우지 말고 해당 가지/전용 블록만 삭제. `.rl-h3-editor__actions`, `.rl-h3-card-badges` 등은 현행 |
| **삭제** | `.rl-guide-index` 가지와 단독 규칙 | `cards.css:178,212`; 생산 코드 사용처 없음, `reference-loader-h3-media-guides.test.ts:262`도 absence를 확인. 공통 badge 블록의 나머지는 유지 |
| **삭제** | 이전 `.rl-prompt-definition__body-host`, `.rl-prompt-section__body-host`, `.rl-prompt-section__body` 규칙 | `prompt.css:380,494,506,537`; 현재 class 생성 없음. host absence는 `reference-prompt-react.test.ts:229,388,998`에서 확인. **현행 `.rl-prompt-definition__body`는 유지**. section body 문자열 검사는 현행 Lexical DOM 검사로 교체 |
| **삭제** | 구 `.rl-prompt-tag` 및 해당 class에만 붙은 state/pseudo 규칙 | `prompt.css:572–623`; 현재 reference chip은 `.rl-prompt-mention.rl-prompt-subject` 및 실제 child icon(`prompt-reference-node.tsx:46`). 문자열 테스트(`stylesheet.test.ts:236,273`)도 함께 갱신해야 함. `is-shot` 같은 공유 state 이름 자체는 삭제하지 않음 |
| **공통 primitive 추출** | Media/Prompt Clear normal·hover | `loader.css:45,50` ↔ `prompt.css:71,77` 선언 완전 동일. 먼저 기존 selector list 병합, 필요할 때만 primitive class 추가 |
| **공통 primitive 추출** | file input 숨김, card media fill | `loader.css:60,222` 동일; `cards.css:104,123` 동일. DOM과 host selector를 그대로 두고 선언만 공유 가능 |
| **공통 primitive 추출** | 컨트롤 border/bg/text/radius, danger·selected·badge·panel 기반 | `tokens.css:106`, `cards.css:255`, `image-editor.css:45,299`, `h3-timeline.css:294,752,1148`. 크기·cursor·resize·pointer 동작은 surface에 남김. 배지는 이미 `cards.css:176`에서 일부 공통화되어 있어 새 추상화가 무조건 필요하지 않음 |
| **surface별 이동** | tokens의 root/layout 및 widget override | `tokens.css:27–80` → base/widget 영역, token 선언은 원래 scope 유지. 이 단계에서 `:root`로 전역화하지 않음 |
| **surface별 이동** | 공통 dialog와 editor field/footer | `image-editor.css:1–68,293–327`을 공통 native-editor 영역과 이미지/trim 고유 영역으로 구분. `trim-editor.css:170`의 이미지 responsive 규칙은 이미지 쪽으로 이동 |
| **surface별 이동** | H3 Media badge와 workspace/Inspector/Timeline | `h3-timeline.css:545,596,844,1271`. 실제 공유 소비자를 기준으로 분리; Guide 편집과 무관한 카드 스타일을 Timeline 파일에 묶지 않음 |
| **selector 유지** | `.rl-card`, `.rl-card__media`, `.is-file-drop-target`, `.is-playing`, `[data-video-preview-host]` | `loader-react.tsx:130,1089`; `loader.ts:1287–1348`. 실제 class 조회·poster 전환·native player 삽입 계약 |
| **selector 유지** | `.rl-h3-timeline__mark/lane`, `[data-timeline-guide]`, draft field, current rich-editor·picker attribute | `h3-timeline-react.tsx:499,537,598,739`; `loader.ts:1541,1732`; `prompt-react.tsx:137`. pointer/focus/editor 연결 지점 |
| **selector 유지** | `.reference-image-loader` → React root → surface 높이 체인과 `.rl-reference-loader-widgets` | `tokens.css:56–80`; `extension.ts:440–462`. 반복 height/min-height는 부모-자식 크기 전달 계약 |
| **검증 후 판단** | important 제거와 primary 충돌 | `tokens.css:149`의 important가 `h3-timeline.css:838`의 primary 색·배경·border override를 모두 이김. 현재 외형을 유지하려면 후자의 효과 없는 선언 삭제 후보; H3 의도 색상으로 바꾸는 것은 별도 시각 변경. cards 23개 important 일괄 삭제 금지 |
| **검증 후 판단** | 높은 specificity, reset 중복, `--rl-guide`/`--rl-guide-edit` 같은 값의 의미 token | H3 inspector 3단 class, workspace box-sizing, 같은 주황색 token 등. 값이 같아도 역할은 다를 수 있음. theme·disabled·focus와 computed style 확인 후 병합 |

`h3-timeline.css:851,859`의 인접한 동일 `.rl-h3-timeline__track-scroll` 블록은 충돌하는 property 없이 병합할 수 있다. 이는 selector 삭제가 아니라 동일 selector의 선언 정리다. 서로 다른 surface에 있는 단순 `display:flex; gap:6px`까지 모두 utility로 만드는 것은 파일 의존성과 markup 변경을 늘려 이득이 작다.

## 4. 단계별 계획

| 단계 | 변경 파일 | 기대 효과 | 회귀 위험 | 필요한 테스트 |
| --- | --- | --- | --- | --- |
| **1. 시각 변화가 거의 없는 정리** | H3/cards/Prompt CSS, stylesheet.test.ts, stylesheet.ts, dist; migration 문서의 현재/과거 구분 | 위에서 확인한 미사용 전용 규칙/가지 삭제, track-scroll 병합, 구 CSS 문자열 테스트 교체. 실제 쓰이는 DOM/class는 그대로 | 낮음~중간. 미사용 판정 누락, selector list의 현행 가지까지 삭제할 위험 | typecheck·frontend 전체·build, 구 selector absence + 현행 renderer의 대체 DOM assertion. 좁고 넓은 노드의 전후 이미지 비교 |
| **2. primitive와 token 책임 정리** | tokens/loader/cards/prompt CSS 및 index.css; 필요 시 base.css·controls.css 추가 | Clear, input 숨김, media fill부터 공유. token/base/widget 책임 구분, button cascade 경쟁 축소 | 중간~높음. import 순서·specificity·disabled/focus 우선순위와 token 상속 | 버튼 normal/hover/focus/disabled/selected 조합 computed style, 두 노드 및 modal의 theme 비교. stylesheet 계약과 기존 테스트 |
| **3A. H3 별도 단계** | h3-timeline.css와 필요 시 workspace/editor CSS, index.css; H3 테스트 | workspace/Timeline/Inspector/Media badge의 소유권 명확화. 실제 frame·lane 레이아웃은 보존 | 높음. container 기준 변경, marker 좌표·겹침·scroll·focus 손실 | Timeline 테스트의 drag/cancel/restore, Guide+Shot Apply/Cancel/Undo, 320/759px 경계, 확대·노드 scale·End/out-of-range 실브라우저 |
| **3B. Prompt·native editor 별도 단계** | prompt/image-editor/trim-editor CSS, 공통 native-editor CSS 필요 시 추가, index.css 및 관련 테스트 | 현행 Lexical CSS와 picker/definition shell 분리, modal 공유 책임 정리 | 높음. contenteditable caret/IME, native dialog 좌표, range thumb hit target, crop/pan/mask 변경 | rich editor local history·chip ID·Raw/Structured·composition, editor open/apply/cancel/abort/cleanup, waveform/VA playback 및 resize 실브라우저 |
| **4. 선택적 Tailwind/shadcn pilot** | 신규 또는 독립 React 표시 surface 1개, 해당 CSS·빌드/의존성 설정만 | CSS primitive 정리 이후 작성 편의·번들·override 수를 비교하는 작은 실험 | 중간~높음. reset/global CSS와 native dialog/ComfyUI theme 충돌, 두 스타일 체계 동시 유지 | 기존 class/data 계약 유지, 전역 reset 유입 검사, 전후 CSS/JS byte 비교, Nodes 2.0·Legacy·modal focus/theme 검사. 이득 없으면 pilot만 되돌림 |

각 단계는 별도 변경으로 리뷰한다. 1단계에서 Prompt 잔재 삭제는 해당 대체 DOM 테스트와 함께 작은 변경으로 분리할 수 있다. common primitive는 기존 selector를 묶는 것부터 시작하며, 시각적 유사성만으로 TSX 마크업이나 event selector를 바꾸지 않는다. token 정리와 `!important` 축소도 한 번에 하지 않는다.

pilot은 채택 권고가 아니라 선택지다. 현재 package.json에 Tailwind/shadcn 도입은 없고, CSS 문제 해결에 새 프레임워크가 필수적이지 않다. 진행 시점에 공식 설치/격리 방법을 확인한다. Timeline marker, contenteditable, crop/trim, permanent host를 첫 pilot 대상으로 삼지 않는다. `docs/REACT_MIGRATION.md:185`의 CSS 유지 경계와도 일치시킨다.

모든 단계에서 저장 schema/serialization/backend 의미는 유지한다. LoaderState·Guide/Shot draft·graph transaction은 Controller 경계를 유지하고, Prompt v6 parts와 definition/reference ID를 CSS 정리로 바꾸지 않는다. 현행 Lexical `HistoryPlugin`(`prompt-rich-editor.tsx:549`)의 focused-editor Undo와 Loader/graph history도 구분해서 보존한다.

## 5. 검증 계획과 이번 실행 결과

### 자동화: 이번에 확인한 것

| 항목 | 이번 결과 | 증명 범위 |
| --- | --- | --- |
| `bun run typecheck` | **통과, exit 0** | 현재 TypeScript 계약 |
| `bun run test:frontend` | **245 pass / 0 fail, 24 files, 1,675 assertions, exit 0** | 현재 DOM·state·editor·CSS 문자열·build config 테스트 |
| `bun run build` | **명령 그대로는 미실행** | 원래 명령이 dist를 삭제·재작성하므로 분석 중 파일 보존을 위해 실행하지 않음 |
| 동일 config의 메모리 Bun build | **통과, exit 0, build logs 없음** | `Bun.build({...buildConfig, outdir: undefined})`; CSS 66,776 bytes가 현재 dist와 정확히 일치. JS 762,390 bytes도 생성되지만 JS 동등성은 비교하지 않음 |
| selector 정적 조사 | **수행** | 전체 TS/TSX literal 대조 후 동적 class·Controller/native handler 교차 확인. 실제 모든 상태의 coverage를 증명하지 않음 |
| ComfyUI Nodes 2.0 / Legacy Canvas 실브라우저 | **미실행** | layout·실제 pointer capture·paint·focus·player 검증 완료로 보고하지 않음 |

후속 실제 정리에서는 반드시 `bun run typecheck`, `bun run test:frontend`, `bun run build`를 실행하고 배포물과 cache version을 함께 갱신한다. `git diff --check`와 변경 파일 범위도 확인한다. 이번 메모리 빌드는 정식 build의 dist 삭제/기록 경로까지 시험한 것은 아니다.

### CSS selector/contract 테스트 보강

1. 문자열의 존재만 검사하지 말고 실제 React/Controller가 만든 DOM에 selector가 매칭되는지 확인한다. 예: `.rl-prompt-tag`의 CSS를 요구하는 테스트를 현행 `.rl-prompt-subject` 및 `S/SH` child icon 확인으로 바꾼다. 삭제 대상에 대한 absence assertion도 추가한다.
2. 동적 `rl-kind--*`, definition kind, alias icon, `.is-*`는 유한한 상태 fixture와 결합한다. data attribute는 `dataset` camelCase와 JSX kebab-case를 모두 조사한다. 전체 문자열 검색 0건을 자동 purge 근거로 삼지 않는다.
3. CSS 파일 이동 시 파일명에 묶인 문자열 테스트를 책임에 맞게 갱신하되, selector/속성 계약 검증을 단순 삭제하지 않는다. happy-dom의 layout/computed style을 실제 브라우저와 동등한 증거로 보지 않는다.
4. `reference-loader-react.test.ts:53`의 permanent root, `h3-guide-react.test.ts`의 keyed field/focus, `reference-loader-timeline.test.ts:299,317,364,642`의 transaction/gesture/cleanup, `reference-prompt-react.test.ts:365,475,970`의 body identity/history를 유지한다.
5. card/native host의 DOM identity·player instance·waveform canvas를 unrelated rerender 전후 비교하고, restore/삭제 시 listener·RAF·player cleanup을 확인한다. `loader.ts:1336`의 media host와 `trim-editor.ts:310–315`의 정리 경계가 기준이다.

### 실브라우저 acceptance: 두 canvas에서 따로 기록

- **Sizing:** Reference Loader와 Load Reference Image를 좁게/넓게, 낮게/높게 각각 resize. root→React host→surface→preview의 computed height/min-height/overflow와 `getBoundingClientRect()` 기록. Media는 intrinsic, 남는 높이는 Prompt, single-image는 contain으로 남는 공간을 채워야 한다. Nodes 2.0 widget grid class와 Legacy DOM widget 연결도 각각 확인한다.
- **Media:** 이미지·투명 이미지·오디오·유음/무음 비디오로 add/replace/reorder/empty/active overlay를 비교. disabled output과 G/VA/A, poster↔player, waveform loading/error, Snapshot menu keyboard/focus 확인. 무관한 caption 변경으로 재생이 중단되거나 native host가 교체되지 않아야 한다.
- **H3:** Timeline/List, Start/End/Guide/Shot, 겹친 lane, output boundary와 out-of-range, 확대/가로 scroll, pointer cancel/Escape, keyboard delete, numeric frame 편집, 320/759px container 경계. draft Apply/Cancel/Undo와 restore 후 동일 ID/frame 확인.
- **Prompt:** Raw/Structured, 한글 IME, 선택/caret, 복사·붙여넣기, local Undo/Redo, `@/#/` picker, Subject/Shot rename/reorder 및 stale reference. 색상과 pseudo 표시를 보존하면서 v6 parts·ID·직렬화 결과가 같아야 한다.
- **Native editor:** dialog/backdrop/keyboard close, crop corner/pan/zoom/mask/restore, trim 양쪽 thumb/seek/playhead, Apply/Cancel와 dirty backdrop 보호, node 제거 중 editor cleanup. 좁은 viewport와 theme, focus-visible·aria-disabled·reduced-motion도 확인한다.
- **복원:** 두 node instance에서 save/reload, Snapshot restore, Undo/Redo 후 비교. CSS-only 변경으로 serialized workflow가 달라지지 않아야 한다. Queue 확인은 별도 runtime 수용 검사이며 CSS 테스트가 native H3 generation을 보장하지 않는다.

`docs/TESTING.md`의 수동 절차를 기반으로 전후 screenshot·computed style·console 결과를 남긴 뒤 시각 회귀 없음으로 판정한다. 자동화 통과만으로 실브라우저 검증 완료라고 하지 않는다.

## 마지막 요약

### 지금 바로 정리할 것

1. 사용처 없는 구 H3 shell/summary 및 미사용 selector list 가지.
2. 현행 Lexical 대체 DOM 테스트와 함께 구 Prompt body-host/tag CSS.
3. 인접 track-scroll 블록과 동일 file input/media fill 선언 병합.
4. Media/Prompt Clear 선언 공유와 옛 CSS 문자열 테스트 정리.
5. REACT_MIGRATION 문서의 현재 구현/초기 계획 구분.

### 현재는 유지할 것

1. H3 lane/marker/frame editor, container 대응 및 접근성 상태.
2. `.rl-card`·drop/playing state와 native video/waveform host 계약.
3. 현행 Lexical contenteditable/chip/picker와 editor history 경계.
4. single-image의 전체 높이 체인과 Nodes 2.0 widget sizing override.
5. native dialog/crop/mask/trim의 pointer·range·cleanup 규칙.

### 추가 확인 없이는 건드리지 않을 것

1. cards의 important 일괄 제거와 H3 primary 외형 변경.
2. token의 전역화, import 순서·specificity·reset 체계 변경.
3. React root/native host 재생성 또는 실제 동작 selector 이름 변경.
4. schema/serialization/workflow restore 및 Controller·Lexical history 소유권.
5. 전체 Tailwind/shadcn 전환이나 시각적 유사성만으로 만든 전역 primitive.
