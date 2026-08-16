from __future__ import annotations

from comfy_api.latest import io

from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle

FRAME_MODES = ("I2V", "L2V", "FL2V", "FL2V_LOOP", "T2V")


class ReferenceLoaderStartEndFramesNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderStartEndFrames",
      display_name="Reference Loader Start/End Frames",
      category="reference/output",
      description=(
        "Projects zero, one, or two enabled Reference Loader images into nullable "
        "start_image and end_image outputs for I2V, L2V, FL2V, FL2V_LOOP, "
        "and T2V workflows."
      ),
      search_aliases=[
        "reference loader i2v",
        "reference loader flf2v",
        "first last frame",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        ),
        io.Combo.Input(
          "mode",
          options=list(FRAME_MODES),
          default="FL2V",
          tooltip="Select which nullable frame outputs are populated.",
        ),
        io.String.Input(
          "enum_string",
          optional=True,
          force_input=True,
          tooltip=(
            "Optional string socket override for mode. Accepts I2V, L2V, FL2V, "
            "FL2V_LOOP, or T2V; a blank value falls back to the Combo."
          ),
        ),
      ],
      outputs=[
        io.Image.Output(
          "start_image",
          tooltip="First enabled image, or None when no image is enabled.",
        ),
        io.Image.Output(
          "end_image",
          tooltip=(
            "Mode-selected ending image, or None when the selected mode has no "
            "available ending frame."
          ),
        ),
      ],
    )

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    mode: str = "FL2V",
    enum_string: str | None = None,
  ) -> io.NodeOutput:
    if not isinstance(references, ReferenceLoaderBundle):
      raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")

    selected_mode = _resolve_mode(mode, enum_string)
    if selected_mode == "T2V":
      return io.NodeOutput(None, None)

    image_count = len(references.images)
    if image_count > 2:
      raise ValueError(
        "Reference Loader Start/End Frames accepts at most two enabled images; "
        f"received {image_count}."
      )

    first_image = references.images[0] if image_count >= 1 else None
    last_image = references.images[-1] if image_count >= 1 else None
    start_image = first_image if selected_mode in {"I2V", "FL2V", "FL2V_LOOP"} else None
    end_image = (
      references.images[1]
      if selected_mode == "FL2V" and image_count >= 2
      else first_image
      if selected_mode == "FL2V_LOOP"
      else last_image
      if selected_mode == "L2V"
      else None
    )
    return io.NodeOutput(start_image, end_image)


def _resolve_mode(mode: str, enum_string: str | None) -> str:
  override = enum_string.strip().upper() if isinstance(enum_string, str) else ""
  selected = override or (mode.strip().upper() if isinstance(mode, str) else "")
  if selected not in FRAME_MODES:
    allowed = ", ".join(FRAME_MODES)
    raise ValueError(f"mode must be one of {allowed}; received {selected or mode!r}.")
  return selected


__all__ = ["FRAME_MODES", "ReferenceLoaderStartEndFramesNode"]
