# Prompt Preset Authoring Guide

[한국어 문서](README.KO.md)

Each `*.json` file in this directory defines one preset for the Reference Loader Prompt editor. When ComfyUI starts, the backend reads these files to populate the `prompt_schema_preset` combo and the Prompt editor's `/` alias menu.

After changing a JSON file, restart ComfyUI. You do not need to rebuild the frontend.

## Basic structure

The filename must be `<id>.json`. For example, a preset whose `id` is `custom_video` must be stored as `custom_video.json`.

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

## Preset fields

| Field                 | Type                             | Required | Description                                                                                    |
| --------------------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `version`             | Integer `1`                      | Yes      | Version of the preset file format.                                                             |
| `order`               | Integer                          | Yes      | Position in the Advanced Inputs combo. It must be unique across all files.                     |
| `default`             | Boolean                          | Yes      | Whether this is the default preset. Exactly one file in the directory must set this to `true`. |
| `id`                  | String                           | Yes      | Stable preset ID stored in the workflow. It must match the filename.                           |
| `label`               | `{ "en": string, "ko": string }` | Yes      | Name displayed in the active-preset badge.                                                     |
| `description`         | `{ "en": string, "ko": string }` | Yes      | Help text describing the preset's purpose.                                                     |
| `defaultSectionTitle` | String                           | Yes      | Virtual default section shown when the Prompt is empty.                                        |
| `aliases`             | Array                            | Yes      | Sections offered by `/` autocomplete. An empty array is allowed.                               |

## Alias fields

| Field         | Type                             | Required | Description                                                                               |
| ------------- | -------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `command`     | String                           | Yes      | Command text after `/`, such as `scene` in `/scene`. It must be unique within the preset. |
| `title`       | String                           | Yes      | Actual pseudo-YAML section created or focused by the alias.                               |
| `label`       | `{ "en": string, "ko": string }` | Yes      | Short name shown in the autocomplete menu.                                                |
| `description` | `{ "en": string, "ko": string }` | Yes      | Guidance about what belongs in this section.                                              |
| `icon`        | String                           | Yes      | Short symbol displayed at the left of the autocomplete entry.                             |

Aliases are only shortcuts for creating sections. Users can still enter an unregistered title such as `custom_title:` directly in the Prompt editor's Add section field.

## Identifier rules

`id`, `defaultSectionTitle`, and alias `title` must match:

```text
^[a-z][a-z0-9_]*$
```

Valid examples:

- `generic`
- `camera_direction`
- `integrated_multimodal_description`

Invalid examples:

- `CameraDirection` — contains uppercase letters
- `camera-direction` — contains a hyphen
- `1st_scene` — starts with a number
- `장면` — uses a translated model-facing identifier

Alias `command` values follow the stricter lowercase-letter-only pattern:

```text
^[a-z]+$
```

For example, `/camera`, `/sound`, and `/retention` are valid, while `/camera_direction` and `/h3-sound` are not.

## Authoring recommendations

### Allocate order values in increments of 10

The bundled presets use `10`, `20`, `30`, and `40`. Keeping gaps makes it possible to insert a preset later with a value such as `25` without renumbering every file.

### Do not translate model-facing identifiers

`id`, `command`, `defaultSectionTitle`, and `title` are stable identifiers used by workflows or model prompts. Put localized UI text only in `label` and `description`.

For models such as MiniMax H3, keep specification-defined field names exactly as required, including `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music`.

### Give every description a clear boundary

Avoid overlapping alias descriptions. For example, define `/sound` as diegetic ambience and effects, while reserving `/music` for non-diegetic music. Clear boundaries help an upstream prompt-generation LLM place content in the correct section.

### Keep icons short

Use one or two characters, or a single symbol, for `icon`. Longer strings are valid JSON but may overflow the autocomplete layout.

### Treat an ID change as a new preset

If you rename or remove an existing `id`, workflows that saved that value will fall back to the default preset the next time they load. When making a substantial incompatible change, add a new JSON file instead of reusing an established ID.

### Keep the JSON syntax strict

JSON does not support comments or trailing commas. Save files as UTF-8 and escape quotes or line breaks inside strings according to JSON syntax.

## Adding a preset

1. Copy the closest existing JSON file.
2. Give the file and `id` the same new identifier.
3. Assign an unused `order` value.
4. Leave `default` as `false` for a normal additional preset.
5. Adjust `defaultSectionTitle` and `aliases` to the target model's specification.
6. Provide both `en` and `ko` strings for every `label` and `description`.
7. Restart ComfyUI and verify the preset and `/` autocomplete entries under Reference Loader's Advanced Inputs.

To change the default preset, first set the old default file to `false`, then set exactly one new default file to `true`.

## Scope of a preset

A preset changes only these Prompt UI policies:

- Default section shown for an empty Prompt
- Entries offered by `/` autocomplete
- Active-preset badge and localized descriptions

Switching presets does not rename, reorder, or remove existing sections. It also does not directly change the compiled Prompt or the execution fingerprint. `@` media references work the same way in every preset.

## Troubleshooting

If any preset file is invalid, the backend rejects the catalog during node loading instead of applying a partial configuration. Check the following first:

- At least one `.json` file exists.
- Every file uses `"version": 1`.
- Every filename matches its `id`.
- No `order` or `id` value is duplicated.
- Exactly one file sets `"default": true`.
- Alias `command` values are unique within each preset.
- Every `label` and `description` contains both `en` and `ko` strings.
