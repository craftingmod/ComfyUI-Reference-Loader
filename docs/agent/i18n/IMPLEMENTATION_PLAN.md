# Reference Loader i18n 구현안

상태: Draft
작성일: 2026-09-14
범위: ComfyUI 공식 custom-node i18n과 Reference Loader React/native UI

## 1. 목표

- ComfyUI가 제공하는 공식 `locales/` 규칙으로 노드 정의와 설정 문자열을
  번역한다.
- Reference Loader의 React UI, Controller 상태 메시지, native DOM island의
  사용자에게 보이는 문자열을 영어/한국어로 제공한다.
- ComfyUI의 현재 언어를 초기 locale과 실시간 갱신 기준으로 사용한다.
- Prompt 데이터, schema key, slash alias, media identifier, model-facing
  문자열은 번역하지 않는다.
- 저장 상태, history, serialization, ComfyUI graph 계약에는 영향을 주지 않는다.

공식 참고:

- [ComfyUI custom node i18n](https://docs.comfy.org/custom-nodes/i18n)
- [React `useContext`](https://react.dev/reference/react/useContext)
- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)

공식 문서의 `Custom Frontend Component Localization Support`는 아직
`To be updated`이므로, React 컴포넌트가 ComfyUI 내부 Vue i18n 구현에 직접
의존하지 않는다.

## 2. 현재 상태와 제약

- `frontend/src/reference-loader/prompt-i18n.ts`에 이미 `en`/`ko`,
  `LocalizedText`, locale 감지, Prompt 번역이 있다.
- React는 `createRoot`로 surface를 소유하고, `ReferenceLoaderController`와
  `LoaderStore`가 저장 가능한 상태와 history의 canonical owner다.
- `useSyncExternalStore`가 Controller snapshot을 React에 연결하는 기존 패턴이다.
- Prompt contenteditable, waveform/player, image/trim editor의 imperative
  동작, ComfyUI widget lifecycle은 native island 경계로 남겨야 한다.
- 현재 `ReferencePromptController`의 locale은 생성 시점에 캡처되므로, 언어
  변경 후 기존 widget을 갱신하려면 별도 locale notification이 필요하다.
- `.comfyignore`는 root 항목을 기본 제외한다. 공식 `locales/`를 추가하면
  custom-node archive에서 누락되지 않도록 packaging 예외를 추가해야 한다.

## 3. 핵심 결정

### 3.1 추가 라이브러리

기본 구현에서는 `react-i18next`, `i18next`, `vue-i18n`을 추가하지 않는다.

영어/한국어 두 언어와 정적 UI 문자열에는 다음 정도면 충분하다.

- 번역 리소스 두 개
- typed key와 영어 fallback
- locale store
- `t(key, params)` 함수
- React Context 또는 props adapter

다국어가 크게 늘거나 복수형/성별/ICU 메시지, 번역 키 자동 추출이 필요해질
때만 라이브러리 도입을 재검토한다. 라이브러리를 추가해도 Controller와 native
DOM의 locale 동기화 문제는 별도로 해결해야 한다.

### 3.2 번역 리소스 단일 원본

공식 custom-node 경로를 번역 리소스의 원본으로 사용한다.

```text
locales/
├── en/
│   ├── main.json
│   ├── nodeDefs.json
│   └── settings.json       # 필요한 경우
└── ko/
    ├── main.json
    ├── nodeDefs.json
    └── settings.json       # 필요한 경우
```

`main.json`의 React 전용 key는 충돌을 피하도록 namespace를 둔다.

```json
{
  "referenceLoader": {
    "media": "Media",
    "addMedia": "Add",
    "clear": "Clear"
  }
}
```

React 번들은 이 JSON을 정적으로 import하여 사용하고, ComfyUI 공식 i18n
endpoint도 같은 파일을 읽도록 한다. 이렇게 하면 번역 문장을 두 군데에
복사하지 않는다.

### 3.3 locale 상태와 React 생명주기

`i18n.ts`에 `LocaleStore`를 둔다.

```text
ComfyUI locale 변경
        ↓
LocaleStore.set(locale)
        ↓
useSyncExternalStore()
        ↓
React root 재렌더
        ↓
t(locale, key, params)
```

React 컴포넌트는 렌더 시점에 locale을 읽어야 한다. module-level mutable 값,
`useRef`, Controller constructor에서의 영구 캡처만으로는 언어 변경 시 React가
재렌더되지 않으므로 사용하지 않는다.

현재 ComfyUI custom frontend용 locale subscription API가 공개되고 안정적인지
먼저 확인한다. 안정적인 공개 경계가 없으면 다음 순서로 fallback한다.

1. ComfyUI locale 설정/변경 adapter
2. `document.documentElement.lang`
3. `navigator.language`
4. `en`

초기 locale만 필요하면 2~4로 충분하지만, 실시간 변경을 지원하려면 1 또는
명시적인 외부 notification이 필요하다. locale 변경은 저장 상태나 history를
변경하지 않고 view만 다시 계산해야 한다.

## 4. 제안 파일 구조

### 새 파일

- `locales/en/main.json`
- `locales/ko/main.json`
- `locales/en/nodeDefs.json`
- `locales/ko/nodeDefs.json`
- `frontend/src/reference-loader/i18n.ts`
- `frontend/test/reference-loader-i18n.test.ts`

필요한 경우에만 `settings.json`, `commands.json`을 추가한다.

### 수정 대상

- `.comfyignore`: `locales/`와 하위 파일을 archive에 포함
- `frontend/src/reference-loader/prompt-i18n.ts`: 새 공통 translator로 이동하거나
  호환 re-export
- `frontend/src/reference-loader/components/loader-react.tsx`
- `frontend/src/reference-loader/components/h3-workspace-react.tsx`
- `frontend/src/reference-loader/components/h3-timeline-react.tsx`
- `frontend/src/reference-loader/components/h3-guide-editor.tsx`
- `frontend/src/reference-loader/components/prompt-react.tsx`
- `frontend/src/reference-loader/editors/image-editor-react.tsx`
- `frontend/src/reference-loader/editors/trim-editor-react.tsx`
- `frontend/src/reference-loader/components/loader.ts`
- `frontend/src/reference-loader/h3-timeline-session.ts`
- `frontend/src/reference-loader/media-runtime-coordinator.ts`
- `frontend/src/reference-loader/preview-surface-bridge.ts`
- `frontend/src/reference-loader/extension.ts`

실제 수정 파일은 문자열 inventory 결과에 따라 줄인다. 단순히 모든 문자열을
번역 key로 바꾸기 위해 Controller/native island를 React로 재작성하지 않는다.

## 5. 구현 단계

### 단계 0: 리소스와 packaging

- 공식 `locales/en|ko` 디렉터리와 namespace를 만든다.
- `nodeDefs.json`에서 node display name, input/output name, tooltip을 번역한다.
- `.comfyignore`와 `build-custom-nodes` 결과에 locale 파일이 포함되는지 확인한다.
- 영어/한국어 key parity 검사를 추가한다.

### 단계 1: 공통 translator

`frontend/src/reference-loader/i18n.ts`에 다음을 둔다.

- `Locale = "en" | "ko"`
- typed `MessageKey`
- `resolveLocale(input)`
- `t(locale, key, params?)`
- 영어 fallback과 missing-key 처리
- locale snapshot/subscribe/set adapter

번역 함수는 순수 함수로 유지한다. DOM을 직접 수정하거나 React state/history를
소유하지 않는다.

### 단계 2: React 연결

- Media/Prompt/H3 React root에서 locale snapshot을 구독한다.
- Context에는 `locale`과 `t` adapter만 제공한다.
- button text, `title`, `aria-label`, placeholder, empty state를 key로 교체한다.
- locale 변경 시 React가 다시 렌더되지만 media element, waveform, contenteditable,
  focus, selection, drag state는 불필요하게 교체하지 않는다.
- 번역된 문장이 바뀌어도 React key, `data-*` contract, serialized value는
  변경하지 않는다.

### 단계 3: Controller와 native island

Controller가 만드는 사용자 표시 메시지는 가능하면 다음 형태로 보관한다.

```ts
type UiMessage = {
  key: MessageKey
  params?: Record<string, string | number>
}
```

파일명, 서버 오류, validation detail처럼 그대로 보존해야 하는 동적/외부
문자열은 raw fallback으로 남긴다. 사용자에게 보이는 정적 문장과 동적 문장을
분리해 언어 변경 때 재번역할 수 있게 한다.

특히 다음을 구분한다.

- 번역: `Add media`, `No placements yet`, 상태/오류 안내, 접근성 이름
- 비번역: prompt section key, alias, `<Picture N>`, `<Subject N>`, media ID,
  model-facing compiled prompt, 파일명과 사용자 caption

기존 `setStatus(message: string)` 경계는 한 번에 전부 바꾸지 않고, translator
adapter를 통해 점진적으로 `UiMessage`를 지원한다.

### 단계 4: Prompt locale 갱신

- `ReferencePromptController.setLocale(locale)`를 추가한다.
- locale 변경 시 Prompt view snapshot, picker option label, hint, aria/title을
  다시 publish한다.
- Prompt document, history, raw/structured text, caret, IME, serialized output은
  건드리지 않는다.
- 기존 `prompt-i18n.ts` 호출부는 공통 `i18n.ts`로 옮기되 외부 동작은 유지한다.

### 단계 5: 언어별 검증

- React surface를 `en`, `ko`로 각각 mount하여 visible text와 accessibility
  attribute를 확인한다.
- 실행 중 locale을 바꿔도 React root가 갱신되고, Prompt/media state와 history가
  변하지 않는지 확인한다.
- 두 widget instance가 서로의 locale subscription이나 DOM을 공유하지 않는지
  확인한다.
- Nodes 2.0과 Legacy Canvas에서 mount/update/destroy 후 locale subscription이
  정리되는지 확인한다.

## 6. 테스트 계획

### 단위 테스트

- `resolveLocale`: `ko`, `ko-KR`, 미지원 locale, 빈 값, fallback
- `t`: 정상 key, parameter interpolation, 영어 fallback, missing key
- `en`/`ko` message key parity
- `LocaleStore`: subscribe, unsubscribe, 동일 값 no-op, 변경 notification

### React/Controller 테스트

- Loader, Prompt, H3의 영어/한국어 렌더링
- `aria-label`, `title`, placeholder, empty/error/status text
- locale 변경 후 재렌더
- locale 변경이 serialization/history/Prompt compile 결과를 바꾸지 않음
- Controller/native island destroy 후 late locale notification 무시

### 패키징/회귀 테스트

- `locales/`가 `build-custom-nodes` zip에 포함됨
- 기존 Prompt locale 테스트와 저장 workflow compatibility 유지
- 실제 browser에서 Nodes 2.0과 Legacy Canvas 각각 확인

## 7. 검증 명령

```text
bun run fmt:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
bun run build:custom-node
bun run release:check
git diff --check
```

자동 검증만으로 ComfyUI 실제 locale 변경, Nodes 2.0/Legacy Canvas의 focus,
IME, media player, cleanup parity를 증명할 수 없으므로 최종 단계에서 live
browser 검증을 별도 수행한다.

## 8. 완료 조건

- ComfyUI 공식 `locales/`가 node definition/settings 번역을 제공한다.
- Reference Loader의 React와 native UI가 `en`/`ko`로 표시된다.
- ComfyUI 언어 변경 후 새 widget과 기존 widget이 동일한 locale을 사용한다.
- locale 변경이 saved state, prompt output, history, execution payload를
  변경하지 않는다.
- 번역 누락은 영어 fallback으로 안전하게 처리된다.
- 추가 i18n runtime dependency가 없다.
- archive에 locale 리소스가 포함되고, 기존 package/release 검사가 통과한다.

## 9. 보류/재검토 조건

다음 요구가 생기면 `react-i18next` 또는 다른 i18n library 도입을 재검토한다.

- 3개 이상의 언어와 lazy loading
- 복수형/성별/ICU 문법
- 번역 플랫폼 연계와 자동 key extraction
- 번역 리소스가 수백 개 이상으로 증가

그 전까지는 현재의 작은 typed dictionary와 기존 React external-store 경계를
유지한다.
