# React Migration 종료 전 Checklist

작성일: 2026-09-12  
대상 브랜치: `frontend/refine1-react`  
기준 브랜치: `main`  
현재 기준: `main` 대비 60커밋 앞섬, `HEAD=02da553`

이 문서는 React 마이그레이션을 더 확장하기 위한 계획이 아니라, 현재 작업을
어디까지 완료로 선언하고 `main`에 병합할지 정하기 위한 종료 문서다.

## 1. 현재 판단

현재 코드는 다음 단계에 있다.

- Prompt, ordinary Media, H3 Guide/Timeline의 React surface와 Controller adapter가
  구현되어 있다.
- 저장 상태, reducer, validation, serialization, history, ComfyUI graph
  transaction은 React가 아니라 기존 Controller/Store 경계가 소유한다.
- image/trim editor는 React dialog surface와 기존 imperative editor logic이
  공존한다. 내부 로직 전체를 React로 다시 작성하는 것은 이 migration의 필수
  조건으로 삼지 않는다.
- 자동 fixture는 넓게 작성되어 있지만, Nodes 2.0과 Legacy Canvas의 실제
  browser parity는 별도 merge gate다.
- 현재 작업 트리에는 이 문서와 별도로 미커밋 UI/CSS 변경이 있다. 그 변경은
  아래 자동 검증 기록에 포함되지 않았을 수 있으므로 branch-only 결과와
  분리한다.

## 2. 범위 고정

### 이번 migration의 포함 범위

- [ ] React와 native DOM의 production ownership 중복 제거
- [ ] Prompt React shell/editor의 serialization, restore, IME, picker, focus parity
- [ ] ordinary Media와 single-image surface의 mount, update, upload, preview,
      reorder, cleanup parity
- [ ] H3 Guide/Timeline surface의 상태 보존, draft transaction, drag/drop,
      keyboard, restore parity
- [ ] image/trim dialog의 React host와 기존 editor/controller 경계 명시
- [ ] ComfyUI widget lifecycle과 node removal cleanup 검증
- [ ] 문서와 실제 production path의 일치 확인

### 이번 merge에서 제외할 범위

다음 항목은 별도 후속 작업으로 기록하고, 현재 migration의 완료 조건에 섞지
않는다.

- Controller를 더 작은 클래스로 분해하는 장기 리팩터링
- Raw import/export 기능
- UUID AST의 추가 설계 및 새 authoring 기능
- 전체 CSS debt를 0으로 만드는 작업
- native media element, waveform, ComfyUI widget bridge를 React로 억지로 대체
- native MiniMax H3 checkpoint/inference 검증

## 3. Surface별 진행 상황

| Surface | 현재 owner | 현재 상태 | 종료 전 남은 gate |
| --- | --- | --- | --- |
| Prompt shell | React root | 구현 및 fixture 진행 | 두 Canvas live mount/resize/focus 확인 |
| Prompt body/chip/picker | React + Lexical, Controller canonical state | 구현 및 fixture 진행 | IME, selection, restore, queue 직전 serialization live 확인 |
| Subject/Shot definitions | 별도 React root, Controller draft/transaction | 구현 및 fixture 진행 | widget 추가/삭제, rename, frame, Apply/Cancel live 확인 |
| ordinary Media | React view, `ReferenceLoaderController`/`LoaderStore` | 구현 및 fixture 진행 | focus, upload/drop, preview/player host, restore live 확인 |
| single-image Loader | React view, shared Loader controller | 구현 및 fixture 진행 | replacement, edit, cleanup live 확인 |
| H3 Guide/Timeline | React workspace, Loader controller draft | 구현 및 fixture 진행 | 두 Canvas의 높이, focus, DnD, zoom, restore live 확인 |
| image editor | React dialog surface + imperative draft/editor logic | 부분 전환 | native island 경계와 cleanup을 확정; 전면 재작성은 불필요 |
| trim editor | React dialog surface + imperative playback/history logic | 부분 전환 | native media island 경계와 cleanup을 확정; 전면 재작성은 불필요 |
| CSS | 기존 `.rl-*` CSS + 신규 React surface CSS | 진행 중 | selector ownership, build/cache key, live theme 확인 |
| backend/contracts | 기존 state/manifest/prompt contracts | migration과 함께 변경됨 | frontend migration과 독립적으로 backend suite 확인 |

## 4. 구현 종료 Checklist

### State와 ownership

- [ ] 저장 가능한 Loader/Prompt 상태의 canonical owner가 하나다.
- [ ] React가 별도 saved-state store 또는 history를 만들지 않는다.
- [ ] 하나의 사용자 action이 React와 native 경로에서 중복 dispatch되지 않는다.
- [ ] React root는 widget instance마다 하나만 생성되고 idempotent하게 destroy된다.
- [ ] Controller가 React-owned subtree를 `innerHTML` 또는 `replaceChildren()`로
      덮어쓰지 않는다.
- [ ] 남겨진 native island마다 render owner, action owner, cleanup boundary가
      문서화되어 있다.

### Prompt

- [ ] Structured 모든 section body가 의도된 React editor 또는 명시된 native
      island owner를 가진다.
- [ ] Raw/Structured 전환에서 source text와 stable identity가 보존된다.
- [ ] media mention, Subject, Shot chip이 rename/reorder/restore 뒤 올바르게
      유지된다.
- [ ] `@`, `#`, `/` picker의 query, caret, keyboard, outside close가 한 경로로
      동작한다.
- [ ] IME, paste, Backspace/Delete, selection, local undo/redo가 보존된다.
- [ ] 두 Prompt instance가 서로의 picker, selection, subscription을 오염시키지
      않는다.
- [ ] Prompt widget 제거 시 React root, picker ref, subscription, Controller가
      모두 정리된다.

### Media와 H3

- [ ] Media update가 focused caption, preview host, playback host를 불필요하게
      교체하지 않는다.
- [ ] upload, replace, reorder, enable/disable, caption, clear, undo/redo가
      canonical state와 동일하게 동작한다.
- [ ] VIDEO embedded audio와 derived AUDIO의 독립 toggle 계약이 유지된다.
- [ ] H3 Start/End, Guide, disabled Guide media, incomplete recovery가 restore
      뒤에도 유지된다.
- [ ] Guide/Shot draft의 Apply/Cancel/Undo 소유자가 명확하다.
- [ ] Timeline drag/drop과 keyboard 대체 경로가 저장 상태를 drag 중 조기
      commit하지 않는다.
- [ ] 다른 Loader instance로 drag/drop하거나 subscription을 공유하지 않는다.

### Editor와 ComfyUI lifecycle

- [ ] image/trim editor의 React host와 imperative draft/history owner가 중복되지
      않는다.
- [ ] editor backdrop, Escape, Cancel, Apply, late async response가 기존 계약을
      유지한다.
- [ ] Nodes 2.0과 Legacy Canvas 모두에서 widget 높이/폭/zoom이 안정적이다.
- [ ] workflow restore, Snapshot restore, queue 직전 serialization이 동일하다.
- [ ] node 제거 후 late upload/preview/player/editor callback이 DOM을 다시
      mount하거나 상태를 변경하지 않는다.
- [ ] ComfyUI console error와 duplicate node registration이 없다.

## 5. 검증 Checklist

### 자동 검증

- [ ] `bun run fmt:check`
- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test:unit`
- [ ] `bun run build`
- [ ] `bun run release:check`
- [ ] `bun run build:custom-node`
- [ ] `git diff --check`

### 현재 세션에서 확인된 baseline

2026-09-12에 현재 branch 기준으로 확인한 결과:

- frontend: 252 pass, 0 fail
- backend: 201 pass, 1 pytest cache warning
- backend는 전역 `uv` cache 권한 오류를 피하기 위해 repository-local cache로
  실행했다.
- committed branch diff의 `git diff --check`는 통과했다.
- 이후 작업 트리에 `frontend/src/reference-loader/ui/` 및 관련 CSS/test 변경이
  추가되었으므로 위 결과는 그 변경을 포함한 최종 결과가 아니다.
- `bun run build`는 현재 작업 트리의 미커밋 `ui/field.tsx`에서 발생한
  TypeScript 오류로 별도 차단되었다. 이 오류를 committed migration branch의
  결과로 간주하지 않는다.

### Live ComfyUI 검증

다음 항목은 happy-dom 또는 unit test 통과만으로 완료로 표시하지 않는다.

- [ ] Nodes 2.0에서 Reference Loader, Load Reference Image, Prompt,
      Subjects/ Shots widget을 생성한다.
- [ ] Legacy Canvas에서 같은 workflow를 반복한다.
- [ ] 노드 크기 축소/확대와 canvas zoom에서 Media, H3, Prompt가 겹치지 않는다.
- [ ] 이미지/오디오/비디오 upload, replace, preview, playback, trim을 확인한다.
- [ ] H3 Timeline/List, marker, Guide Inspector, Start/End, Shot, DnD를 확인한다.
- [ ] Prompt Raw/Structured, picker, chip, Korean IME, focus, copy, clear를
      확인한다.
- [ ] workflow/Snapshot save-load, Undo/Redo, queue 직전 값을 확인한다.
- [ ] 두 Loader node의 state와 picker가 독립적이다.
- [ ] node 제거 후 React root, native listener, player/editor host가 정리된다.
- [ ] native MiniMax H3 generation/checkpoint 검증은 UI migration 결과와
      별도로 기록한다.

## 6. 진행 순서

1. clean branch-only checkout을 만들고 현재 uncommitted UI/CSS 작업과 분리한다.
2. 위 자동 검증 전체를 실행해 첫 번째 baseline을 고정한다.
3. Prompt와 Media/H3의 live 검증을 surface별로 수행한다.
4. 실패한 항목만 수정한다. 이 단계에서는 새 기능, 새 abstraction, 새 state
   store를 추가하지 않는다.
5. ownership 표와 문서를 실제 production path에 맞게 갱신한다.
6. 남은 native path가 의도된 native island인지 확인하고, obsolete render/event
   path만 삭제한다.
7. migration blocker와 후속 작업을 분리한 뒤 review 가능한 커밋 단위로 정리한다.
8. 모든 필수 항목이 닫힌 경우에만 `main` merge를 제안한다.

## 7. Merge 판정

### Merge 가능

- 자동 검증 전체가 통과한다.
- 두 Canvas live 검증에서 blocker가 없다.
- React/Controller/native ownership이 표와 실제 코드에서 일치한다.
- serialization, restore, queue, destroy 계약이 유지된다.
- 남은 항목이 문서 정리 또는 명시된 후속 작업뿐이다.

### Merge 보류

- live 환경에서 focus, DnD, resize, restore, destroy 중 하나라도 미확인이다.
- React와 native가 같은 action을 중복 처리한다.
- 현재 작업 트리와 branch-only 결과를 구분할 수 없다.
- build/typecheck 실패가 migration 코드인지 미커밋 작업인지 분리되지 않는다.
- 새 feature plan이 migration 종료 조건에 계속 추가된다.

## 8. 종료 원칙

React migration의 완료는 native DOM이 0줄이 되는 것이 아니다. 완료 기준은
React가 선언적 UI surface를 소유하고, Controller가 canonical state와 ComfyUI
transaction을 소유하며, 남은 native island의 경계와 cleanup이 명시되고 실제
환경에서 동작하는 것이다.

이 문서의 미체크 항목을 모두 닫기 전에는 migration 완료로 표현하지 않는다.
반대로 image/trim 내부 구현, Controller 장기 분해, Raw import/export처럼
명시적으로 제외한 항목은 migration 실패가 아니라 후속 작업이다.

