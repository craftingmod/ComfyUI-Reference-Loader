from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from comfy_api.latest import io

from ..core.prompt_contract import (
  EMPTY_PROMPT_STATE_JSON,
  compile_prompt,
  parse_prompt_state,
)
from ..core.reference_contract import ReferenceContractError, ReferenceState
from ..core.reference_manifest import (
  build_reference_output_plan,
  parse_reference_manifest_state,
)

REFERENCE_LOADER_BUNDLE_TYPE = io.Custom("REFERENCE_LOADER_BUNDLE")


@dataclass(frozen=True, slots=True, eq=False)
class ReferenceLoaderBundle:
  images: tuple[Any, ...]
  image_captions: tuple[str, ...]
  audios: tuple[Any, ...]
  audio_captions: tuple[str, ...]
  videos: tuple[Any, ...]
  video_captions: tuple[str, ...]
  manifest_json: str
  prompt_state_json: str = EMPTY_PROMPT_STATE_JSON
  compiled_prompt: str = ""


def validate_reference_loader_bundle(
  references: ReferenceLoaderBundle,
) -> ReferenceState:
  """Validate media, captions, manifest, and prompt as one aligned snapshot."""

  if not isinstance(references, ReferenceLoaderBundle):
    raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")
  state = parse_reference_manifest_state(references.manifest_json)
  plan = build_reference_output_plan(state)
  alignments = (
    (
      "IMAGE",
      references.images,
      references.image_captions,
      plan.image_ids,
      plan.image_captions,
    ),
    (
      "AUDIO",
      references.audios,
      references.audio_captions,
      plan.audio_ids,
      plan.audio_captions,
    ),
    (
      "VIDEO",
      references.videos,
      references.video_captions,
      plan.video_ids,
      plan.video_captions,
    ),
  )
  for label, media, captions, ids, expected_captions in alignments:
    if len(media) != len(ids) or tuple(captions) != expected_captions:
      raise ReferenceContractError(
        f"Reference Loader manifest does not match bundled {label} outputs."
      )
  document = parse_prompt_state(references.prompt_state_json)
  if compile_prompt(document, state) != references.compiled_prompt:
    raise ReferenceContractError(
      "Reference Loader prompt state does not match the bundled compiled prompt."
    )
  return state


__all__ = [
  "REFERENCE_LOADER_BUNDLE_TYPE",
  "ReferenceLoaderBundle",
  "validate_reference_loader_bundle",
]
