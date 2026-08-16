from __future__ import annotations

from comfy_api.latest import io

from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle


class ReferenceLoaderRawOutputsNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderRawOutputs",
      display_name="Reference Loader Raw Outputs",
      category="reference/output",
      description=(
        "Unpacks a Reference Loader bundle into aligned image, audio, video, "
        "caption, and manifest outputs."
      ),
      search_aliases=["reference unpack", "reference splitter", "media outputs"],
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
    )


__all__ = ["ReferenceLoaderRawOutputsNode"]
