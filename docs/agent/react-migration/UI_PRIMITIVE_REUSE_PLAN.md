# UI Primitive 내부 재사용안

상태: 구현 전 계획
작성일: 2026-09-12

## 1. 결정

`frontend/src/reference-loader/ui/`의 컴포넌트는 현재 ComfyUI Reference
Loader 번들 안의 다른 React surface에서만 재사용한다.

이번 범위에는 다음을 포함하지 않는다.

- npm 패키지, public export, 별도 UI bundle 또는 배포용 entry 추가
- 다른 ComfyUI extension이나 독립 React 앱에서 사용할 수 있는 디자인 시스템화
- Tailwind, shadcn/ui, Radix, 외부 state library 추가
- React가 Controller, history, serialization, native media/editor를 소유하도록 변경

현재 primitive는 “완결된 visual component”보다 markup, native props, 접근성,
상태 표현을 공유하는 내부 contract component로 취급한다. 실제 surface의
layout, ComfyUI data attribute, Controller action, native host는 각 surface가
계속 소유한다.

## 2. 적용 가능한 host 경계

Primitive를 사용하는 React subtree는 다음 중 하나의 descendant여야 한다.

- `.reference-loader`
- `.reference-prompt`
- `.reference-prompt-definitions`
- `.rl-modal`

이 경계 안에서 `frontend/src/index.ts`가 전체 stylesheet를 한 번 로드한다.
`tokens.css`는 위 host에 `--rl-*` token을 정의하고, `controls.css`는 host 안의
`.rl-button`을 스타일링한다. 따라서 primitive 파일만 import하면 동일한
스타일이 자동으로 따라온다고 가정하지 않는다.

관련 소유 파일:

- `frontend/src/reference-loader/styles/tokens.css`
- `frontend/src/reference-loader/styles/controls.css`
- `frontend/src/reference-loader/styles/ui.css`
- `frontend/src/reference-loader/styles/index.css`
- `frontend/src/index.ts`
- `frontend/src/stylesheet.ts`

Sidebar, bottom panel, 독립 dialog 등 기존 host 밖에 새 React surface를
추가하는 것은 이 계획의 범위가 아니다. 그런 surface가 필요해지면 먼저
별도의 theme host와 CSS loading 경계를 설계한다.

## 3. Primitive별 재사용 계약

| Primitive       | 사용 가능 범위                                                                             | 사용하지 않을 범위                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `Button`        | native button props, `ref`, `className`, `data-*`, `aria-*`, primary/secondary/danger/busy | `<label>` 기반 file picker, button이 아닌 host element                                |
| `Field`         | 한 개의 native `input`, `select`, `textarea`와 label/description/error 연결                | `contenteditable`, inline chip editor, props/ref를 DOM까지 전달하지 않는 복합 control |
| `ToggleGroup`   | `aria-pressed`를 사용하는 mode/tool 선택                                                   | `role="radio"`/`aria-checked` 그룹, listbox, autocomplete picker                      |
| `StatusMessage` | error/warning/loading/success 상태를 나타내는 단순 paragraph                               | 상태가 아닌 일반 도움말, 지속 상태를 alert로 읽히면 안 되는 영역                      |
| `EditorFooter`  | history와 Cancel/Apply가 고정된 editor transaction                                         | Prompt/H3처럼 다른 `data-*` action contract를 갖는 footer, Apply가 없는 form          |

primitive는 state store나 domain action을 만들지 않는다. 호출부가
`value`/snapshot과 callback을 전달하고, 기존 Controller 또는 editor bridge가
실제 변경을 처리한다.

## 4. Surface별 적용안

| React surface      | 적용                                                                                                                  | 제한                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image Editor       | 현재 적용 유지: `Button`, `Field`, `ToggleGroup`, `StatusMessage`, `EditorFooter`                                     | canvas, crop overlay, mask preview는 native ref와 editor 전용 CSS 유지                                                                                      |
| Trim Editor        | 현재 적용 유지: `Button`, `Field`, `StatusMessage`, `EditorFooter`                                                    | waveform, audio/video player, playback bridge는 native island 유지                                                                                          |
| Loader React       | `Button`을 일반 button에 우선 적용하고, 단순 상태에는 `StatusMessage` 사용                                            | file input을 감싼 `<label>`은 `Button`으로 바꾸지 않음. Loader에는 공통 editor footer를 추가하지 않음                                                       |
| H3 Workspace       | 일반 action과 Timeline/List 선택에는 `Button` 사용 가능. `ToggleGroup`은 `aria-pressed`인 Timeline/List view에만 후보 | Position은 `role="radio"`/`aria-checked` 계약이므로 기존 radio group 유지. H3 footer는 `data-h3-action`을 유지하고 `EditorFooter`를 직접 사용하지 않음      |
| Prompt React       | toolbar/action button에 `Button` 적용 가능                                                                            | `data-prompt-action`, picker `role="option"`, rich editor/contenteditable 구조를 보존. `Field`/`ToggleGroup`/`EditorFooter`는 일반화 목적으로 적용하지 않음 |
| Prompt Definitions | toolbar button과 단순 error/status에 `Button`/`StatusMessage` 적용 가능                                               | tag/frame native control의 기존 layout과 `data-prompt-action`을 보존. draft footer는 기존 Apply/Cancel contract 유지                                        |

### Button 적용 규칙

`Button`은 native button attributes를 전달하므로 기존 `className`, `data-*`,
`aria-*`, event handler, ref를 그대로 넘긴다. 다음 attributes는 primitive가
관리하므로 호출부가 덮어쓰지 않는다.

- `className`의 `rl-button` 및 variant class
- `data-state`, `data-variant`
- `disabled`, `aria-busy`

기존 delegated handler가 특정 `data-*`를 찾는 경우 그 attribute를 JSX에
그대로 남긴다. 단순히 button을 교체하면서 selector나 action 이름을 바꾸지
않는다.

### Field 적용 규칙

`Field`의 child는 실제 DOM control 하나로 제한한다. custom React control을
전달할 경우 `id`, `aria-describedby`, `aria-invalid`가 최종 native element에
도달하는지 먼저 확인한다.

현재 구현은 child의 `id`와 `htmlFor`를 동시에 다르게 지정하면 child에는
child `id`를, label에는 `htmlFor`를 사용해 연결이 깨질 수 있다. 넓은 재사용
전에 다음 중 하나를 적용한다.

1. label에는 항상 계산된 `controlId`를 사용한다.
2. `htmlFor`를 제거하고 child의 `id`만 public 입력으로 허용한다.

현재 사용처처럼 child `id`와 `htmlFor`를 지정하지 않는 native control은 이
문제의 영향을 받지 않는다.

### ToggleGroup 적용 규칙

`ToggleGroup`은 선택 상태를 `aria-pressed`로 표현하는 button group에만
사용한다. radio semantics가 필요한 H3 Position에는 적용하지 않는다.

재사용 전에 keyboard 범위도 보강한다. 현재 arrow navigation이 부모
fieldset의 모든 `button`을 검색하므로, legend나 확장 markup에 button이
추가되면 group 밖의 button이 포커스 순서에 포함될 수 있다. group이 직접
렌더링한 button만 검색하도록 범위를 제한한다.

선택 상태의 시각 스타일은 surface CSS가 소유한다. `image-editor.css`와
`h3-workspace.css`에 이미 surface별 `aria-pressed` 규칙이 있으므로 이를
primitive 내부로 옮기지 않는다.

### StatusMessage 적용 규칙

`error`와 `warning`은 기본적으로 `role="alert"`이다. 사용자가 즉시 알아야
하는 오류에만 기본값을 사용하고, H3 status row나 draft 안내처럼 지속적인
상태에는 필요할 때 `role="status"`와 적절한 `aria-live`를 명시한다.

### EditorFooter 적용 규칙

`EditorFooter`는 다음 구조가 정확히 일치하는 editor에서만 사용한다.

- 선택적 history 영역
- Cancel callback
- Apply callback
- primary Apply 및 busy/disabled 상태

H3와 Prompt는 각각 `data-h3-action`과 `data-prompt-action`을 사용하고
transaction owner도 다르므로, 기존 footer를 공통 component로 교체하지
않는다. 공통 footer가 정말 필요해질 때만 action attribute를 props로
추가하는 별도 변경을 검토한다.

## 5. 구현 순서

1. `Field`의 label/control ID 계약과 `ToggleGroup`의 keyboard 검색 범위를
   먼저 수정하고 각각 regression test를 추가한다.
2. Loader, H3, Prompt의 일반 action button 중 하나의 surface씩 `Button`으로
   교체한다. 각 교체 후 기존 `data-*`, class, ref, delegated/direct handler를
   확인한다.
3. 기존 alert/status paragraph 중 semantic status가 동일한 것만
   `StatusMessage`로 교체한다. 지속 상태의 `role`과 `aria-live`를 확인한다.
4. label이 필요한 native form control에만 `Field`를 적용한다. surface별
   grid/flex layout은 각 CSS 파일에 남긴다.
5. H3 Timeline/List view처럼 `aria-pressed` contract가 이미 있는 그룹에만
   `ToggleGroup`을 적용한다. radio group과 picker는 제외한다.
6. Image/Trim Editor의 `EditorFooter`는 현재 동작과 동일한지 유지 확인만
   하고, H3/Prompt로 확장하지 않는다.

## 6. 검증 기준

각 surface 변경 후 다음을 확인한다.

- 기존 `data-*` selector와 action callback이 한 번만 실행된다.
- React root 재생성, Controller 이중 state, native host 교체가 없다.
- focus, keyboard, disabled/busy, error/status announcement가 유지된다.
- workflow/Snapshot serialization과 history에는 변화가 없다.
- 기존 `rl-*` class와 stylesheet import 순서가 유지된다.

저장소 검증 명령:

```text
bun run typecheck
bun run test:frontend
bun run build
bun run lint
git diff --check
```

자동 테스트는 component markup과 action contract를 확인하지만 Nodes 2.0과
Legacy Canvas에서의 실제 크기·theme·focus 동작까지 증명하지 않는다. 여러
surface를 변경한 경우 두 ComfyUI runtime에서 host 크기, resize, keyboard,
node removal cleanup을 별도로 확인한다.

## 7. 완료 조건

- Image/Trim Editor의 현재 primitive 사용이 유지된다.
- Loader/H3/Prompt에는 contract가 실제로 일치하는 primitive만 적용된다.
- `Field` ID와 `ToggleGroup` keyboard 범위의 regression test가 있다.
- `EditorFooter`를 다른 footer에 억지로 적용하지 않는다.
- 새 dependency, public export, 별도 build entry, state store가 추가되지 않는다.
- typecheck, frontend tests, build, lint, diff check가 통과한다.
