from __future__ import annotations

from comfy_api.latest import io

from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle


class ReferenceLoaderRawOutputsNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderRawOutputs",
      display_name="[Reference Loader] Media Outputs",
      category="reference/output",
      description=(
        "Unpacks a Reference Loader bundle into aligned image, audio, video, "
        "caption, manifest, and nullable first-image outputs."
      ),
      search_aliases=[
        "reference media outputs",
        "reference raw outputs",
        "reference unpack",
        "reference splitter",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        )
      ],
      outputs=[
        io.Image.Output("images", is_output_list=True),
        io.String.Output("image_captions", is_output_list=True),
        io.Audio.Output("audios", is_output_list=True),
        io.String.Output("audio_captions", is_output_list=True),
        io.Video.Output("videos", is_output_list=True),
        io.String.Output("video_captions", is_output_list=True),
        io.String.Output("manifest_json"),
        io.Image.Output(
          "first_image",
          tooltip="First enabled image, or None when no image is enabled.",
        ),
      ],
    )

  @classmethod
  def execute(cls, references: ReferenceLoaderBundle) -> io.NodeOutput:
    if not isinstance(references, ReferenceLoaderBundle):
      raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")
    return io.NodeOutput(
      list(references.images),
      list(references.image_captions),
      list(references.audios),
      list(references.audio_captions),
      list(references.videos),
      list(references.video_captions),
      references.manifest_json,
      references.images[0] if references.images else None,
    )


__all__ = ["ReferenceLoaderRawOutputsNode"]
