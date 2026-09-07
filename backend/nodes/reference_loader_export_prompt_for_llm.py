from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from comfy_api.latest import io

from ..core.prompt_contract import compile_prompt_sections, parse_prompt_state
from ..core.reference_contract import execution_projection
from ..core.reference_manifest import build_reference_output_plan
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)

MAX_ADDITIONAL_YAML_CHARACTERS = 100_000
RESERVED_TOP_LEVEL_KEYS = frozenset(
  {"video_duration_seconds", "style", "references", "generation_directives"}
)
RESPONSE_FORMATS = ("text", "json")
LLAMA_SEQUENTIAL_RESPONSE_TYPE = io.Custom("LLAMA_SEQUENTIAL_RESPONSE")
STYLE_FIELDS = (
  "style_line",
  "render",
  "lighting",
  "camera",
  "motion",
  "soundscape",
  "music",
  "avoid",
)


def _load_minimax_h3_styles() -> dict[str, Mapping[str, str]]:
  path = (
    Path(__file__).resolve().parents[2]
    / "presets"
    / "styles"
    / "minimax_h3_styles.json"
  )
  try:
    raw = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, ValueError) as error:
    raise RuntimeError(f"Unable to load MiniMax H3 styles from {path}.") from error
  if not isinstance(raw, Mapping):
    raise TypeError("MiniMax H3 styles must contain a top-level mapping.")

  styles: dict[str, Mapping[str, str]] = {}
  for key, value in raw.items():
    if key.startswith("_"):
      continue
    if not isinstance(key, str) or not isinstance(value, Mapping):
      raise TypeError("MiniMax H3 styles must map keys to objects.")
    if any(not isinstance(value.get(field), str) for field in ("label", *STYLE_FIELDS)):
      raise RuntimeError(f"MiniMax H3 style {key!r} has invalid fields.")
    styles[key] = value
  if "none" not in styles:
    raise RuntimeError("MiniMax H3 styles must define the none entry.")
  return styles


MINIMAX_H3_STYLES = _load_minimax_h3_styles()
MINIMAX_H3_STYLE_KEYS = tuple(MINIMAX_H3_STYLES)


def _style_yaml_lines(style: str) -> list[str]:
  # Keep workflows saved with the former sentinel executable after the rename.
  if style == "auto":
    style = "none"
  if style not in MINIMAX_H3_STYLES:
    raise ValueError(
      f"style must be one of {', '.join(MINIMAX_H3_STYLE_KEYS)}; received {style!r}."
    )
  if style == "none":
    return []
  entry = MINIMAX_H3_STYLES[style]
  lines = ["style:", f"  key: {_yaml_scalar(style)}"]
  for field in STYLE_FIELDS:
    lines.append(f"  {field}: {_yaml_scalar(entry[field])}")
  return lines


class _AdditionalYamlLoader(yaml.SafeLoader):
  def compose_node(self, parent: Any, index: Any) -> yaml.Node:
    if self.check_event(yaml.AliasEvent):
      raise yaml.YAMLError("aliases are not supported")
    event = self.peek_event()
    if getattr(event, "anchor", None) is not None:
      raise yaml.YAMLError("anchors are not supported")
    return super().compose_node(parent, index)


class _IndentedSafeDumper(yaml.SafeDumper):
  def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
    return super().increase_indent(flow, indentless=False)


def _construct_unique_mapping(
  loader: _AdditionalYamlLoader,
  node: yaml.MappingNode,
  deep: bool = False,
) -> dict[str, Any]:
  mapping: dict[str, Any] = {}
  for key_node, value_node in node.value:
    key = loader.construct_object(key_node, deep=deep)
    if not isinstance(key, str):
      raise yaml.constructor.ConstructorError(
        "while constructing a mapping",
        node.start_mark,
        "mapping keys must be strings",
        key_node.start_mark,
      )
    if key in mapping:
      raise yaml.constructor.ConstructorError(
        "while constructing a mapping",
        node.start_mark,
        f"duplicate key: {key}",
        key_node.start_mark,
      )
    mapping[key] = loader.construct_object(value_node, deep=deep)
  return mapping


_AdditionalYamlLoader.add_constructor(
  yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
  _construct_unique_mapping,
)


def _yaml_scalar(value: str) -> str:
  """Return a YAML 1.2 string scalar using its JSON-compatible quoted form."""

  return json.dumps(value, ensure_ascii=False)


def _yaml_key(value: str) -> str:
  return value if value.isidentifier() else _yaml_scalar(value)


def _append_response_fields(lines: list[str], fields: Mapping[str, str]) -> None:
  for key, value in fields.items():
    lines.append(f"      {_yaml_key(key)}: {_yaml_scalar(value)}")


def _validate_yaml_value(value: Any, path: str) -> None:
  if value is None or isinstance(value, (str, bool, int)):
    return
  if isinstance(value, float):
    if not math.isfinite(value):
      raise ValueError(f"additional_yaml.{path} must contain a finite number.")
    return
  if isinstance(value, list):
    for index, item in enumerate(value):
      _validate_yaml_value(item, f"{path}[{index}]")
    return
  if isinstance(value, dict):
    for key, item in value.items():
      if not isinstance(key, str):
        raise TypeError(f"additional_yaml.{path} mapping keys must be strings.")
      _validate_yaml_value(item, f"{path}.{key}")
    return
  raise ValueError(
    f"additional_yaml.{path} contains unsupported YAML value {type(value).__name__}."
  )


def _additional_yaml_lines(value: str) -> list[str]:
  if not value.strip():
    return []
  if len(value) > MAX_ADDITIONAL_YAML_CHARACTERS:
    raise ValueError(
      f"additional_yaml must contain at most {MAX_ADDITIONAL_YAML_CHARACTERS} "
      "characters."
    )
  try:
    parsed = yaml.load(value, Loader=_AdditionalYamlLoader)
  except yaml.YAMLError as error:
    raise ValueError(
      f"additional_yaml must be valid single-document YAML: {error}"
    ) from error
  if not isinstance(parsed, dict):
    raise TypeError("additional_yaml must contain one top-level mapping.")
  conflicts = RESERVED_TOP_LEVEL_KEYS.intersection(parsed)
  if conflicts:
    names = ", ".join(sorted(conflicts))
    raise ValueError(f"additional_yaml contains reserved top-level key(s): {names}.")
  _validate_yaml_value(parsed, "root")
  if not parsed:
    return []
  rendered = yaml.dump(
    parsed,
    Dumper=_IndentedSafeDumper,
    allow_unicode=True,
    default_flow_style=False,
    sort_keys=False,
    width=4096,
  ).rstrip("\n")
  return rendered.splitlines()


def _append_caption_mapping(
  lines: list[str],
  name: str,
  tag_name: str,
  captions: tuple[str, ...],
  response_fields: tuple[Mapping[str, str] | None, ...] | None = None,
) -> None:
  if not captions:
    lines.append(f"  {name}: {{}}")
    return
  if response_fields is not None and len(response_fields) != len(captions):
    raise ValueError(f"{name} descriptions must match the caption count.")
  lines.append(f"  {name}:")
  for index, caption in enumerate(captions, start=1):
    fields = response_fields[index - 1] if response_fields is not None else None
    if response_fields is None:
      lines.append(f'    "<{tag_name} {index}>": {_yaml_scalar(caption)}')
      continue
    lines.append(f'    "<{tag_name} {index}>":')
    lines.append(f"      caption: {_yaml_scalar(caption)}")
    if fields is not None:
      _append_response_fields(lines, fields)


def _append_audio_mapping(
  lines: list[str],
  captions: tuple[str, ...],
  source_video_tags: tuple[str | None, ...],
  response_fields: tuple[Mapping[str, str] | None, ...] | None = None,
) -> None:
  if not captions:
    lines.append("  audios: {}")
    return
  if response_fields is not None and len(response_fields) != len(captions):
    raise ValueError("audios descriptions must match the caption count.")
  lines.append("  audios:")
  for index, caption in enumerate(captions, start=1):
    lines.append(f'    "<Audio {index}>":')
    lines.append(f"      caption: {_yaml_scalar(caption)}")
    if response_fields is not None and response_fields[index - 1] is not None:
      _append_response_fields(lines, response_fields[index - 1])
    source_video_tag = source_video_tags[index - 1]
    if source_video_tag is not None:
      lines.append(f"      source_video: {_yaml_scalar(source_video_tag)}")


def _response_items(value: Any) -> list[Any]:
  if value is None:
    return []
  if isinstance(value, (list, tuple)):
    items = list(value)
    # ComfyUI can preserve an OUTPUT_IS_LIST value as one item when it crosses
    # an INPUT_IS_LIST boundary. Unwrap that one transport wrapper, but do not
    # flatten arbitrary nested response values.
    if len(items) == 1 and isinstance(items[0], (list, tuple)):
      return list(items[0])
    return items
  return [value]


def _is_unavailable_input_list_value(value: Any) -> bool:
  return value is None or (
    isinstance(value, (list, tuple)) and len(value) == 1 and value[0] is None
  )


def _response_fields(
  value: Any,
  label: str,
  index: int,
  response_format: str,
) -> dict[str, str]:
  if not isinstance(value, str):
    raise TypeError(f"{label}[{index}] must be a string response.")
  text = value.strip()
  if not text:
    return {}
  if response_format == "text":
    return {"description": text}
  try:
    parsed = json.loads(text)
  except json.JSONDecodeError as error:
    raise ValueError(f"{label}[{index}] must be valid JSON.") from error
  if not isinstance(parsed, Mapping):
    raise TypeError(f"{label}[{index}] JSON response must contain an object.")
  fields: dict[str, str] = {}
  for key, field_value in parsed.items():
    if not isinstance(key, str) or not key:
      raise TypeError(f"{label}[{index}] JSON response keys must be strings.")
    if key in {"caption", "source_video"}:
      raise ValueError(
        f"{label}[{index}] JSON response cannot override reserved key {key!r}."
      )
    if not isinstance(field_value, str):
      raise TypeError(f"{label}[{index}] JSON response field {key!r} must be a string.")
    fields[key] = field_value.strip()
  return fields


def _description_overlays(
  references: ReferenceLoaderBundle,
  response: Any = None,
  response_seq: Any = None,
  response_format: str = "text",
) -> (
  tuple[
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
  ]
  | None
):
  if response_format not in RESPONSE_FORMATS:
    raise ValueError(
      f"Unknown response format {response_format!r}. Expected text or json."
    )
  state = validate_reference_loader_bundle(references)
  plan = build_reference_output_plan(state)
  expected_counts = {
    "images": len(plan.image_ids),
    "audios": len(plan.audio_ids),
    "videos": len(plan.video_ids),
  }
  if not any(expected_counts.values()):
    return None
  response_values = _response_items(response)
  sequence_values = _response_items(response_seq)
  if response_values and sequence_values:
    raise ValueError("response and response_seq cannot both be connected.")
  values = sequence_values or response_values
  if not values:
    return None
  response_label = "response_seq" if sequence_values else "response"
  expected_slots = [
    *(("image", index) for index in range(expected_counts["images"])),
    *(("audio", index) for index in range(expected_counts["audios"])),
    *(("video", index) for index in range(expected_counts["videos"])),
  ]
  if len(values) != len(expected_slots):
    raise ValueError(
      f"{response_label} must contain exactly "
      f"{len(expected_slots)} responses in media-major image, audio, video order; "
      f"received {len(values)}."
    )

  descriptions_by_kind: dict[str, list[Mapping[str, str] | None]] = {
    name: [None] * count for name, count in expected_counts.items()
  }
  for response_index, value in enumerate(values):
    expected_kind, expected_modality_index = expected_slots[response_index]
    description_key = f"{expected_kind}s"
    response_value = value
    if sequence_values:
      if not isinstance(value, Mapping):
        raise TypeError(f"response_seq[{response_index}] must be an object.")
      request_index = value.get("request_index")
      if (
        isinstance(request_index, bool)
        or not isinstance(request_index, int)
        or request_index != response_index
      ):
        raise ValueError(
          f"response_seq[{response_index}].request_index must be {response_index}."
        )
      kind = value.get("kind")
      if kind != expected_kind:
        raise ValueError(
          f"response_seq[{response_index}].kind must be {expected_kind!r}."
        )
      modality_index = value.get("modality_index")
      if (
        isinstance(modality_index, bool)
        or not isinstance(modality_index, int)
        or modality_index != expected_modality_index
      ):
        raise ValueError(
          f"response_seq[{response_index}].modality_index must be "
          f"{expected_modality_index}."
        )
      response_value = value.get("response")
    descriptions_by_kind[description_key][expected_modality_index] = _response_fields(
      response_value,
      response_label,
      response_index,
      response_format,
    )
  return (
    tuple(descriptions_by_kind["images"]),
    tuple(descriptions_by_kind["audios"]),
    tuple(descriptions_by_kind["videos"]),
  )


def export_prompt_parts_for_llm(
  references: ReferenceLoaderBundle,
  seconds: float = 6.0,
  additional_yaml: str = "",
  descriptions: tuple[
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
  ]
  | None = None,
  style: str = "none",
) -> tuple[str, str, str]:
  """Export the complete prompt and its generated YAML sections."""

  if (
    isinstance(seconds, bool)
    or not isinstance(seconds, (int, float))
    or not math.isfinite(seconds)
    or not 4.0 <= seconds <= 15.0
  ):
    raise ValueError("seconds must be a finite number from 4.0 through 15.0.")
  state = validate_reference_loader_bundle(references)
  plan = build_reference_output_plan(state)
  document = parse_prompt_state(references.prompt_state_json)
  out_of_range = [
    shot for shot in document.shots if shot.frame_index / 24 >= float(seconds)
  ]
  if out_of_range:
    details = ", ".join(
      f"#{shot.tag} at {shot.frame_index / 24:.3f}s" for shot in out_of_range
    )
    raise ValueError(
      f"Shot frame must be before the export duration ({seconds:.3f}s): {details}."
    )
  projection = execution_projection(state)

  active_videos = [entry for entry in projection["videos"] if entry["enabled"]]
  video_tags_by_id = {
    entry["id"]: f"<Video {index}>"
    for index, entry in enumerate(active_videos, start=1)
  }
  active_audios: list[dict[str, Any]] = [
    entry for entry in projection["audios"] if entry["enabled"]
  ]
  source_video_tags = tuple(
    video_tags_by_id.get(entry.get("derivedFrom")) for entry in active_audios
  )

  prompt_header_lines = [f"video_duration_seconds: {json.dumps(float(seconds))}"]
  additional_lines = _additional_yaml_lines(additional_yaml)
  if additional_lines:
    prompt_header_lines.extend(["", *additional_lines])
  style_lines = _style_yaml_lines(style)
  if style_lines:
    prompt_header_lines.extend(["", *style_lines])

  reference_lines = ["references:"]
  image_descriptions = descriptions[0] if descriptions is not None else None
  audio_descriptions = descriptions[1] if descriptions is not None else None
  video_descriptions = descriptions[2] if descriptions is not None else None
  _append_caption_mapping(
    reference_lines,
    "images",
    "Picture",
    plan.image_captions,
    image_descriptions,
  )
  _append_caption_mapping(
    reference_lines,
    "videos",
    "Video",
    plan.video_captions,
    video_descriptions,
  )
  _append_audio_mapping(
    reference_lines,
    plan.audio_captions,
    source_video_tags,
    audio_descriptions,
  )

  generation_directive_lines: list[str]
  sections = compile_prompt_sections(document, state)
  if not sections:
    generation_directive_lines = ["generation_directives: {}"]
  else:
    generation_directive_lines = ["generation_directives:"]
    for title, content in sections:
      generation_directive_lines.append(f"  {title}: {_yaml_scalar(content)}")

  references_yaml = "\n".join(reference_lines)
  generation_directives_yaml = "\n".join(generation_directive_lines)
  prompt = "\n".join(
    [
      *prompt_header_lines,
      "",
      references_yaml,
      "",
      generation_directives_yaml,
    ]
  )
  return prompt, references_yaml, generation_directives_yaml


def export_prompt_for_llm(
  references: ReferenceLoaderBundle,
  seconds: float = 6.0,
  additional_yaml: str = "",
  descriptions: tuple[
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
    tuple[Mapping[str, str] | None, ...],
  ]
  | None = None,
  style: str = "none",
) -> str:
  """Export active references and the structured prompt as strict YAML."""

  return export_prompt_parts_for_llm(
    references,
    seconds,
    additional_yaml,
    descriptions,
    style=style,
  )[0]


def _unwrap_scalar(value: Any, name: str, default: Any = None) -> Any:
  if isinstance(value, (list, tuple)):
    if not value:
      return default
    if len(value) != 1:
      raise ValueError(f"{name} must contain exactly one value.")
    return value[0]
  return default if value is None else value


def _export_prompt_for_node(
  references: Any,
  seconds: Any,
  additional_yaml: Any,
  response_format: Any,
  response_seq: Any = None,
  response: Any = None,
  style: Any = "none",
) -> tuple[str, str, str]:
  bundle = _unwrap_scalar(references, "references")
  descriptions = _description_overlays(
    bundle,
    response,
    response_seq,
    _unwrap_scalar(response_format, "response_format", "text"),
  )
  return export_prompt_parts_for_llm(
    bundle,
    _unwrap_scalar(seconds, "seconds", 6.0),
    _unwrap_scalar(additional_yaml, "additional_yaml", ""),
    descriptions,
    style=_unwrap_scalar(style, "style", "none"),
  )


class ReferenceLoaderExportPromptForLLMNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderExportPromptForLLM",
      display_name="[Reference Loader] Export Prompt for LLM",
      category="reference/output",
      description=(
        "Exports active reference captions and the structured Reference Loader "
        "generation directives as a strict YAML string for an LLM."
      ),
      search_aliases=[
        "reference loader export prompt for llm",
        "reference llm prompt",
        "reference yaml export",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        ),
        io.Float.Input(
          "seconds",
          default=6.0,
          min=4.0,
          max=15.0,
          step=0.1,
          round=0.01,
          socketless=False,
          tooltip="Target video duration in seconds.",
        ),
        io.Combo.Input(
          "style",
          options=list(MINIMAX_H3_STYLE_KEYS),
          default="none",
          tooltip=(
            "Optional MiniMax H3 style context for the LLM. None omits the style "
            "mapping and leaves style selection to the prompt/request."
          ),
        ),
        io.String.Input(
          "additional_yaml",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional top-level YAML mapping...",
          tooltip=(
            "Optional validated YAML mapping merged before references. Generated "
            "top-level keys are reserved."
          ),
        ),
        io.Combo.Input(
          "response_format",
          options=list(RESPONSE_FORMATS),
          default="json",
          advanced=True,
          tooltip="Interpret response items as plain text or JSON objects.",
        ),
        LLAMA_SEQUENTIAL_RESPONSE_TYPE.Input(
          "response_seq",
          optional=True,
          lazy=True,
          tooltip=(
            "Optional list[dict] of LLAMA_SEQUENTIAL_RESPONSE objects from "
            "Llama.cpp Sequential Generate."
          ),
        ),
        io.String.Input(
          "response",
          optional=True,
          force_input=True,
          tooltip=(
            "Optional list[str] of responses. It must follow image, audio, "
            "video media-major order."
          ),
        ),
      ],
      # V3 applies list input semantics at the schema level. In particular,
      # response_seq is list[dict] and response is list[str].
      is_input_list=True,
      outputs=[
        io.String.Output(
          "prompt",
          tooltip="Strict YAML containing active references and generation directives.",
        ),
        io.String.Output(
          "references_yaml",
          tooltip="Strict YAML containing only the generated references mapping.",
        ),
        io.String.Output(
          "generation_directives_yaml",
          tooltip=(
            "Strict YAML containing only the generated generation_directives mapping."
          ),
        ),
      ],
    )

  @classmethod
  def check_lazy_status(
    cls,
    references: Any,
    seconds: Any = 6.0,
    additional_yaml: Any = "",
    response_format: Any = "text",
    response_seq: Any = None,
    response: Any = None,
    style: Any = "none",
  ) -> list[str]:
    bundle = _unwrap_scalar(references, "references")
    if bundle is None:
      return []
    state = validate_reference_loader_bundle(bundle)
    plan = build_reference_output_plan(state)
    media_count = len(plan.image_ids) + len(plan.audio_ids) + len(plan.video_ids)
    if (
      media_count == 0
      or response is not None
      or not _is_unavailable_input_list_value(response_seq)
    ):
      return []
    return ["response_seq"]

  @classmethod
  def fingerprint_inputs(
    cls,
    references: Any,
    seconds: Any = 6.0,
    additional_yaml: Any = "",
    response_format: Any = "text",
    response_seq: list[Mapping[str, Any]] | None = None,
    response: list[str] | None = None,
    style: Any = "none",
  ) -> str:
    prompt, _, _ = _export_prompt_for_node(
      references,
      seconds,
      additional_yaml,
      response_format,
      response_seq,
      response,
      style,
    )
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()

  @classmethod
  def execute(
    cls,
    references: Any,
    seconds: Any = 6.0,
    additional_yaml: Any = "",
    response_format: Any = "text",
    response_seq: list[Mapping[str, Any]] | None = None,
    response: list[str] | None = None,
    style: Any = "none",
  ) -> io.NodeOutput:
    prompt, references_yaml, generation_directives_yaml = _export_prompt_for_node(
      references,
      seconds,
      additional_yaml,
      response_format,
      response_seq,
      response,
      style,
    )
    return io.NodeOutput(
      prompt,
      references_yaml,
      generation_directives_yaml,
    )


__all__ = [
  "LLAMA_SEQUENTIAL_RESPONSE_TYPE",
  "MAX_ADDITIONAL_YAML_CHARACTERS",
  "RESPONSE_FORMATS",
  "ReferenceLoaderExportPromptForLLMNode",
  "export_prompt_for_llm",
  "export_prompt_parts_for_llm",
]
