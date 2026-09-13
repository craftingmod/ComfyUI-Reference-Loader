# PLAN: Media 카드 내부 Guide Stack 편집 UI

## 0. 작업 목표와 범위

Add Guide / Edit Guide를 실행하면 **클릭한 Media 카드 한 개의 영역 안에서만** 편집한다. 목록은 위에 수직 Stack으로, 추가 폼은 아래에 배치한다. 구현 담당자는 이 문서 순서대로 작업하고 완료 체크리스트를 보고한다.

이 문서는 구현 지시서다. 현재 작업은 문서 작성만이며 제품 코드는 아직 수정하지 않았다.

- 기존 frontend 구현을 수정한다. 새 UI 라이브러리, 전역 모달, 포털, 백엔드 API, 저장 스키마를 추가하지 않는다.
- 기존 Reference 출력, 캡션, Prompt, 미디어 순서, Snapshot/Undo 계약을 유지한다.
- `docs/H3_MEDIA_GUIDES_INTEGRATION_PLAN.md`, `docs/H3_TIMELINE_GUIDES_IMPLEMENTATION_PLAN.md`는 기존 문서이므로 덮어쓰지 않는다. 이번 UI 작업의 범위와 완료 기준은 본 문서를 따른다.
- 기존 작업 트리 변경을 먼저 확인하고 사용자의 변경을 보존한다.

## 1. 확인된 코드와 문제

| 위치                                                                                                | 확인 사항 / 작업 대상                                                                                    |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `frontend/src/reference-loader/components/loader.ts`, `#channelMarkup` 부근                         | 현재 `.rl-card-grid`의 자식으로 `.rl-h3-editor-overlay`를 삽입한다. 카드 자체에 속하지 않는다.           |
| 같은 파일, `#cardMarkup`                                                                            | 편집 중인 Media ID와 채널에 해당하는 카드 내부에 편집 UI를 렌더링할 위치다.                              |
| 같은 파일, `#h3EditorMarkup`, `#h3DraftGuideMarkup`                                                 | Start/End 체크박스, 특정 프레임 목록, Visual/Audio 선택기를 카드용 Stack으로 바꾼다.                     |
| 같은 파일, `#openH3EditorForMedia`, `#toggleH3Guide`, `#onH3Action` 및 실제 이벤트 분기             | 추가/편집/요약 클릭 경로가 동일한 카드 편집기로 들어가도록 확인한다. 함수 이름은 현재 소스로 재확인한다. |
| 같은 파일, `#addH3DraftPlacement`, `#deleteH3DraftPlacement`, `#h3EditorTimeline`, `#applyH3Editor` | draft 추가·삭제·병합·Apply 동작을 수정한다.                                                              |
| `frontend/src/reference-loader/styles/h3-timeline.css`                                              | overlay가 `position: absolute; inset: 0`이고 편집 폼은 긴 라벨/여러 선택기를 사용한다.                   |
| `frontend/src/reference-loader/h3-media-guides.ts`                                                  | 소스 적합성, 배치 목록, 충돌 검증을 재사용한다.                                                          |
| `frontend/src/reference-loader/reducer.ts`, `types.ts`, `serialization.ts`                          | 기존 저장/Undo 계약 확인용. 필요가 입증되지 않으면 수정하지 않는다.                                      |
| `frontend/test/reference-loader-h3-media-guides.test.ts`                                            | 기존 DOM·상태 테스트를 확장한다.                                                                         |

**진단 경계:** 소스에서 grid 단위 overlay 삽입은 확인했다. 실제 브라우저에서 화면 전체로 확장되는 정확한 containing block과 스타일 충돌은 아직 측정하지 않았다. 구현 시 재현하여 확인하되, z-index만 조정해 해결했다고 처리하지 않는다.

## 2. 확정 UI

### 카드 안의 편집 화면

기본안은 **카드 내용의 인라인 교체**다. 선택된 `.rl-card`의 내용만 아래 화면으로 바꾼다. 화면 전체나 grid를 덮는 overlay를 만들지 않는다. 원래 그리드 열/카드 너비는 유지하고 필요한 높이만 자연스럽게 늘린다. 원래 썸네일 높이에 억지로 모든 폼을 밀어 넣지 않는다.

```text
┌ 현재 Media 카드 ────────────┐
│ Guide · 작은 썸네일/파일명  ×│
│                            │
│ Start · 0f              [×]│
│ Frame [48  ] · 2.00s    [×]│
│ End · 최종 출력 프레임   [×]│
│                            │
│ 추가할 위치 [특정 프레임 ▼] │
│ 출력 프레임 [96         ]   │
│                 [+ 추가]   │
│ 오류가 있으면 이곳에 설명   │
│             [취소] [적용]  │
└────────────────────────────┘
```

- 위 목록에 현재 Media에 연결된 Start / 특정 프레임 / End를 모두 표시한다. Start와 End를 별도 체크박스로 밖에 두지 않는다.
- 표시 순서는 Start → 특정 프레임 오름차순 → End. 저장 배열을 표시 목적으로 정렬하거나 ID를 재생성하지 않는다. 숫자 입력 중에는 행을 이동시키지 않고 blur/확정 후 정렬한다.
- 특정 프레임 행은 숫자를 직접 수정한다. Start/End 행은 고정 역할이며 삭제 후 다른 종류로 추가한다.
- 아래 추가 폼은 `시작 / 특정 프레임 / 끝` 선택과 필요한 숫자 입력, `+ 추가` 버튼으로 구성한다. 기본값은 특정 프레임이며 숫자는 미입력으로 시작한다. 자동으로 0f 배치를 생성하지 않는다.
- 현재 카드가 연결 소스다. 일반 카드 편집 화면에 다른 Visual/Audio 소스를 고르는 드롭다운을 노출하지 않는다.
- 목록이 없으면 “아직 가이드가 없습니다. 아래에서 위치를 추가하세요.”를 표시한다.
- 카드가 좁으면 라벨과 입력을 세로 배치한다. 긴 파일명은 말줄임, 입력에는 `min-width: 0`, 컨트롤에는 카드 폭 제한을 적용한다. 고정 118px 라벨 폭을 제거한다.
- 목록이 많으면 목록만 적절한 최대 높이(초기안 220px)로 스크롤한다. 아래 추가 폼과 적용 버튼은 목록 스크롤 바깥에 둔다. Media board 전체에 새 스크롤을 만들지 않는다.
- 모든 삭제 버튼은 `type=button`, 최소 24px 클릭 영역, 구체적인 `aria-label`을 갖는다. 예: “48 프레임의 이 이미지 연결 삭제”. 헤더 ×는 “가이드 편집 취소”로 구분한다.

### 진입과 종료

- Guide가 없는 카드의 G는 추가 편집기를 연다. G-pencil은 편집기를 연다. 기존 G ON→OFF의 연결 해제 기능은 유지한다.
- Timeline 요약의 연결된 항목 클릭도 해당 카드 편집기를 열고 해당 행으로 이동한다.
- 편집기는 한 번에 하나다. 다른 카드 편집 요청 시 미변경 draft는 전환한다. 변경된 draft가 있으면 현재 카드 안에서 “적용 또는 취소 후 다른 가이드를 여세요”를 표시하고 전환하지 않는다. 별도 확인 모달을 추가하지 않는다.
- `적용`만 저장 상태를 갱신한다. `취소`, 헤더 ×, 편집 영역에 포커스가 있을 때 Escape는 draft를 버린다. 바깥 클릭으로 저장하거나 닫지 않는다.
- 종료 후 원래 진입 버튼에 포커스를 돌린다. 입력 중 카드 드래그, 파일 교체 drop, 일반 R 편집, 미디어 삭제 단축키가 오작동하지 않도록 기존 카드 이벤트 위임을 점검한다. 다른 카드의 정상 상호작용은 유지한다.

## 3. 데이터 규칙 — 임의로 변경하지 말 것

1. Start는 `startImageId`, End는 `endImageId`, 특정 프레임은 기존 `guides[]`의 `id/frameIndex/visualId/audioId`를 사용한다. UI 목록용으로 Start/End를 `guides[]`에 중복 저장하지 않는다.
2. Start/End는 이미지 전용이다. 독립 Audio는 특정 프레임만 추가할 수 있다. Video 및 Video 파생 Audio에는 Guide 진입 버튼을 노출하지 않는다. Audio End 지원을 만들기 위해 백엔드를 확장하지 않는다.
3. 프레임은 **출력 영상 기준**, 0-based, 0 이상의 정수다. 초는 24fps로 환산한 보조 표시다. 원본 미디어 프레임 선택/추출 기능을 추가하지 않는다.
4. End는 최종 출력 프레임이라는 의미를 보존한다. 출력 길이를 모르는 frontend에서 임의의 숫자로 치환하거나 가짜 상한을 만들지 않는다.
5. 동일 채널의 동일 프레임 중복은 거부한다. Start가 있으면 visual 0f와 충돌한다. 같은 프레임의 visual+audio는 허용한다. 기존 `validateH3Timeline`을 사용한다.
6. Start/End가 다른 이미지에 할당되어 있으면 추가를 막고 소유 파일명을 설명한다. 조용히 다른 이미지의 연결을 덮어쓰지 않는다. 현재 이미지에 이미 있는 역할도 중복 추가하지 않는다.
7. 기존 `guides[]` 최대 32개 제한을 유지한다. Start/End는 별도 필드이므로 특정 프레임 행 수 제한과 혼동하지 않는다. 한도 도달 시 추가 비활성화와 이유를 표시한다.
8. **행의 ×는 현재 카드의 연결만 제거한다.** paired entry의 상대 채널은 남긴다. 양 채널이 비면 entry를 삭제한다. 현재 `#deleteH3DraftPlacement`는 entry 전체를 삭제하므로 그대로 재사용하면 안 된다. Start/End 삭제도 현재 카드 소유인 경우만 해제한다.
9. paired entry의 프레임을 수정할 때도 상대 Media를 이동시키지 않는다. 상대 채널은 원래 entry/ID/프레임에 두고, 현재 채널을 새 ID의 entry로 분리해 이동한다. 이때 충돌/32개 제한을 검증하고 실패하면 draft를 그대로 보존한다. paired 행에는 상대 소스가 같은 프레임에 연결되어 있다는 읽기 전용 짧은 표시를 제공한다.
10. 추가·삭제·수정은 draft에만 반영하고 Apply에서 기존 action으로 한 번에 commit한다. Cancel은 저장 상태/출력에 영향이 없어야 한다. 다른 Media의 배치, Timeline enabled, Reference 토글은 보존한다.
11. 마지막 연결을 삭제한 기존 Guide 편집은 빈 결과를 적용할 수 있어야 한다. 반면 처음 G를 켜는 `requireGuide` 경로는 하나 이상 추가해야 적용할 수 있다.

### 연결 없는 기존 Guide

`#openH3EditorForGuide`는 Media가 없는 incomplete entry를 복구하는 기존 경로다. 해당 entry를 임의의 카드에 붙이거나 보이지 않게 삭제하지 않는다. **이 경우만** Timeline 요약 안의 작은 인라인 복구 영역에 기존 소스 선택/삭제 기능을 유지한다. 전역 overlay는 사용하지 않는다. 정상 카드 편집용 Stack과 복구용 소스 선택의 렌더링 조건을 명확히 분리한다.

## 4. 실행 순서

### A. 현재 동작 확인

- [ ] `git status --short`, `AGENTS.md`, `docs/TESTING.md`를 확인한다.
- [ ] 이미지 2개 이상인 grid에서 G와 G-pencil을 재현하고 editor DOM 부모 및 computed containing block을 기록한다.
- [ ] 위 표의 함수 전체와 모든 caller, CSS의 `has-h3-editor` 참조를 읽는다. 입력/클릭/드래그/키보드 핸들러도 확인한다.

### B. 편집 영역을 카드로 이동

- [ ] `#channelMarkup`에서 정상 Media editor 삽입을 제거한다.
- [ ] `#cardMarkup`에서 Media ID **및 채널**이 일치하는 카드만 인라인 editor 내용을 렌더링한다. 클래스/식별자는 기존 카드 계약에 맞춘다.
- [ ] 기존 grid overlay 스타일 및 이제 쓰이지 않는 분기를 제거한다. 공용 카드/일반 R 편집의 스타일을 광범위하게 바꾸지 않는다.
- [ ] 이 단계에서 다른 카드가 가려지지 않는지 브라우저로 먼저 확인한다.

### C. Stack과 추가 폼 구현

- [ ] 기존 `H3EditorState`에 필요한 최소 UI draft 필드만 추가한다. 영속 스키마에 폼 상태를 넣지 않는다.
- [ ] Start/특정/End 행과 하단 추가 폼을 구현한다. helper는 기존 파일 내 작은 함수로 충분하면 새 추상 계층을 만들지 않는다.
- [ ] 연결 해제, paired 분리 이동, 오류 시 무변경을 구현한다. `ownedGuideIds`, `removedGuideIds`, `#h3EditorTimeline` 병합이 새 동작을 되돌리거나 상대 소스를 삭제하지 않는지 확인한다.
- [ ] 입력 중 전체 rerender로 포커스/커서가 튀지 않게 기존 input/change 처리를 조정한다. 행 변경 오류와 추가 폼 오류를 올바른 위치에 표시한다.

### D. 저장 및 예외 경로 점검

- [ ] Apply/Cancel/Escape, 다른 카드 전환, 요약 진입, incomplete 복구, Media 삭제 및 workflow 교체 시 draft 정리를 확인한다.
- [ ] Snapshot, Undo, workflow 저장/복원에서 기존 ID와 프레임 및 상대 채널이 유지되는지 확인한다.
- [ ] 실제 ComfyUI hook/API 변경이 필요해진 경우에만 공식 최신 문서를 확인하고 이유를 기록한다. 이번 계획 자체는 내부 DOM/CSS 변경으로 처리한다.

## 5. 필수 검증

기존 테스트 파일을 확장한다. 테스트 selector를 새 UI에 맞게 갱신하되 기존 상태 보존 검증을 삭제하지 않는다.

| 검증          | 합격 조건                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| 카드 소유 DOM | Image A 편집기는 A `.rl-card`의 자손이며 grid 직속 editor가 없다. Image B와 Audio 카드 내부에 중복 렌더링되지 않는다. |
| 추가/표시     | Start, 48f, End가 한 Stack에 나타나고 추가 폼은 목록 다음에 있다.                                                     |
| Apply/Cancel  | Apply 전 직렬화 값은 불변, Cancel 후 완전 동일, Apply 후 변경이 한 번에 반영된다.                                     |
| 입력 검증     | 빈 값/음수/소수/중복/Start와 visual 0f 충돌을 막고 오류 시 데이터를 보존한다.                                         |
| 삭제          | Start/End와 단일 행 삭제, 마지막 행 삭제, paired 한 채널만 삭제를 검증한다.                                           |
| paired 이동   | 현재 채널만 새 프레임으로 이동하고 상대 ID/프레임이 유지된다. 분리로 한도 초과 시 무변경이다.                         |
| 채널 제약     | standalone Audio에는 특정 프레임만, Video/파생 Audio에는 Guide 버튼이 없다.                                           |
| 기존 예외     | incomplete entry 복구/삭제, 다른 이미지의 Start/End 점유, 32개 제한을 검증한다.                                       |
| 상태 회귀     | 다른 Media 배치/Reference 출력 순서/캡션/ID가 유지되고 Undo 및 저장 복원이 동작한다.                                  |

실행 명령:

```shell
bun test --preload ./frontend/test/setup.ts frontend/test/reference-loader-h3-media-guides.test.ts
bun run typecheck
bun run test:unit
bun run fmt:check
bun run lint
bun run build
git diff --check
```

`dist/`는 직접 편집하지 않고 build 결과만 사용한다. 의존성이 없을 때만 저장소 지침에 따라 설치한다. Python 실행/동기화는 `uv`를 사용한다. 이번 UI 수정 때문에 배포·릴리스·버전 변경은 하지 않는다.

**브라우저 검증은 필수다.** happy-dom 통과만으로 레이아웃 해결을 주장하지 않는다. Nodes 2.0과 Legacy Canvas에서 기존 지원 grid 열 수의 최소/최대, 좁은/넓은 노드, 긴 파일명, 빈 목록/많은 목록을 확인한다. Add/Edit 각각에서 카드 경계 밖 가림·가로 넘침·버튼 잘림이 없어야 한다. 노드 확대/축소, 입력 포커스, 휠 스크롤, Escape, 카드 드래그 간섭도 확인한다. 전후 화면을 같은 조건으로 기록한다. 실행 환경이 없으면 DOM 검증과 실제 화면 검증 미실시를 구분해 보고한다.

## 6. 완료 보고 형식

1. 수정한 파일과 각 변경 이유.
2. 카드 내부 편집 및 Stack 화면의 실제 검증 결과/캡처.
3. 위 필수 검증과 명령별 성공·실패·미실시 결과.
4. 남은 문제 또는 미검증 환경. 자동 테스트 통과를 화면 검증 성공으로 표현하지 않는다.

전체 화면 가림이 남거나, paired 상대 연결이 사라지거나, Cancel이 저장 상태를 바꾸면 완료가 아니다.
