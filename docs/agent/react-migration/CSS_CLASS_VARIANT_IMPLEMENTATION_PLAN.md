# 일반 CSS class variant 기반 important 정리 실행 계획

작성일: 2026-09-12 · 조사 기준 HEAD: `099b1b6` · 해당 시점의 작업 트리 기준.

이 문서는 구현자가 순서대로 실행할 작업 지시서다. 문서 작성 시점에는 런타임 소스·테스트·빌드 설정을 변경하지 않았고 실브라우저 비교도 수행하지 않았다. 아래 체크박스는 모두 앞으로 수행할 작업이다.

## 1. 목표와 해석

**Tailwind CSS를 설치하지 않는다. Tailwind에서 착안한 “명시적인 클래스 조합과 조건별 스타일” 아이디어를 기존 일반 CSS에 적용한다.**

이 저장소에서는 이를 `기본 클래스 + 외형 variant + 기존 상태 + 배치 클래스`로 구현한다. Tailwind의 `hover:` 문법을 그대로 재현하거나 utility CSS 프레임워크를 만드는 작업이 아니다. 여기서 외형 variant는 이 프로젝트를 위한 구현 용어다.

```html
<!-- 기본 버튼 + 편집 외형 + 카드 안에서의 배치/아이콘 구조 -->
<button class="rl-button rl-button--edit rl-edit-button">R</button>

<!-- 기본 버튼 + 출력 외형 + 기존 ON 상태/접근성 계약 -->
<button class="rl-button rl-button--output rl-output-button is-on" aria-pressed="true">I</button>
```

첫 번째 버튼의 공통 테두리·기본 높이는 `rl-button`, 편집 색상은 `rl-button--edit`, 아이콘 배치는 기존 `rl-edit-button`이 담당한다. 두 번째 버튼의 `is-on`과 `aria-pressed`는 기존 로직이 계속 관리한다.

완료 목표:

- 버튼 관련 `!important` 26개를 제거하고 색상·hover·disabled 우선순위를 설명 가능한 규칙으로 만든다.
- 현재 보이는 크기·색상·아이콘·동작을 보존한다. 의도와 실제 외형이 다르면 실제 외형을 기준으로 기록한다.
- 나머지 3개는 버튼 variant와 분리해서 검토한다. 근거 있는 예외는 남길 수 있다.
- 상태/이벤트/serialization 소유권과 기존 CSS 파일 분리를 유지한다.

금지 사항:

- Tailwind, PostCSS, CVA, tailwind-variants, clsx, tailwind-merge, shadcn 추가.
- `@apply`, `@custom-variant`, 클래스 생성기, 범용 Button 컴포넌트/variant factory 도입.
- 전역 reset, 전체 `@layer` 전환, 전체 버튼/입력/타임라인 마이그레이션.
- 일반 선언을 inline style 또는 `style.setProperty(..., "important")`로 옮겨 개수만 줄이기.
- 클래스 문자열의 앞뒤 순서로 CSS 우선순위를 해결하기.
- 사용자 수정 파일 되돌리기, 전체 문서 재작성, 자동 commit/push/release/deploy.

## 2. 현재 구현에서 확인한 사실

이전 `CSS_DEBT_AUDIT.md`는 `28e5b2f` 기준이다. 현재는 CSS 파일 분리가 진행되었으므로 그 문서의 줄 번호·파일 책임·stylesheet 버전을 그대로 사용하지 않는다.

### 2.1 파일 지도

이하 경로는 저장소 루트 기준이다. 실제 편집 전에 파일을 다시 읽는다.

| 파일                                                              | 현재 책임                          | 이번 작업                                      |
| ----------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `frontend/src/reference-loader/styles/tokens.css`                 | 기존 `--rl-*` 디자인 값            | 값 재사용, 새 토큰 체계 금지                   |
| `frontend/src/reference-loader/styles/base.css`                   | surface/노드 높이                  | 버튼 작업에서 제외                             |
| `frontend/src/reference-loader/styles/controls.css`               | 공통 폼/버튼/primary               | opt-in 기본 버튼과 외형·상태 규칙              |
| `frontend/src/reference-loader/styles/cards.css`                  | 카드 배치/버튼/배지/drop           | 버튼 외형을 controls로 옮기고 배치 유지        |
| `frontend/src/reference-loader/styles/loader.css`                 | toolbar/file label/Clear 등        | 기존 배치 유지, 충돌만 검사                    |
| `frontend/src/reference-loader/styles/h3-workspace.css`           | H3 workspace/footer/reduced-motion | 가려진 primary override 정리, 접근성 별도 검토 |
| `frontend/src/reference-loader/styles/image-editor.css`           | 이미지 편집 UI                     | 숨김 important 별도 검토                       |
| `frontend/src/reference-loader/styles/native-editor.css`          | image/trim 공통 dialog             | padding 등 기존 배치 유지                      |
| `frontend/src/reference-loader/styles/index.css`                  | CSS import 순서                    | 변경하지 않음                                  |
| `frontend/src/reference-loader/components/loader-react.tsx`       | Media 버튼·Add label 생성          | 기존 className에 명시적 클래스 추가            |
| `frontend/src/reference-loader/components/loader.ts`              | native playback 등                 | 읽기: `is-playing` 갱신 주체 확인              |
| `frontend/src/reference-loader/components/h3-workspace-react.tsx` | H3 Apply 등                        | Apply에 클래스 추가                            |
| `frontend/src/reference-loader/editors/image-editor.ts`           | native HTML template               | Apply에 클래스 추가                            |
| `frontend/src/reference-loader/editors/trim-editor.ts`            | native HTML template               | Apply에 클래스 추가                            |
| `frontend/src/reference-loader/extension.ts`                      | ComfyUI widget 연결                | 읽기: host grid 규칙의 경계                    |
| `frontend/src/stylesheet.ts`                                      | CSS 설치/캐시 키                   | 최종 CSS 변경 후 버전 갱신                     |
| `frontend/test/stylesheet.test.ts`                                | stylesheet 구조 검사               | 바뀐 계약에 필요한 검사만 갱신                 |

`package.json`에는 Tailwind/variant 라이브러리가 없다. `frontend/build.ts`는 Bun으로 CSS를 번들링한다. 이 빌드 경로를 유지한다.

현재 import 순서는 tokens → base → controls → loader → cards → prompt → prompt-editor → h3-editor → h3-timeline → h3-workspace → native-editor → image-editor → trim-editor다.

### 2.2 important 목록: 선언 개수 기준

| 위치/selector                                                  |   개수 | 처리 방향                                |
| -------------------------------------------------------------- | -----: | ---------------------------------------- |
| `controls.css`의 `.rl-primary`                                 |      3 | primary variant로 이동                   |
| `cards.css`의 `.rl-remove` 기본/hover                          |      8 | remove variant와 기존 위치 규칙으로 분리 |
| `cards.css`의 `.rl-card__actions button:disabled`              |      3 | 카드 액션 전용 disabled 외형으로 이동    |
| `cards.css`의 `.rl-edit-button` 기본/hover                     |      6 | edit variant로 이동                      |
| `cards.css`의 `.rl-edit-button--guide` 기본/hover              |      6 | guide-edit variant로 이동                |
| `base.css`의 `.rl-reference-loader-widgets`                    |      1 | host grid 예외: 먼저 유지                |
| `h3-workspace.css`의 reduced-motion                            |      1 | 접근성 예외: 먼저 유지                   |
| `image-editor.css`의 `.rl-editor-controls .rl-viewport-values` |      1 | 숨김 규칙 별도 검증                      |
| **합계**                                                       | **29** | **버튼 26 + 기타 3**                     |

### 2.3 반드시 먼저 이해할 충돌

1. `.reference-loader button`은 `.rl-edit-button`보다 specificity가 높다. CSS를 뒤에 놓는 것만으로 항상 이길 수 없다.
2. `.reference-loader button:hover:not(:disabled)`는 더 강하다. 기본 규칙만 낮추고 hover를 그대로 두면 hover 색이 깨진다.
3. `.rl-card__actions button.is-on`, output/guide ON 규칙, disabled 규칙, edit 규칙이 서로 겹친다. 각 버튼에 실제로 매칭되는 모든 규칙을 함께 정리해야 한다.
4. `.rl-h3-workspace__footer .rl-primary`에는 accent 배경·`--rl-bg` 글자 규칙이 있다. 현재 공통 primary의 important가 이를 가린다. important만 삭제하면 가려진 색상이 나타난다. 현재 primary 외형을 유지하고 이 중복 색상 블록을 제거하는 것이 기본 방침이다.
5. Add는 `<button>`이 아니라 file input을 포함한 `<label class="rl-primary rl-file-button">`이다. 태그를 바꾸거나 버튼 전용 disabled 의미를 강제로 적용하지 않는다.
6. G 출력 버튼은 `rl-output-button rl-guide-button`, G 편집 버튼은 `rl-edit-button rl-edit-button--guide`를 함께 가진다. 기존 클래스는 보존하되 새 외형 variant는 각각 하나만 부여한다.
7. H3 footer의 버튼은 현재 `min-height: 28px`이고 기본 버튼은 26px이다. 새 기본 클래스가 이 크기를 덮어쓰지 않아야 한다.

## 3. 클래스 계약

### 3.1 도입할 최소 클래스

| 클래스                   | 담당                           | 적용 대상                                  |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| `rl-button`              | 공통 기본 외형                 | 이번 표에 포함된 컨트롤만                  |
| `rl-button--primary`     | 현재 primary 색상              | Add label, H3/Image/Trim Apply             |
| `rl-button--remove`      | 카드 삭제 색상·강조 글꼴       | 카드 X                                     |
| `rl-button--edit`        | R 편집 색상                    | 일반 reference 편집                        |
| `rl-button--guide-edit`  | G 편집 색상                    | Guide 편집                                 |
| `rl-button--output`      | 일반 출력 OFF/ON               | I/V/VA/A                                   |
| `rl-button--guide`       | Guide OFF/ON                   | G 토글                                     |
| `rl-button--preview`     | preview/playing                | 오디오·비디오 재생                         |
| `rl-button--card-action` | 액션 크기와 disabled 색상 정책 | 카드 액션 행의 모든 버튼, 이동 화살표 포함 |

`card-action`은 크기·사용 맥락 modifier이고 나머지 `primary/remove/edit/guide-edit/output/guide/preview`는 서로 배타적인 외형 variant다. 이동 화살표에는 외형 variant 없이 기본 + card-action만 사용한다. 카드 X는 액션 행 밖이므로 card-action을 붙이지 않는다.

처음부터 `size-sm`, `size-lg`, `tone`, `intent`, `compoundVariants`처럼 사용처 없는 축을 만들지 않는다.

### 3.2 기존 클래스와 상태 보존

- `rl-remove`, `rl-edit-button`, `rl-edit-button--guide`, `rl-output-button`, `rl-guide-button`, `rl-preview-media`, `rl-primary`, `rl-file-button`은 우선 유지한다. 스타일을 옮기는 것과 DOM 계약을 삭제하는 것은 다른 작업이다.
- `is-on`, `is-playing`, `disabled`, 기존 `aria-*`, `data-action`, `data-id`, `data-h3-channel`, `data-playback-owner`를 변경하지 않는다.
- `is-playing`은 `loader.ts`에서 native 로직이 toggle한다. React의 새 상태로 복제하지 않는다.
- 클래스만 추가하고 element type, key, ref, 이벤트 핸들러, stopPropagation, React root 경계는 유지한다.
- 문자열 template의 Apply도 같은 CSS 클래스를 사용한다. React 컴포넌트로 교체하지 않는다.
- `className` 전체를 다시 만드는 코드나 `setAttribute("class", ...)`가 있는지 검사해 새 클래스가 업데이트 때 사라지지 않도록 한다.

## 4. Cascade 설계: 이 방식으로만 시작한다

### 4.1 opt-in으로 기존 기본 규칙에서 제외

새 규칙은 `rl-button`이 있는 요소에만 적용한다. 기존 폼 글꼴·focus 접근성은 보존한다. 기존 버튼의 기본/hover/disabled 외형 규칙에서만 opt-in 버튼을 제외한다.

```css
/* 기존 선언 본문은 유지하고 대상만 좁힌다. */
.reference-loader button:not(:where(.rl-button)) {
  /* 기존 기본 버튼 선언 */
}

.reference-loader button:not(:where(.rl-button)):hover:not(:disabled) {
  border-color: var(--rl-accent);
}
```

같은 변경을 controls의 `.reference-prompt`, `.reference-prompt-definitions`, `.rl-modal` 버튼과 `.rl-file-button` 가지에도 적용한다. 하나만 바꾸고 나머지를 빠뜨리지 않는다. selector list를 삭제할 때 input/textarea/select까지 제거하지 않는다. `:not(:where(...))`를 사용하는 이유는 제외 조건 때문에 기존 selector의 specificity가 증가하지 않게 하기 위해서다.

font와 focus-visible 규칙은 계속 공유해도 된다. 동일 선언을 복사하지 말고 기존 focus 규칙이 새 버튼에도 적용되는지 확인한다.

### 4.2 새 규칙은 낮고 일정한 specificity 사용

새 버튼 규칙의 root scope는 다음과 같이 쓴다. 아래 예제는 구현 패턴이며 전체 완성 CSS가 아니다.

```css
:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal) .rl-button {
  min-height: 26px;
  border: 1px solid var(--rl-border);
  border-radius: 5px;
  background: var(--rl-panel);
  color: var(--rl-text);
  cursor: pointer;
}

:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button:where(:hover:not(:disabled)) {
  border-color: var(--rl-accent);
}

:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button.rl-button--edit {
  color: var(--rl-edit);
  border-color: color-mix(in srgb, var(--rl-edit) 55%, var(--rl-border));
  background: color-mix(in srgb, var(--rl-edit) 10%, var(--rl-panel));
}

:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button.rl-button--edit:where(:hover:not(:disabled)) {
  color: #effff5;
  border-color: var(--rl-edit);
  background: color-mix(in srgb, var(--rl-edit) 25%, var(--rl-panel));
}
```

CSS 선언은 **기본 → 기본 hover → 크기 → 외형 → 조건부 외형 → disabled** 순서로 배치한다.

1. base.
2. base hover.
3. card-action 크기.
4. 외형 variant의 normal 상태.
5. 외형 variant의 ON/playing, hover 및 ON+hover 조합.
6. disabled 공통 cursor/opacity.
7. card-action disabled 색상.

기본은 `(0,1,0)`, 외형은 `(0,2,0)`이다. 상태 조건을 `:where(...)` 안에 넣어 외형 상태도 `(0,2,0)`을 유지한다. 예:

```css
:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button.rl-button--output:where(.is-on:not(:disabled)) {
  color: var(--rl-output);
  border-color: var(--rl-output);
  background: color-mix(in srgb, var(--rl-output) 10%, var(--rl-panel));
}

/* 모든 외형/상태 블록 뒤에 둔다. */
:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button:disabled {
  cursor: default;
  opacity: 0.42;
}

:where(.reference-loader, .reference-prompt, .reference-prompt-definitions, .rl-modal)
  .rl-button.rl-button--card-action:where(:disabled) {
  color: var(--rl-muted);
  border-color: var(--rl-border);
  background: var(--rl-panel);
}
```

primary disabled에는 기존의 opacity/cursor만 적용한다. 카드 disabled 색상 정책을 모든 Apply 버튼에 확대하지 않는다.

ON 예제만 복사하고 hover 조합을 빠뜨리지 않는다. 현재 소스에서는 공통 `.reference-loader button:hover:not(:disabled)`의 `(0,3,1)`이 `.rl-card__actions .rl-output-button.is-on`의 `(0,3,0)`보다 높다. 따라서 소스 기준으로 output/guide ON+hover에서는 border가 accent로 바뀔 수 있다. 기준 화면에서도 이를 확인했다면 새 output/guide variant의 hover border를 accent로 명시하고 ON 규칙 뒤에 둔다. ON 글자색과 배경은 그대로 유지한다. 새 계약의 우선순위가 깔끔하다는 이유로 기존 hover 결과를 바꾸지 않는다.

외형의 hover/ON/playing은 반드시 `:not(:disabled)`로 제한한다. focus-visible outline은 색상 우선순위와 별개로 유지한다. 새 규칙 뒤의 cards.css에 옛 important가 남아 있으면 이 설계가 작동하지 않는다. 해당 외형을 옮기는 단계에서 옛 선언도 함께 제거한다.

### 4.3 크기와 배치는 별도 보존

- `rl-remove`의 absolute/top/right/z-index는 cards에 남긴다. min-width 24px은 배치 규칙에 important 없이 남길 수 있다. 글꼴 800과 색상은 remove variant로 옮긴다.
- `rl-edit-button`의 inline-flex, align/justify, gap, line-height, SVG 크기는 cards에 남긴다.
- 기존 `.rl-card__actions button`의 min-width 26px/padding 2px 5px는 card-action modifier로 옮긴다. 이 행의 이동 버튼에도 modifier를 붙인다.
- Add label의 padding 4px 9px와 inline-flex, native modal의 padding 5px 10px, H3 footer의 min-height 28px/min-width 64px/padding 3px 8px는 현재 배치 규칙에 남긴다.
- 새 base에 `padding`, `display`, `line-height`, `font` shorthand를 무조건 추가하지 않는다. 크기와 글꼴 상속을 바꿀 수 있다.
- 부모 위치에 따라 달라지는 배치를 모두 variant로 옮기지 않는다. 이번 목적은 충돌하는 컨트롤 외형을 분리하는 것이다.

### 4.4 host와 충돌했을 때

`:where()`는 scope의 specificity를 0으로 만든다. 따라서 새 규칙이 ComfyUI의 모든 테마/host CSS를 자동으로 이긴다는 보장은 없다. 실브라우저에서 진 대상 선언을 확인해야 한다.

1. DevTools Styles에서 해당 property의 winner, 파일, selector, inline 여부, layer/important 여부를 기록한다.
2. 프로젝트의 옛 외형 선언이면 새 variant와 중복된 선언을 제거하거나 opt-in을 제외한다.
3. host normal 선언이면 충돌한 property만 해당 root에 한정한 규칙으로 보정한다. 전체 base의 specificity를 올리지 않는다. 필요하면 `:is(.reference-loader, ...)`를 쓴 좁은 보정 규칙을 검토하되 variant/disabled가 계속 이기는지 재계산한다.
4. host inline/important라면 클래스 개수만 늘려 해결하려 하지 않는다. host 규칙을 기록하고 해당 삭제를 보류한다.
5. 중요한 것은 실제 cascade winner다. 클래스 이름의 개수 감소나 `!important` 0개만으로 성공 판정하지 않는다.

이번에는 `@layer`를 도입하지 않는다. host의 unlayered normal CSS가 프로젝트의 layered normal CSS보다 우선할 수 있어 별도 통합 검증이 필요하다.

## 5. 실행 순서와 단계별 종료 조건

한 단계의 변경 → 관련 테스트 → 실제 화면 비교 → 결과 기록을 끝낸 뒤 다음 단계로 이동한다. 여기서 단계는 논리적 변경 묶음이며 자동 commit 지시가 아니다.

### 단계 0 — 시작 상태와 기준 화면 확보

- [ ] `git status --short`, `git diff --stat`, `git rev-parse --short HEAD`를 기록한다.
- [ ] 이 문서의 important 수와 사용처를 현재 소스에서 다시 검색한다.
- [ ] `controls.css`, `cards.css`, 대상 TSX/template, 관련 테스트를 읽는다.
- [ ] `bun run typecheck`, `bun run test:frontend`로 기존 실패를 구분한다.
- [ ] 같은 workflow, node 크기, zoom, 테마로 Nodes 2.0/Legacy Canvas 기준 화면을 확보한다.
- [ ] 표 7의 버튼 상태별 computed style/크기를 기록한다. 아직 못 본 항목은 미검증으로 표시한다.

```powershell
git status --short
git diff --stat
git rev-parse --short HEAD
rg -n --glob '*.css' '!important' frontend/src/reference-loader/styles
rg -n 'rl-primary|rl-remove|rl-edit-button|rl-output-button|rl-guide-button|rl-preview-media' frontend/src frontend/test
rg -n 'is-playing|className\s*=|setAttribute|classList' frontend/src/reference-loader/components
```

**종료 조건:** 변경 전 실패, 대상 DOM, 중요 속성, 현재 외형을 설명할 수 있다. 브라우저가 없으면 정적 작업은 진행할 수 있지만 시각 검증을 통과한 것으로 기록하지 않는다.

### 단계 1 — opt-in 기반과 primary만 이행

- [ ] controls에 4장의 기본·hover·disabled 계약을 추가한다.
- [ ] 기존 버튼 기본/hover/disabled에서 `.rl-button`을 제외한다. 기존 focus와 폼 font는 유지한다.
- [ ] primary의 현재 3개 색상을 `rl-button.rl-button--primary`로 이동한다.
- [ ] Add label, H3 Apply, image Apply, trim Apply 모두에 기본+primary 클래스를 추가한다.
- [ ] 기존 `rl-primary` 클래스는 유지하되 옛 3개 important 선언은 제거한다.
- [ ] H3 footer의 가려진 `.rl-primary` 색상 블록을 제거한다. footer 크기 규칙은 유지한다.
- [ ] hover에서도 기존 primary border가 유지되게 한다. base hover보다 variant가 우선해야 한다.
- [ ] Add 파일 선택, native dialog Apply/Cancel, H3 draft Apply를 검사한다.
- [ ] primary DOM/CSS 검사만 갱신하고 frontend 테스트를 실행한다.

**종료 조건:** important 29 → 26 예상. Add와 세 Apply가 같은 색상 계약을 쓰고 크기·disabled 외형은 각 기존 맥락을 보존한다. 이 단계가 깨지면 카드 이행을 시작하지 않는다.

### 단계 2 — 카드 액션과 remove/edit/output/guide/preview 이행

이 단계 안에서는 새 CSS와 대상 className을 함께 바꾼다. 서로 의존하는 카드 상태 규칙을 반만 옮긴 상태로 완료하지 않는다.

- [ ] 카드 X에 `rl-button rl-button--remove`를 추가한다. 기존 `rl-remove` 유지.
- [ ] 카드 액션 행의 모든 버튼에 `rl-button rl-button--card-action`을 추가한다.
- [ ] 일반 편집은 `rl-button--edit`, G 편집은 `rl-button--guide-edit` 하나만 추가한다.
- [ ] I/V/VA/A에 output, G 토글에 guide, 재생에 preview variant를 추가한다.
- [ ] 이동 화살표는 외형 variant 없이 기본+card-action을 사용한다.
- [ ] cards의 23개 important에서 색상·hover·disabled는 controls로 옮기고, 위치/아이콘 규칙은 남긴다.
- [ ] cards의 generic ON/output ON/guide ON/playing 색상도 같은 단계에서 새 외형 계약으로 옮긴다. 여기에는 important 없는 선언도 포함된다.
- [ ] `.rl-guide-button.is-on`의 파일 하단 중복 규칙도 검색한다. 모든 사용처가 새 계약으로 이행했으면 제거한다. 다른 사용처가 있으면 그 용도만 유지한다.
- [ ] 현재 disabled 색상 정책을 card-action에만 적용한다.
- [ ] 새 ON/playing selector에서 기존 `is-on`/`is-playing`을 읽는다. state setter를 새로 만들지 않는다.
- [ ] 일반 편집 applyingEdit, silent video VA/A, loading preview, enabled+ON/disabled 조합을 검사한다.
- [ ] 재생 시작/정지와 unrelated rerender 뒤에도 새 클래스와 player host가 유지되는지 확인한다.

값을 옮길 때 참고할 기준:

| 외형            | 기본/ON 색상 원본                               | hover 원본                                                       |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| remove          | danger, 65% border mix, `#05070bcc`, weight 800 | 흰 글자, danger border, 38% danger mix                           |
| edit            | edit, 55% border mix, 10% background mix        | `#effff5`, edit border, 25% mix                                  |
| guide-edit      | guide-edit, 55% border mix, 10% mix             | `#fff7e8`, guide-edit border, 25% mix                            |
| output ON       | output 글자·border, 10% mix                     | 현재 ON에서 base hover보다 어떤 border가 이기는지 기준 화면 확인 |
| guide ON        | guide 글자·border, 10% mix                      | 위와 동일하게 현재 결과 보존                                     |
| preview playing | 흰 글자, accent border, 42% mix                 | 현재 playing 결과 보존                                           |

**종료 조건:** 버튼 important 0개, 전체 3개 예상. G/R 구분, 출력별 색상, disabled, 재생 강조가 유지된다. old selector가 새 variant를 재정의하지 않는다.

### 단계 3 — 비버튼 important 3개 별도 판정

#### 3-A. 이미지 viewport 숨김: 제거 후보

- [ ] `image-editor.ts`의 `<fieldset class="rl-viewport-values" hidden aria-hidden="true">`와 내부 값 사용처를 확인한다.
- [ ] `.rl-editor-controls fieldset { display: grid; }` 등 경쟁 display 규칙을 확인한다.
- [ ] 현재 좁은 `.rl-editor-controls .rl-viewport-values { display: none; }`로 important만 제거해도 되는지 실브라우저에서 확인한다.
- [ ] Crop/Mask/Viewport 값 갱신 뒤에도 숨김, 레이아웃 미점유, Tab 접근 불가를 확인한다.
- [ ] fieldset/입력 자체는 삭제하지 않는다. 숨긴 값도 로직에서 참조할 수 있다.

**판정:** 일반 author `display`가 `[hidden]`의 기본 숨김을 덮을 수 있으므로 hidden 속성만 믿고 CSS 전체를 삭제하지 않는다. 이 항목 성공 시 전체 2개 예상.

#### 3-B. Nodes 2.0 grid: 유지 기본값

- [ ] `extension.ts`의 `bindVueWidgetGrid`와 host `node-widgets` 요소를 확인한다.
- [ ] host `grid-template-rows`가 inline인지 utility class인지 DevTools에서 확인한다.
- [ ] 2개 노드, 폭/높이 축소·확대, Media 증가, Prompt 인접 배치와 전체 높이를 검사한다.

**판정:** 실제 host 스타일 충돌을 해소한 증거가 없다면 important 1개를 유지한다. 클래스 variant만으로 normal inline style을 이길 수 없다. 제거를 위해 widget binding이나 host lifecycle을 재설계하지 않는다.

#### 3-C. reduced-motion: 유지 기본값

- [ ] `transition`, `animation`, inline style, host가 부여한 transition을 검색한다.
- [ ] 실브라우저에서 `prefers-reduced-motion: reduce`를 활성화해 H3 상태 전환을 확인한다.
- [ ] 해당 범위의 실제 transition 발생 요소를 모두 특정한 경우에만 일반 선언으로 좁힐 수 있는지 평가한다.

**판정:** 프로젝트 CSS에 transition이 검색되지 않는 것만으로 불필요하다고 단정하지 않는다. 접근성 차단을 보장하지 못하면 기존 규칙을 유지하고 이유를 기록한다.

**단계 종료 조건:** 3개 각각에 제거/유지/미검증과 근거가 있다. 0개를 강제하지 않는다. 기본 예상 최종치는 2~3개지만 실환경 증거에 따라 보고한다.

### 단계 4 — 중복 정리와 최종 검증

- [ ] variant로 옮긴 옛 색상 규칙만 제거한다. layout/아이콘/drag/상태 로직은 남긴다.
- [ ] 기존 클래스가 테스트/동작 hook으로 남아 있으면 이름을 지우지 않는다.
- [ ] Prompt Clear, H3 marker, picker, form 입력 등 미이행 영역은 이번 단계에 확대 편입하지 않는다.
- [ ] controls/card 양쪽에서 동일 버튼 색상을 중복 정의하지 않는지 확인한다.
- [ ] `stylesheet.ts`의 현재 버전에서 증가시킨다. 조사 시 값은 `27`이지만 실행 시 재확인한다.
- [ ] 아래 자동 검증 후 `bun run build`로 dist를 재생성한다. dist를 직접 편집하지 않는다.
- [ ] 실제 ComfyUI가 이 checkout의 dist를 제공하는지 확인하고 `index.css?v=...` 요청 및 Ctrl+F5 이후 적용을 확인한다.
- [ ] 기존 개발 연결이 없으면 배포 완료라고 하지 않는다. 이 계획 자체가 packaged install 교체를 지시하지는 않는다.
- [ ] 변경 전후 파일별 important 수, 상태별 결과, 남은 예외를 최종 보고한다.

## 6. 자동 검증

### 6.1 기존 검사 유지

관련 파일:

- `frontend/test/stylesheet.test.ts`
- `frontend/test/reference-loader-dom.test.ts`
- `frontend/test/reference-loader-react.test.ts`
- `frontend/test/reference-loader-editor.test.ts`
- `frontend/test/reference-loader-h3-media-guides.test.ts`
- `frontend/test/h3-guide-react.test.ts`
- `frontend/test/build-config.test.ts`

필요한 변경만 한다. 새 테스트 프레임워크나 CSS parser를 설치하지 않는다.

1. DOM 검사: 실제 생성된 Add/Apply/R/G/I/V/VA/A/preview/화살표가 올바른 기본·외형 클래스를 갖는지 확인한다.
2. guide와 output의 기존 클래스가 함께 있더라도 새 외형 variant는 하나인지 검사한다.
3. `is-on`, `disabled`, `aria-pressed`, `data-action` 및 기존 행동 검사를 유지한다.
4. stylesheet 검사의 `.rl-primary` 문자열 기대값은 새 selector 계약에 맞게 수정한다. 기존 DOM hook을 유지한다면 DOM의 `.rl-primary` 검사는 그대로 둘 수 있다.
5. 버튼 파일 important 제거 여부를 검사할 수 있지만 CSS 전체 문자열 snapshot으로 외형을 고정하지 않는다.
6. `grid-template-rows: ... !important`를 검사하는 기존 테스트는 grid를 유지하는 동안 유지한다. important 개수를 낮추기 위해 해당 테스트만 삭제하지 않는다.

Happy DOM의 DOM/문자열 검사는 브라우저 cascade, hover, color-mix, container layout 검증을 대신하지 못한다.

### 6.2 실행 명령

단계별 빠른 확인:

```powershell
bun run typecheck
bun run test:frontend
```

최종:

```powershell
bun run fmt:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
git diff --check
git status --short
```

`bun run test`는 현재 `test:unit` 별칭이므로 동일 검사 둘 다 반복할 필요 없다. format 수정이 필요하면 변경 파일만 저장소의 Oxfmt로 포맷하고 diff를 확인한다. 전체 `bun run fmt`로 사용자 문서를 함께 수정하지 않는다. Python 직접 실행이 필요할 때는 `uv`를 사용한다.

release/package 경로를 변경하지 않는 CSS 작업에 버전 bump/tag/publish를 추가하지 않는다. Registry ZIP 검증이 별도로 필요한 인수 범위라면 `docs/TESTING.md`의 `build:custom-node` 절차를 따른다.

## 7. 실브라우저 수용 검사표

각 행을 Nodes 2.0과 Legacy Canvas에서 확인한다. 지원하는 테마에서 동일 조건의 전후 결과를 비교한다. 버튼 하나만 보여 주는 별도 fixture로 host 통합 검사를 대체하지 않는다.

| 대상             | 상태                                 | 확인할 결과                                         |
| ---------------- | ------------------------------------ | --------------------------------------------------- |
| Add label        | normal/hover, 내부 input 키보드 접근 | primary 외형·padding, 파일 chooser 열림             |
| H3 Apply         | enabled/disabled/hover/focus         | 현재 primary 색, 28px 최소 높이, Apply 동작         |
| Image/Trim Apply | enabled/disabled/hover/focus         | 기존 dialog padding과 Apply/Cancel                  |
| 카드 X           | normal/hover/focus                   | danger 색, min-width 24px, 우상단 위치              |
| R/G 편집         | normal/hover/focus, R applyingEdit   | 녹색/주황 구분, 아이콘 15px, disabled 색            |
| I/V/VA/A         | OFF/ON/hover/focus                   | output 색상, aria-pressed와 상태 일치               |
| G 토글           | OFF/ON/hover/focus                   | 일반 output과 Guide 색 구분                         |
| 무음 비디오 VA/A | disabled, 상태 플래그 동시 존재      | muted 색, base border/background, opacity 0.42      |
| preview          | normal/playing/disabled              | playing 강조, 재생/정지, native host 유지           |
| 이동 화살표      | normal/focus/클릭                    | min-width/padding 유지, 순서 이동                   |
| 미이행 버튼      | Prompt Clear/picker/H3 controls      | 기존 hover/focus/크기 유지                          |
| Media drag       | Add/Replace/현재 target/reorder      | 각 overlay 구분과 교체 대상 표시 유지               |
| 노드 크기        | 좁게/넓게/낮게/높게                  | 버튼 wrap, Media/Prompt 높이, single-image 미리보기 |
| 이미지 숨김      | 편집 모드 전환/값 갱신               | viewport fieldset 계속 숨김                         |
| H3 접근성        | reduced-motion ON                    | 불필요한 transition 없음                            |

각 버튼에서 기록할 속성: `color`, `background-color`, `border-color`, `min-height`, `min-width`, padding 네 방향, `font-weight`, `opacity`, `cursor`, `outline`, `getBoundingClientRect()` 폭/높이. 수동 복사나 DevTools로 확인할 수 있으며 범용 수집 도구를 새로 만들 필요 없다.

focus 검사는 마우스 hover와 별개로 Tab/Shift+Tab으로 수행한다. 접근성 속성을 CSS 검증 편의 때문에 새로 붙이거나 지우지 않는다. serialized workflow, Media IDs, Guide 프레임, Apply/Cancel/Undo 경계를 변경하지 않는다.

## 8. 막혔을 때의 판단표

| 현상                            | 먼저 할 일                                           | 하지 말 일                           |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| 새 색이 적용되지 않음           | 같은 property의 옛 important/고특이성 winner 확인    | 파일 맨 끝에 같은 selector 계속 추가 |
| hover에서만 색이 바뀜           | legacy hover opt-out과 variant hover 조건 확인       | hover에 important 복구               |
| disabled에 ON/편집 색이 남음    | variant 조건·disabled 순서·card-action 부착 확인     | 버튼별 inline 색상 지정              |
| H3 Apply 색이 달라짐            | 가려진 footer primary 블록 제거 여부 확인            | 바뀐 외형을 의도된 것으로 간주       |
| H3 Apply가 작아짐               | base specificity와 footer 28px 규칙 확인             | 모든 버튼 min-height를 28px로 변경   |
| 재생 중 클래스가 사라짐         | native class toggle와 React className 갱신 경로 확인 | 별도 React playback state 추가       |
| TS/DOM 테스트는 통과, 화면 깨짐 | 브라우저 computed style과 host CSS 확인              | 자동 테스트 통과만으로 완료 선언     |
| 기존 테스트 실패                | 시작 기준과 비교하고 변경 영향 구분                  | 관련 없는 테스트 기대값 일괄 갱신    |
| 브라우저 접근 불가              | 코드/자동 검증 결과와 미검증 행 기록                 | 시각 회귀 없음이라고 보고            |

사용자의 기존 수정이 섞인 파일에는 `git restore`, `git reset --hard`를 사용하지 않는다. 문제가 생긴 단계에서 자신이 추가한 변경만 되돌리거나 수정하고, 관련 없는 정리는 이어서 하지 않는다.

## 9. 구현자가 남길 결과 양식

아래 양식을 실제 값으로 채운다. 문서의 예상 개수를 검사 결과처럼 복사하지 않는다.

```text
기준 HEAD / 시작 작업 트리:
변경 파일:
적용한 기본 클래스 / 외형 variant / 상태 계약:
important: 시작 N개 -> 최종 M개
버튼 important: 시작 N개 -> 최종 M개
남긴 important: 파일 + selector + property + 유지 이유
자동 검사: 명령별 성공/실패/미실행 및 exit code
실브라우저: Nodes 2.0 / Legacy, 테마, 검사한 상태
전후 외형 차이: 없음 또는 구체적 property와 원인
CSS 빌드 및 캐시 갱신 확인:
미검증 또는 남은 작업:
```

완료 체크:

- [ ] Tailwind나 variant 관련 의존성/빌드 도구를 추가하지 않았다.
- [ ] 버튼 26개 important를 제거했거나, 미제거 항목의 실제 외부 충돌을 명시했다.
- [ ] base/외형/상태/배치의 책임과 disabled 우선순위가 일관된다.
- [ ] primary의 가려진 override를 처리했고 G/R 색상 차이를 보존했다.
- [ ] 기존 class/data/aria/event/native host 계약을 유지했다.
- [ ] 자동 검사와 실브라우저 검사 결과를 구분했다.
- [ ] 남은 important를 0개로 만들기 위해 host/접근성을 훼손하지 않았다.
- [ ] CSS 빌드·캐시 키·실제 제공 파일을 확인했다.
- [ ] 사용자 변경 파일을 보존했다.

## 10. 설계 근거

Tailwind의 공식 문서는 상태 조건을 variant로 표현하는 아이디어를 설명한다. 이 계획은 조건별 스타일을 명시적으로 구성하는 발상만 참고하며, utility class 문법이나 런타임을 채택하지 않는다. [Tailwind: Hover, focus, and other states](https://tailwindcss.com/docs/hover-focus-and-other-states)

`:where()`는 specificity가 0이고, 동일 조건에서 selector specificity와 선언 순서가 승자를 결정한다. normal inline style은 일반 author stylesheet 규칙보다 우선한다. 이 때문에 opt-in/일정한 specificity를 사용하고 host grid는 별도로 판정한다. [MDN: Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascade/Specificity)

normal unlayered 스타일은 normal layered 스타일보다 우선한다. 외부 host의 layer 구성을 통제하지 못하므로 이번 변경에 전체 layer 전환을 섞지 않는다. [MDN: @layer](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40layer)
