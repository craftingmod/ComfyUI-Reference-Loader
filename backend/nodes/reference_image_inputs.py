from __future__ import annotations

from typing import Any

from comfy_api.latest import io


def reference_image_output_inputs() -> list[Any]:
  return [
    io.Boolean.Input(
      "limit_image_pixels",
      display_name="limit_image_pixels",
      default=False,
      label_on="Limited",
      label_off="Original",
      advanced=True,
      socketless=False,
      tooltip=(
        "Downscale IMAGE outputs above max_image_pixels; source and edit files "
        "remain unchanged."
      ),
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
      tooltip=(
        "Maximum IMAGE output resolution in megapixels when limiting is enabled; "
        "smaller images are not enlarged."
      ),
    ),
    io.Boolean.Input(
      "composite_alpha",
      display_name="composite_alpha",
      default=False,
      label_on="Opaque",
      label_off="Preserve",
      advanced=True,
      socketless=False,
      tooltip=(
        "Composite alpha-bearing IMAGE outputs onto alpha_background and emit RGB."
      ),
    ),
    io.Color.Input(
      "alpha_background",
      display_name="alpha_background",
      default="#000000",
      advanced=True,
      socketless=False,
      tooltip="Fallback color used only when composite_alpha is Opaque.",
    ),
  ]


def reference_preview_pixels_input() -> Any:
  return io.Float.Input(
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
  )


__all__ = ["reference_image_output_inputs", "reference_preview_pixels_input"]
