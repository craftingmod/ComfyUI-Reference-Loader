from __future__ import annotations

import hashlib
import json
from typing import Any

from comfy_api.latest import io

from ..core.prompt_contract import compile_prompt_sections, parse_prompt_state
from ..core.reference_contract import execution_projection
from ..core.reference_manifest import build_reference_output_plan
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)

EXPORT_SCHEMA_VERSION = 1


def _yaml_scalar(value: str) -> str:
  """Return a YAML 1.2 string scalar using its JSON-compatible quoted form."""

  return json.dumps(value, ensure_ascii=False)


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


def export_prompt_for_llm(references: ReferenceLoaderBundle) -> str:
  """Export active references and the structured prompt as strict YAML."""

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

  lines = [f"schema_version: {EXPORT_SCHEMA_VERSION}", "", "references:"]
  _append_caption_mapping(lines, "images", "Picture", plan.image_captions)
  _append_caption_mapping(lines, "videos", "Video", plan.video_captions)
  _append_audio_mapping(lines, plan.audio_captions, source_video_tags)
  sections = compile_prompt_sections(document, state)
  if not sections:
    lines.extend(["", "generation_directives: {}"])
  else:
    lines.extend(["", "generation_directives:"])
    for title, content in sections:
      lines.append(f"  {title}: {_yaml_scalar(content)}")
  return "\n".join(lines)


class ReferenceLoaderExportPromptForLLMNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderExportPromptForLLM",
      display_name="Reference Loader Export Prompt for LLM",
      category="reference/output",
      description=(
        "Exports active reference captions and the structured Reference Loader "
        "generation directives as a strict YAML string for an LLM."
      ),
      search_aliases=["reference llm prompt", "reference yaml export"],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        )
      ],
      outputs=[
        io.String.Output(
          "prompt",
          tooltip="Strict YAML containing active references and generation directives.",
        )
      ],
    )

  @classmethod
  def fingerprint_inputs(cls, references: ReferenceLoaderBundle) -> str:
    return hashlib.sha256(export_prompt_for_llm(references).encode("utf-8")).hexdigest()

  @classmethod
  def execute(cls, references: ReferenceLoaderBundle) -> io.NodeOutput:
    return io.NodeOutput(export_prompt_for_llm(references))


__all__ = [
  "EXPORT_SCHEMA_VERSION",
  "ReferenceLoaderExportPromptForLLMNode",
  "export_prompt_for_llm",
]
