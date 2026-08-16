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
)
from ..core.reference_media import load_reference_media, validate_reference_sources
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)


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
      display_name="[Reference Loader] Options Override",
      category="reference/loader",
      description=(
        "Rebuilds Reference Loader IMAGE outputs with backend-only pixel-limit and "
        "alpha-compositing overrides while preserving all references and captions."
      ),
      search_aliases=[
        "reference loader options override",
        "reference options",
        "reference override",
      ],
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
    state = validate_reference_loader_bundle(references)
    image_state = _image_only_state(state)
    validate_reference_sources(image_state)
    settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    return hashlib.sha256(
      (
        f"{execution_fingerprint(state, image_output=settings)}\0"
        f"{references.prompt_state_json}\0{references.compiled_prompt}"
      ).encode()
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
    state = validate_reference_loader_bundle(references)
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
        prompt_state_json=references.prompt_state_json,
        compiled_prompt=references.compiled_prompt,
      )
    )


__all__ = ["ReferenceLoaderOptionsOverrideNode"]
