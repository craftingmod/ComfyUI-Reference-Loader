from __future__ import annotations

import hashlib
import json
from typing import Any

from comfy_api.latest import io

from ..core.reference_manifest import build_reference_output_plan
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)

REQUIRED_OUTPUT_FORMAT = 'Required format:\n{"key":"value"}'
RESPONSE_FORMATS = ("text", "json")
JSON_RESPONSE_FORMAT = (
  "Return exactly one valid JSON object and nothing else.\n"
  "Do not use Markdown or code fences.\n"
  "Use a flat object equivalent to Record<string, string>: field names may be "
  "descriptive, but every field value must be a string.\n"
  "Do not use nested objects, arrays, numbers, booleans, or null values.\n"
  "If timestamps or temporal details are useful, summarize them in one string "
  "field rather than using a nested object."
)
TEXT_RESPONSE_FORMAT = "Return only plain text.\nDo not use Markdown or code fences."
DEFAULT_JSON_FIELD_GUIDANCE = (
  "Use multiple concise descriptive fields instead of putting the entire "
  "description in one field. Prefer scene, subjects, actions, setting, "
  "lighting, camera, composition, audio, and temporal_order when applicable. "
  "Omit fields that are not applicable instead of guessing."
)

DEFAULT_SYSTEM_PROMPT = """You are a factual reference-media captioner.

Analyze only the provided media. Do not guess identity, intent, unseen content,
or information that cannot be directly observed or heard.

Describe the media concisely for use as a reference description.
Write the description in English unless the user prompt explicitly requests
another language."""

DEFAULT_IMAGE_PROMPT = """Describe this image.

Include the visible subjects, appearance, clothing, pose, composition,
background, lighting, colors, and clearly readable text.

Focus on concrete visual facts. Do not infer names, identity, story, or intent."""

DEFAULT_AUDIO_PROMPT = """Describe this audio.

Identify clearly audible speech, voices, music, sound effects, ambience,
and their temporal order.

Transcribe only words that are clearly audible. Do not infer visual content
or the speaker's identity."""

DEFAULT_VIDEO_PROMPT = """Describe this video.

Include the subjects, actions, scene changes, camera movement, composition,
setting, lighting, and important audio when present.

Use timestamps only for important events when possible. Summarize
temporal_order with key events and major changes; do not enumerate every
small action or fixed time interval.
Focus on observable events and do not infer hidden context."""


def _prompt_or_default(value: str | None, default: str) -> str:
  text = value.strip() if isinstance(value, str) else ""
  return text or default


def _without_response_contract(text: str) -> str:
  for block in (
    f"{REQUIRED_OUTPUT_FORMAT}\n\n{JSON_RESPONSE_FORMAT}",
    REQUIRED_OUTPUT_FORMAT,
    JSON_RESPONSE_FORMAT,
    TEXT_RESPONSE_FORMAT,
  ):
    text = text.replace(block, "")
  return text.rstrip()


def build_system_prompt(
  system_prompt: str | None = None,
  response_format: str = "text",
  json_field_guidance: str | None = None,
) -> str:
  """Normalize the editable system prompt and append the selected response contract."""

  if response_format not in RESPONSE_FORMATS:
    raise ValueError(
      f"Unknown response format {response_format!r}. Expected text or json."
    )
  base = _without_response_contract(
    _prompt_or_default(system_prompt, DEFAULT_SYSTEM_PROMPT)
  )
  if response_format == "json":
    field_guidance = _prompt_or_default(
      json_field_guidance, DEFAULT_JSON_FIELD_GUIDANCE
    )
    suffix = (
      f"{REQUIRED_OUTPUT_FORMAT}\n\n{JSON_RESPONSE_FORMAT}\n\n"
      f"Field guidance:\n{field_guidance}"
    )
  else:
    suffix = TEXT_RESPONSE_FORMAT
  if suffix in base:
    return base
  return f"{base}\n\n{suffix}"


def _request_manifest(
  references: ReferenceLoaderBundle,
  image_ids: tuple[str, ...],
  audio_ids: tuple[str, ...],
  video_ids: tuple[str, ...],
) -> dict[str, Any]:
  by_kind = {
    "image": list(image_ids),
    "audio": list(audio_ids),
    "video": list(video_ids),
  }
  items: list[dict[str, Any]] = []
  for kind, reference_ids in by_kind.items():
    for modality_index, reference_id in enumerate(reference_ids):
      items.append(
        {
          "index": len(items),
          "kind": kind,
          "modality_index": modality_index,
          "reference_id": reference_id,
        }
      )
  return {
    "version": 1,
    "media_fingerprint": hashlib.sha256(
      references.manifest_json.encode("utf-8")
    ).hexdigest(),
    "items": items,
    "by_kind": by_kind,
  }


def build_llm_description_inputs(
  references: ReferenceLoaderBundle,
  system_prompt: str | None = None,
  image_prompt: str | None = None,
  audio_prompt: str | None = None,
  video_prompt: str | None = None,
  json_field_guidance: str | None = None,
  response_format: str = "text",
) -> tuple[list[Any], list[Any], list[Any], str, list[str], str]:
  """Build Sequential Generate media lists, prompts, and request metadata."""

  state = validate_reference_loader_bundle(references)
  plan = build_reference_output_plan(state)
  prompts_by_kind = {
    "image": _prompt_or_default(image_prompt, DEFAULT_IMAGE_PROMPT),
    "audio": _prompt_or_default(audio_prompt, DEFAULT_AUDIO_PROMPT),
    "video": _prompt_or_default(video_prompt, DEFAULT_VIDEO_PROMPT),
  }
  ids_by_kind = {
    "image": plan.image_ids,
    "audio": plan.audio_ids,
    "video": plan.video_ids,
  }
  request_manifest = _request_manifest(
    references,
    plan.image_ids,
    plan.audio_ids,
    plan.video_ids,
  )
  prompts: list[str] = []
  for kind, reference_ids in ids_by_kind.items():
    for _ in reference_ids:
      prompts.append(prompts_by_kind[kind])

  return (
    list(references.images),
    list(references.audios),
    list(references.videos),
    build_system_prompt(system_prompt, response_format, json_field_guidance),
    prompts,
    json.dumps(
      request_manifest,
      ensure_ascii=False,
      sort_keys=True,
      separators=(",", ":"),
    ),
  )


class ReferenceLoaderLLMDescriptionInputsNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderLLMDescriptionInputs",
      display_name="[Reference Loader] LLM Description Inputs",
      category="reference/llm",
      description=(
        "Prepares Reference Loader media and optional prompt overrides for a "
        "sequential multimodal LLM captioning node."
      ),
      search_aliases=[
        "reference loader llm descriptions",
        "reference multimodal prompts",
        "reference caption inputs",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        ),
        io.Combo.Input(
          "response_format",
          options=list(RESPONSE_FORMATS),
          default="json",
          advanced=True,
          tooltip=(
            "Select text for plain-text descriptions or json for one JSON object. "
            "The selected response contract is appended to the system prompt."
          ),
        ),
        io.String.Input(
          "system_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional override; blank uses built-in default...",
          tooltip=(
            "Optional override. Blank input uses the built-in English default. The "
            "selected response format instruction is appended automatically."
          ),
        ),
        io.String.Input(
          "image_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional override; blank uses built-in default...",
          tooltip="Optional override. Blank input uses the built-in English image prompt.",
        ),
        io.String.Input(
          "audio_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional override; blank uses built-in default...",
          tooltip="Optional override. Blank input uses the built-in English audio prompt.",
        ),
        io.String.Input(
          "video_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional override; blank uses built-in default...",
          tooltip="Optional override. Blank input uses the built-in English video prompt.",
        ),
        io.String.Input(
          "json_field_guidance",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=False,
          advanced=True,
          placeholder="Optional override; blank uses built-in default...",
          tooltip=(
            "Optional override used only for json responses. Blank input uses the "
            "built-in multi-field guidance."
          ),
        ),
      ],
      outputs=[
        io.Image.Output("images", is_output_list=True),
        io.Audio.Output("audio", is_output_list=True),
        io.Video.Output("video", is_output_list=True),
        io.String.Output(
          "system",
          tooltip="Common system prompt with the selected response format contract.",
        ),
        io.String.Output(
          "prompt",
          is_output_list=True,
          tooltip="Prompts in image/audio/video media-major execution order.",
        ),
        io.String.Output(
          "request_manifest_json",
          tooltip="Stable media IDs and the flat Sequential Generate order.",
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    references: ReferenceLoaderBundle,
    response_format: str = "text",
    system_prompt: str | None = None,
    image_prompt: str | None = None,
    audio_prompt: str | None = None,
    video_prompt: str | None = None,
    json_field_guidance: str | None = None,
  ) -> str:
    outputs = build_llm_description_inputs(
      references,
      system_prompt,
      image_prompt,
      audio_prompt,
      video_prompt,
      response_format=response_format,
      json_field_guidance=json_field_guidance,
    )
    fingerprint_payload = {
      "manifest": outputs[5],
      "system": outputs[3],
      "prompt": outputs[4],
    }
    return hashlib.sha256(
      json.dumps(
        fingerprint_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
      ).encode("utf-8")
    ).hexdigest()

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    response_format: str = "text",
    system_prompt: str | None = None,
    image_prompt: str | None = None,
    audio_prompt: str | None = None,
    video_prompt: str | None = None,
    json_field_guidance: str | None = None,
  ) -> io.NodeOutput:
    return io.NodeOutput(
      *build_llm_description_inputs(
        references,
        system_prompt,
        image_prompt,
        audio_prompt,
        video_prompt,
        response_format=response_format,
        json_field_guidance=json_field_guidance,
      )
    )


__all__ = [
  "DEFAULT_AUDIO_PROMPT",
  "DEFAULT_IMAGE_PROMPT",
  "DEFAULT_SYSTEM_PROMPT",
  "DEFAULT_VIDEO_PROMPT",
  "JSON_RESPONSE_FORMAT",
  "REQUIRED_OUTPUT_FORMAT",
  "RESPONSE_FORMATS",
  "TEXT_RESPONSE_FORMAT",
  "ReferenceLoaderLLMDescriptionInputsNode",
  "build_llm_description_inputs",
  "build_system_prompt",
]
