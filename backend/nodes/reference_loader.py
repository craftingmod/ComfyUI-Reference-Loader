from __future__ import annotations

import json

from comfy_api.latest import io

from ..core.reference_contract import (
  ReferenceContractError,
  execution_fingerprint,
  image_output_settings,
  parse_reference_state,
)
from ..core.reference_manifest import (
  build_reference_manifest,
  build_reference_output_plan,
)
from ..core.reference_media import load_reference_media, validate_reference_sources
from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle

EMPTY_LOADER_STATE_JSON = json.dumps(
  {
    "version": 1,
    "items": {},
    "imageOrder": [],
    "videoOrder": [],
    "audioOrder": [],
    "videoAudioPolicy": "preserve",
    "ui": {
      "cardAspectRatio": "4 / 3",
      "gridColumns": 3,
      "previewMaxPixels": 1_000_000,
      "previewFit": "contain",
      "waveformPeaks": 300,
    },
  },
  separators=(",", ":"),
)


class ReferenceLoaderNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoader",
      display_name="Reference Loader",
      category="reference/loader",
      description=(
        "Orders image, audio, and video references without batching, with optional "
        "downscale-only IMAGE output limiting, "
        "and emits one bundle for Reference Loader Raw Outputs."
      ),
      search_aliases=["reference", "media loader", "multi image selector"],
      inputs=[
        io.String.Input(
          "loader_state",
          display_name="loader state",
          default=EMPTY_LOADER_STATE_JSON,
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          extra_dict={"widgetType": "REFERENCE_LOADER"},
        ),
        io.Boolean.Input(
          "limit_image_pixels",
          display_name="limit_image_pixels",
          default=False,
          label_on="Limited",
          label_off="Original",
          advanced=True,
          socketless=False,
          tooltip="Downscale IMAGE outputs above max_image_pixels; source and edit files remain unchanged.",
        ),
        io.Float.Input(
          "max_image_pixels",
          display_name="max_image_pixels (MPixel)",
          default=2.0,
          min=0.25,
          max=40.0,
          step=0.1,
          round=0.01,
          advanced=True,
          socketless=False,
          tooltip="Maximum IMAGE output resolution in megapixels when limiting is enabled; smaller images are not enlarged.",
        ),
        io.Boolean.Input(
          "composite_alpha",
          display_name="composite_alpha",
          default=False,
          label_on="Opaque",
          label_off="Preserve",
          advanced=True,
          socketless=False,
          tooltip="Composite alpha-bearing IMAGE outputs onto alpha_background and emit RGB.",
        ),
        io.Color.Input(
          "alpha_background",
          display_name="alpha_background",
          default="#000000",
          advanced=True,
          socketless=False,
          tooltip="Fallback color used only when composite_alpha is Opaque.",
        ),
        io.Int.Input(
          "grid_columns",
          display_name="grid_columns",
          default=3,
          min=1,
          max=8,
          step=1,
          advanced=True,
          socketless=True,
          tooltip="Number of card columns used by each Loader channel.",
        ),
        io.Float.Input(
          "preview_pixels",
          display_name="preview_pixels (MPixel)",
          default=1.0,
          min=0.25,
          max=16.0,
          step=0.25,
          round=0.01,
          advanced=True,
          socketless=True,
          tooltip="Maximum preview resolution in megapixels; execution media is unchanged.",
        ),
        io.Boolean.Input(
          "show_captions",
          display_name="show_captions",
          default=True,
          label_on="Shown",
          label_off="Hidden",
          advanced=True,
          socketless=True,
          tooltip="Show caption fields on Loader cards; captions remain available in Edit when hidden.",
        ),
        io.Combo.Input(
          "card_aspect",
          display_name="card_aspect",
          options=["1 / 1", "4 / 3", "3 / 4", "16 / 9", "9 / 16"],
          default="4 / 3",
          advanced=True,
          socketless=True,
          tooltip="Aspect ratio used by image and video cards in the Loader grid.",
        ),
        io.Combo.Input(
          "preview_fit",
          display_name="preview_fit",
          options=["contain", "cover"],
          default="contain",
          advanced=True,
          socketless=True,
          tooltip="Fit mode used by image and video previews; execution media is unchanged.",
        ),
        io.Int.Input(
          "waveform_pairs",
          display_name="waveform_pairs",
          default=300,
          min=100,
          max=1000,
          step=50,
          advanced=True,
          socketless=True,
          tooltip="Number of min/max amplitude pairs requested for audio waveforms.",
        ),
      ],
      outputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Output(
          "references",
          tooltip=(
            "Bundled media, aligned captions, and manifest for "
            "Reference Loader Raw Outputs."
          ),
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    loader_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    grid_columns: int = 3,
    preview_pixels: float = 1.0,
    show_captions: bool = True,
    card_aspect: str = "4 / 3",
    preview_fit: str = "contain",
    waveform_pairs: int = 300,
  ) -> str:
    _ = (
      grid_columns,
      preview_pixels,
      show_captions,
      card_aspect,
      preview_fit,
      waveform_pairs,
    )
    state = parse_reference_state(loader_state)
    validate_reference_sources(state)
    output_settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    return execution_fingerprint(state, image_output=output_settings)

  @classmethod
  def execute(
    cls,
    loader_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    grid_columns: int = 3,
    preview_pixels: float = 1.0,
    show_captions: bool = True,
    card_aspect: str = "4 / 3",
    preview_fit: str = "contain",
    waveform_pairs: int = 300,
  ) -> io.NodeOutput:
    _ = (
      grid_columns,
      preview_pixels,
      show_captions,
      card_aspect,
      preview_fit,
      waveform_pairs,
    )
    state = parse_reference_state(loader_state)
    output_settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    plan = build_reference_output_plan(state)
    loaded = load_reference_media(state, image_output=output_settings)
    if len(loaded.images) != len(plan.image_ids):
      raise ReferenceContractError(
        "Loaded IMAGE count does not match the active image output contract."
      )
    if len(loaded.audios) != len(plan.audio_ids):
      raise ReferenceContractError(
        "Loaded AUDIO count does not match the active audio output contract."
      )
    if len(loaded.videos) != len(plan.video_ids):
      raise ReferenceContractError(
        "Loaded VIDEO count does not match the active video output contract."
      )
    manifest_json = json.dumps(
      build_reference_manifest(state, image_output=output_settings),
      ensure_ascii=False,
      sort_keys=True,
      separators=(",", ":"),
    )
    return io.NodeOutput(
      ReferenceLoaderBundle(
        images=loaded.images,
        image_captions=plan.image_captions,
        audios=loaded.audios,
        audio_captions=plan.audio_captions,
        videos=loaded.videos,
        video_captions=plan.video_captions,
        manifest_json=manifest_json,
      )
    )


__all__ = ["EMPTY_LOADER_STATE_JSON", "ReferenceLoaderNode"]
