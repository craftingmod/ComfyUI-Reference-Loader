# Prompt preset 작성 안내

이 디렉터리의 각 `*.json` 파일은 Reference Loader Prompt 편집기의 프리셋 하나를 정의합니다. Backend는 ComfyUI 시작 시 파일을 읽어 `prompt_schema_preset` Combo와 Prompt의 `/` alias 목록을 구성합니다.

JSON을 변경한 뒤에는 Frontend를 다시 빌드할 필요가 없지만, ComfyUI를 재시작해야 합니다.

## 기본 구조

파일명은 반드시 `<id>.json`이어야 합니다. 예를 들어 `id`가 `custom_video`라면 파일명은 `custom_video.json`이어야 합니다.

```json
{
  "version": 1,
  "order": 50,
  "default": false,
  "id": "custom_video",
  "label": {
    "en": "Custom video",
    "ko": "사용자 비디오"
  },
  "description": {
    "en": "Custom sections for a video model.",
    "ko": "비디오 모델용 사용자 정의 섹션입니다."
  },
  "defaultSectionTitle": "scene",
  "subjectMode": "disabled",
  "aliases": [
    {
      "command": "scene",
      "title": "scene",
      "label": {
        "en": "Scene",
        "ko": "장면"
      },
      "description": {
        "en": "Subject, setting, and action",
        "ko": "피사체, 배경과 행동"
      },
      "icon": "Sc"
    }
  ]
}
```

## 프리셋 필드

| 필드                  | 형식                                  | 필수 | 설명                                                                          |
| --------------------- | ------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `version`             | 정수 `1`                              | 예   | 현재 프리셋 파일 규격 버전입니다.                                             |
| `order`               | 정수                                  | 예   | Advanced Inputs Combo에서 표시되는 순서입니다. 모든 파일에서 고유해야 합니다. |
| `default`             | Boolean                               | 예   | 기본 프리셋 여부입니다. 디렉터리 전체에서 정확히 하나만 `true`여야 합니다.    |
| `id`                  | 문자열                                | 예   | 저장되는 프리셋 ID입니다. 파일명과 일치해야 합니다.                           |
| `label`               | `{ "en": string, "ko": string }`      | 예   | Prompt 상단 프리셋 배지에 표시되는 이름입니다.                                |
| `description`         | `{ "en": string, "ko": string }`      | 예   | 프리셋의 용도를 설명하는 도움말입니다.                                        |
| `defaultSectionTitle` | 문자열                                | 예   | 비어 있는 Prompt에 가상으로 표시할 기본 섹션 제목입니다.                      |
| `subjectMode`         | `anywhere`, `definitions`, `disabled` | 예   | `#` Subject label을 생성할 수 있는 범위를 지정합니다.                         |
| `aliases`             | 배열                                  | 예   | `/` 자동 완성으로 생성할 섹션 목록입니다. 빈 배열도 허용됩니다.               |

## Alias 필드

| 필드          | 형식                             | 필수 | 설명                                                                               |
| ------------- | -------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `command`     | 문자열                           | 예   | `/scene`에서 `scene`에 해당하는 입력 명령입니다. 한 프리셋 안에서 고유해야 합니다. |
| `title`       | 문자열                           | 예   | Alias가 생성하거나 포커스할 실제 pseudo-YAML 섹션 제목입니다.                      |
| `label`       | `{ "en": string, "ko": string }` | 예   | 자동 완성 목록에 표시되는 짧은 이름입니다.                                         |
| `description` | `{ "en": string, "ko": string }` | 예   | 해당 섹션에 무엇을 적어야 하는지 설명합니다.                                       |
| `icon`        | 문자열                           | 예   | 자동 완성 목록 왼쪽에 표시되는 짧은 기호입니다.                                    |

Alias는 섹션 생성 단축 명령일 뿐입니다. 사용자는 프리셋에 등록되지 않은 `custom_title:`도 Prompt의 Add section 입력란에 직접 입력할 수 있습니다.

## 식별자 규칙

`id`, `defaultSectionTitle`, `title`은 다음 규칙을 따릅니다.

```text
^[a-z][a-z0-9_]*$
```

허용 예시:

- `generic`
- `camera_direction`
- `integrated_multimodal_description`

허용되지 않는 예시:

- `CameraDirection` — 대문자 사용
- `camera-direction` — 하이픈 사용
- `1st_scene` — 숫자로 시작
- `장면` — 모델용 식별자에 한글 사용

`command`는 더 단순한 영문 소문자만 허용합니다.

```text
^[a-z]+$
```

따라서 `/camera`, `/sound`, `/retention`은 허용되지만 `/camera_direction`과 `/h3-sound`는 허용되지 않습니다.

## 작성 권장사항

### 순서는 10 단위로 배정

기존 파일은 `10`, `20`, `30`, `40`처럼 간격을 두고 있습니다. 중간에 프리셋을 삽입해야 할 때 `25` 같은 값을 사용할 수 있도록 동일한 방식을 권장합니다.

### 모델용 식별자는 번역하지 않기

`id`, `command`, `defaultSectionTitle`, `title`은 워크플로 및 모델 prompt에 사용되는 안정적인 식별자입니다. 한국어와 영어 UI 문구는 `label`과 `description`에서만 구분하는 것을 권장합니다.

특히 MiniMax H3처럼 필드명이 규격에 포함되는 모델은 `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music` 등의 정확한 이름을 유지해야 합니다.

### 설명에는 입력 내용의 경계를 명시

Alias 설명은 서로 겹치지 않게 작성하는 편이 좋습니다. 예를 들어 `/sound`는 극중 환경음과 효과음, `/music`은 비극중 배경음악처럼 역할을 분리하면 Prompt 생성 LLM이 내용을 올바른 섹션에 배치하기 쉽습니다.

### 아이콘은 짧게 유지

`icon`에는 한두 글자 또는 하나의 기호를 권장합니다. 긴 문자열도 JSON 규격상 허용되지만 자동 완성 UI의 폭을 넘길 수 있습니다.

### ID 변경은 새 프리셋 추가로 취급

기존 `id`를 변경하거나 파일을 삭제하면 해당 값을 저장한 워크플로는 다음 로드 시 기본 프리셋으로 fallback합니다. 이미 사용된 프리셋을 크게 변경할 때는 기존 ID를 재사용하기보다 새 JSON 파일을 추가하는 편이 안전합니다.

### JSON 문법을 엄격히 유지

JSON은 주석과 trailing comma를 지원하지 않습니다. UTF-8로 저장하고, 문자열 내부의 줄바꿈이나 따옴표는 JSON escape 규칙에 맞게 작성해야 합니다.

## 새 프리셋 추가 절차

1. 가장 가까운 기존 JSON 파일을 복사합니다.
2. 파일명과 `id`를 동일한 새 식별자로 변경합니다.
3. 아직 사용되지 않은 `order`를 지정합니다.
4. 일반적인 추가 프리셋은 `default`를 `false`로 둡니다.
5. `defaultSectionTitle`과 `aliases`를 대상 모델 규격에 맞게 수정합니다.
6. 용도에 맞는 `subjectMode` 정책을 선택합니다.
7. 모든 `label`과 `description`에 `en`, `ko` 문자열을 작성합니다.
8. ComfyUI를 재시작하고 Reference Loader의 Advanced Inputs에서 프리셋과 자동 완성을 확인합니다.

기본 프리셋을 바꾸려면 기존 기본 파일의 `default`를 `false`로 바꾼 뒤 새 기본 파일 하나만 `true`로 설정해야 합니다.

## 적용 범위

프리셋은 다음 UI 정책만 바꿉니다.

- 비어 있는 Prompt의 기본 섹션
- `/` 자동 완성 항목
- `#` Subject label을 생성할 수 있는 위치
- 프리셋 배지 및 한·영 설명

`subjectMode`는 모든 섹션에서 Subject를 만들 수 있는 `anywhere`, `subject_definitions`에서만 만들고 다른 섹션에서는 재사용하는 `definitions`, `#`를 일반 텍스트로 두는 `disabled` 중 하나입니다. 프리셋을 전환해도 이미 작성된 섹션이나 Subject를 이름 변경, 재정렬 또는 삭제하지 않습니다. `@` 미디어 참조는 모든 프리셋에서 동일하게 작동합니다.

## 오류 확인

프리셋 파일이 잘못되면 Backend는 부분적으로 적용하지 않고 노드 로딩 단계에서 오류를 보고합니다. 다음 항목을 우선 확인하세요.

- `.json` 파일이 하나 이상 존재하는지
- 모든 파일의 `version`이 `1`인지
- 파일명과 `id`가 일치하는지
- 각 파일의 `subjectMode`가 허용된 값인지
- `order`와 `id`가 중복되지 않았는지
- 정확히 하나의 파일만 `default: true`인지
- 각 프리셋 안에서 `command`가 중복되지 않았는지
- `label`과 `description`에 `en`, `ko` 문자열이 모두 있는지
