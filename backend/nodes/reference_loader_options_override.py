from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from types import MappingProxyType

from comfy_api.latest import io

from ..core.reference_contract import (
  ReferenceContractError,
  ReferenceState,
  execution_fingerprint,
  image_output_settings,
)
from ..core.reference_manifest import (
  build_reference_manifest,
  build_reference_output_plan,
  parse_reference_manifest_state,
)
from ..core.reference_media import load_reference_media, validate_reference_sources
from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle


def _validated_state(references: ReferenceLoaderBundle) -> ReferenceState:
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
  return state


def _image_only_state(state: ReferenceState) -> ReferenceState:
  items = {
    item_id: (
      item
      if item.kind == "image"
      else replace(item, video_enabled=False, audio_enabled=False)
    )
    for item_id, item in state.items.items()
  }
  return replace(state, items=MappingProxyType(items))


class ReferenceLoaderOptionsOverrideNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderOptionsOverride",
      display_name="Reference Loader Options Override",
      category="reference/loader",
      description=(
        "Rebuilds Reference Loader IMAGE outputs with backend-only pixel-limit and "
        "alpha-compositing overrides while preserving all references and captions."
      ),
      search_aliases=["reference options", "reference override"],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input("references"),
        io.Boolean.Input(
          "limit_image_pixels",
          default=False,
          label_on="Limited",
          label_off="Original",
          socketless=False,
        ),
        io.Float.Input(
          "max_image_pixels",
          display_name="max_image_pixels (MPixel)",
          default=2.0,
          min=0.25,
          max=40.0,
          step=0.1,
          round=0.01,
          socketless=False,
        ),
        io.Boolean.Input(
          "composite_alpha",
          default=False,
          label_on="Opaque",
          label_off="Preserve",
          socketless=False,
        ),
        io.Color.Input(
          "alpha_background",
          default="#000000",
          socketless=False,
          tooltip="Used only when composite_alpha is Opaque.",
        ),
      ],
      outputs=[REFERENCE_LOADER_BUNDLE_TYPE.Output("references")],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    references: ReferenceLoaderBundle,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
  ) -> str:
    state = _validated_state(references)
    image_state = _image_only_state(state)
    validate_reference_sources(image_state)
    settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    return hashlib.sha256(
      execution_fingerprint(state, image_output=settings).encode()
    ).hexdigest()

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
  ) -> io.NodeOutput:
    state = _validated_state(references)
    settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    loaded = load_reference_media(
      _image_only_state(state),
      image_output=settings,
    )
    if len(loaded.images) != len(references.images):
      raise ReferenceContractError(
        "Reloaded IMAGE count does not match the Reference Loader bundle."
      )
    manifest_json = json.dumps(
      build_reference_manifest(state, image_output=settings),
      ensure_ascii=False,
      sort_keys=True,
      separators=(",", ":"),
    )
    return io.NodeOutput(
      ReferenceLoaderBundle(
        images=loaded.images,
        image_captions=references.image_captions,
        audios=references.audios,
        audio_captions=references.audio_captions,
        videos=references.videos,
        video_captions=references.video_captions,
        manifest_json=manifest_json,
      )
    )


__all__ = ["ReferenceLoaderOptionsOverrideNode"]
