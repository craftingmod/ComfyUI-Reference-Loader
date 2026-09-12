from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from comfy_api.latest import io

from ..core.prompt_contract import (
  EMPTY_PROMPT_STATE_JSON,
  compile_prompt,
  parse_prompt_state,
)
from ..core.reference_contract import (
  H3_OUTPUT_DEFAULT_FPS,
  H3_OUTPUT_DEFAULT_TOTAL_FRAMES,
  ReferenceContractError,
  ReferenceState,
  h3_output_settings,
  h3_timeline_media_ids,
)
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
  reference_fingerprint: str = ""
  h3_fps: int = H3_OUTPUT_DEFAULT_FPS
  h3_total_frames: int = H3_OUTPUT_DEFAULT_TOTAL_FRAMES
  guide_media: Mapping[str, Any] = field(default_factory=dict)


def validate_reference_loader_bundle(
  references: ReferenceLoaderBundle,
) -> ReferenceState:
  """Validate media, captions, manifest, and prompt as one aligned snapshot."""

  if not isinstance(references, ReferenceLoaderBundle):
    raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")
  state = parse_reference_manifest_state(references.manifest_json)
  if (
    h3_output_settings(references.h3_fps, references.h3_total_frames) != state.h3_output
  ):
    raise ReferenceContractError(
      "Reference Loader bundle H3 output settings do not match its manifest."
    )
  if not isinstance(references.guide_media, Mapping):
    raise TypeError("Reference Loader bundle guide_media must be a mapping.")
  expected_guide_ids = set(h3_timeline_media_ids(state))
  actual_guide_ids = set(references.guide_media)
  if actual_guide_ids != expected_guide_ids:
    missing = sorted(expected_guide_ids - actual_guide_ids)
    extra = sorted(actual_guide_ids - expected_guide_ids)
    detail = []
    if missing:
      detail.append(f"missing guide media {missing}")
    if extra:
      detail.append(f"unexpected guide media {extra}")
    raise ReferenceContractError(
      "Reference Loader manifest does not match bundled guide media: "
      + "; ".join(detail)
    )
  if any(references.guide_media[media_id] is None for media_id in actual_guide_ids):
    raise ReferenceContractError(
      "Reference Loader guide media cannot contain null values."
    )
  plan = build_reference_output_plan(state)
  try:
    manifest = json.loads(references.manifest_json)
  except (TypeError, ValueError) as exc:
    raise ReferenceContractError(
      "Reference Loader manifest must be valid JSON."
    ) from exc
  expected_outputs = {
    "images": list(plan.image_ids),
    "audios": list(plan.audio_ids),
    "videos": list(plan.video_ids),
  }
  expected_captions = {
    "images": list(plan.image_captions),
    "audios": list(plan.audio_captions),
    "videos": list(plan.video_captions),
  }
  if (
    not isinstance(manifest, Mapping)
    or manifest.get("outputs") != expected_outputs
    or manifest.get("output_captions") != expected_captions
  ):
    raise ReferenceContractError(
      "Reference Loader manifest does not match its active output plan."
    )
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
  if references.reference_fingerprint and (
    len(references.reference_fingerprint) != 64
    or any(
      character not in "0123456789abcdef"
      for character in references.reference_fingerprint
    )
  ):
    raise ReferenceContractError(
      "Reference Loader bundle fingerprint must be a SHA-256 hex digest."
    )
  return state


__all__ = [
  "REFERENCE_LOADER_BUNDLE_TYPE",
  "ReferenceLoaderBundle",
  "validate_reference_loader_bundle",
]
