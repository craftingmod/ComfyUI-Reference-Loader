from __future__ import annotations

from typing import Any

from comfy_api.latest import io

from ..core.reference_contract import (
  ImageOutputSettings,
  ReferenceContractError,
  ReferenceItem,
  ReferenceState,
  execution_fingerprint,
  image_output_settings,
  parse_reference_state,
)
from ..core.reference_media import load_reference_media, validate_reference_sources
from .reference_image_inputs import (
  reference_image_output_inputs,
  reference_preview_pixels_input,
)
from .reference_loader import EMPTY_LOADER_STATE_JSON


def _single_enabled_image(state: ReferenceState) -> ReferenceItem:
  if (
    len(state.items) != 1
    or len(state.image_order) != 1
    or state.video_order
    or state.audio_order
  ):
    raise ReferenceContractError(
      "Load Reference Image requires exactly one image and no audio or video."
    )
  item = state.items[state.image_order[0]]
  if item.kind != "image" or not item.image_enabled:
    raise ReferenceContractError(
      "Load Reference Image requires exactly one enabled image."
    )
  return item


def _parse_single_image_state(value: str) -> tuple[ReferenceState, ReferenceItem]:
  state = parse_reference_state(value)
  return state, _single_enabled_image(state)


def _image_and_mask(image: Any) -> tuple[Any, Any]:
  shape = getattr(image, "shape", None)
  if getattr(image, "ndim", None) != 4 or shape is None:
    raise ReferenceContractError(
      "Load Reference Image decoded an invalid IMAGE tensor."
    )
  try:
    channels = int(shape[-1])
  except (TypeError, ValueError, IndexError) as exc:
    raise ReferenceContractError(
      "Load Reference Image decoded an invalid IMAGE tensor."
    ) from exc
  if channels == 4:
    return image[..., :3], 1.0 - image[..., 3]
  if channels != 3:
    raise ReferenceContractError(
      "Load Reference Image decoded an IMAGE with an unsupported channel count."
    )
  try:
    batch = int(shape[0])
  except (TypeError, ValueError, IndexError) as exc:
    raise ReferenceContractError(
      "Load Reference Image decoded an invalid IMAGE tensor."
    ) from exc
  if batch <= 0:
    raise ReferenceContractError(
      "Load Reference Image decoded an invalid IMAGE tensor."
    )
  new_zeros = getattr(image, "new_zeros", None)
  if not callable(new_zeros):
    raise ReferenceContractError(
      "Load Reference Image decoded an invalid IMAGE tensor."
    )
  return image, new_zeros((batch, 64, 64))


def _output_settings(
  limit_image_pixels: bool,
  max_image_pixels: float,
  composite_alpha: bool,
  alpha_background: str,
) -> ImageOutputSettings:
  return image_output_settings(
    limit_image_pixels,
    max_image_pixels,
    composite_alpha,
    alpha_background,
  )


class LoadReferenceImageNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_LoadReferenceImage",
      display_name="Load Reference Image",
      category="reference/loader",
      description=(
        "Loads and non-destructively edits one managed reference image, with a "
        "low-resolution preview, optional output pixel limiting, and alpha "
        "handling. Animated sources use their first frame."
      ),
      search_aliases=["load image", "reference image", "image editor"],
      inputs=[
        io.String.Input(
          "image_state",
          display_name="image",
          default=EMPTY_LOADER_STATE_JSON,
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          extra_dict={"widgetType": "REFERENCE_IMAGE_LOADER"},
          tooltip="Managed state for exactly one reference image.",
        ),
        *reference_image_output_inputs(),
        reference_preview_pixels_input(),
      ],
      outputs=[
        io.Image.Output(
          "image",
          tooltip="RGB image output, matching ComfyUI's Load Image contract.",
        ),
        io.Mask.Output(
          "mask",
          tooltip="Inverse image alpha, or a zero mask when the output is opaque.",
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    image_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    preview_pixels: float = 1.0,
  ) -> str:
    _ = preview_pixels
    state, _item = _parse_single_image_state(image_state)
    validate_reference_sources(state)
    settings = _output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    return execution_fingerprint(state, image_output=settings)

  @classmethod
  def execute(
    cls,
    image_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    preview_pixels: float = 1.0,
  ) -> io.NodeOutput:
    _ = preview_pixels
    state, _item = _parse_single_image_state(image_state)
    settings = _output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    loaded = load_reference_media(state, image_output=settings)
    if len(loaded.images) != 1 or loaded.audios or loaded.videos:
      raise ReferenceContractError(
        "Loaded media does not match the single-image output contract."
      )
    image = loaded.images[0]
    output_image, mask = _image_and_mask(image)
    return io.NodeOutput(output_image, mask)


__all__ = ["LoadReferenceImageNode"]
