# CSS 부채 분석 프롬프트

아래 프롬프트를 저장소 분석용 Codex 작업에 사용한다.

```text
이 저장소의 CSS 부채를 실제 코드 기준으로 분석해줘.

목표는 즉시 재작성하는 것이 아니라, 중복·미사용·책임 혼합·유지보수 위험을
구분하고 안전한 정리 순서를 만드는 것이다. 분석 중에는 파일을 수정하거나
대규모 리팩터링을 하지 마라.

## 먼저 확인할 범위

- frontend/src/reference-loader/styles/*.css
- frontend/src/reference-loader/components/**/*.{ts,tsx}
- frontend/src/reference-loader/editors/*.ts
- frontend/src/stylesheet.ts
- frontend/build.ts 및 dist/index.css
- 관련 테스트와 docs/REACT_MIGRATION.md

rg 등으로 CSS selector가 실제 TypeScript/TSX에서 사용되는지 확인하고,
가능하면 git history로 최근 CSS 증가 원인도 확인해라.

## 반드시 구분할 것

1. 실제 기능 복잡도로 필요한 CSS
   - H3 Timeline, lane/marker, frame editor
   - drag/drop, preview, waveform, canvas overlay
   - native dialog/editor, contenteditable Prompt
   - responsive 및 accessibility 상태

2. 정리 가능한 CSS 부채
   - 중복된 button/input/select/badge/panel 규칙
   - 같은 token과 declaration의 반복
   - 사용되지 않는 selector와 오래된 migration 잔재
   - 과도한 specificity와 불필요한 !important
   - tokens.css에 섞인 component/layout 규칙
   - surface 간 책임이 섞인 규칙

3. 보존해야 하는 동작 계약
   - .rl-* class 중 Controller와 native event handler가 사용하는 것
   - .is-* 상태 class와 data-* attribute
   - React root/native island host의 DOM 수명
   - Prompt contenteditable, Timeline pointer/drag, waveform/player,
     image/trim editor lifecycle
   - ComfyUI Nodes 2.0과 Legacy Canvas의 widget sizing/override
   - 저장 schema, serialization, workflow restore, history 동작

## 출력 형식

다음 순서로 간단하고 근거 있게 보고해라.

### 1. 현황

- stylesheet별 lines, bytes, rule 수
- selector/state/pseudo-element 및 !important 분포
- dist/index.css의 생성·로딩 경로
- CSS가 무거운 원인을 기능 복잡도와 부채로 나누어 설명

### 2. 파일별 책임과 문제

표 형식으로 `파일 / 현재 책임 / 문제 / 위험도 / 근거 위치`를 작성해라.

### 3. 정리 후보

각 후보를 `삭제`, `공통 primitive 추출`, `surface별 이동`, `selector 유지`,
`검증 후 판단` 중 하나로 분류해라. 시각적으로 비슷하다는 이유만으로
동작 selector를 삭제 대상으로 분류하지 마라.

### 4. 단계별 계획

- 시각적 변화가 거의 없는 1단계
- 공통 primitive 및 token 정리 단계
- H3/Prompt/native island를 다루는 별도 단계
- 선택적인 Tailwind/shadcn pilot 단계

각 단계마다 변경 파일, 기대 효과, 회귀 위험, 필요한 테스트를 적어라.

### 5. 검증 계획

- `bun run typecheck`
- `bun run test:frontend`
- `bun run build`
- CSS selector/contract 테스트
- ComfyUI Nodes 2.0 및 Legacy Canvas 실브라우저 확인

자동화 통과와 실브라우저 검증을 분리해서 보고해라.

마지막에는 “지금 바로 정리할 것”, “현재는 유지할 것”, “추가 확인 없이는
건드리지 않을 것”을 각각 최대 5개로 요약해라.
```

