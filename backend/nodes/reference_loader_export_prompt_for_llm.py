from __future__ import annotations

import hashlib
import json
import math
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
  {"video_duration_seconds", "references", "generation_directives"}
)


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
) -> None:
  if not captions:
    lines.append(f"  {name}: {{}}")
    return
  lines.append(f"  {name}:")
  for index, caption in enumerate(captions, start=1):
    lines.append(f'    "<{tag_name} {index}>": {_yaml_scalar(caption)}')


def _append_audio_mapping(
  lines: list[str],
  captions: tuple[str, ...],
  source_video_tags: tuple[str | None, ...],
) -> None:
  if not captions:
    lines.append("  audios: {}")
    return
  lines.append("  audios:")
  for index, caption in enumerate(captions, start=1):
    lines.append(f'    "<Audio {index}>":')
    lines.append(f"      caption: {_yaml_scalar(caption)}")
    source_video_tag = source_video_tags[index - 1]
    if source_video_tag is not None:
      lines.append(f"      source_video: {_yaml_scalar(source_video_tag)}")


def export_prompt_parts_for_llm(
  references: ReferenceLoaderBundle,
  seconds: float = 6.0,
  additional_yaml: str = "",
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

  reference_lines = ["references:"]
  _append_caption_mapping(reference_lines, "images", "Picture", plan.image_captions)
  _append_caption_mapping(reference_lines, "videos", "Video", plan.video_captions)
  _append_audio_mapping(reference_lines, plan.audio_captions, source_video_tags)

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
) -> str:
  """Export active references and the structured prompt as strict YAML."""

  return export_prompt_parts_for_llm(references, seconds, additional_yaml)[0]


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
        io.String.Input(
          "additional_yaml",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          placeholder="Optional top-level YAML mapping...",
          tooltip=(
            "Optional validated YAML mapping merged before references. Generated "
            "top-level keys are reserved."
          ),
        ),
      ],
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
  def fingerprint_inputs(
    cls,
    references: ReferenceLoaderBundle,
    seconds: float = 6.0,
    additional_yaml: str = "",
  ) -> str:
    prompt, _, _ = export_prompt_parts_for_llm(references, seconds, additional_yaml)
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    seconds: float = 6.0,
    additional_yaml: str = "",
  ) -> io.NodeOutput:
    return io.NodeOutput(
      *export_prompt_parts_for_llm(references, seconds, additional_yaml)
    )


__all__ = [
  "MAX_ADDITIONAL_YAML_CHARACTERS",
  "ReferenceLoaderExportPromptForLLMNode",
  "export_prompt_for_llm",
  "export_prompt_parts_for_llm",
]
