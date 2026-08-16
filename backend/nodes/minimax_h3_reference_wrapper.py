from __future__ import annotations

import importlib
import json
import math
from collections.abc import Mapping, Sequence
from typing import Any

from comfy_api.latest import io

from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle

H3_REFERENCE_FPS = 24
H3_MAX_IMAGES = 9
H3_MAX_VIDEOS = 3
H3_MAX_AUDIOS = 3


def _minimax_h3_node() -> type[io.ComfyNode]:
  try:
    module = importlib.import_module("comfy_extras.nodes_minimax_h3")
    return module.MiniMaxH3ReferenceToVideo
  except (AttributeError, ImportError) as exc:
    raise RuntimeError(
      "MiniMax H3 Reference to Video requires a ComfyUI version with native "
      "MiniMax H3 support."
    ) from exc


def _manifest_output_ids(
  manifest: Mapping[str, Any],
  channel: str,
  expected_count: int,
) -> tuple[str, ...]:
  outputs = manifest.get("outputs")
  if not isinstance(outputs, Mapping):
    raise TypeError("Reference Loader manifest is missing its outputs map.")
  values = outputs.get(channel)
  if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
    raise TypeError(f"Reference Loader manifest outputs.{channel} must be a list.")
  if len(values) != expected_count or any(
    not isinstance(value, str) for value in values
  ):
    raise ValueError(
      f"Reference Loader manifest outputs.{channel} does not match the loaded media."
    )
  return tuple(values)


def _video_frames_at_24fps(video: Any) -> Any:
  try:
    components = video.get_components()
    images = components.images
    frame_rate = float(components.frame_rate)
  except Exception as exc:
    raise ValueError("A reference video could not be decoded into frames.") from exc

  shape = getattr(images, "shape", ())
  if len(shape) != 4 or shape[0] <= 0:
    raise ValueError("A reference video produced no decodable IMAGE frames.")
  if not math.isfinite(frame_rate) or frame_rate <= 0:
    raise ValueError("A reference video has no valid frame rate.")
  if math.isclose(frame_rate, H3_REFERENCE_FPS, rel_tol=0.0, abs_tol=1e-6):
    return images

  source_count = int(shape[0])
  target_count = max(1, math.ceil(source_count * H3_REFERENCE_FPS / frame_rate))
  indices = [
    min(source_count - 1, math.floor(index * frame_rate / H3_REFERENCE_FPS))
    for index in range(target_count)
  ]
  return images[indices]


def _reference_inputs(references: ReferenceLoaderBundle) -> tuple[dict[str, Any], ...]:
  try:
    manifest = json.loads(references.manifest_json)
  except (TypeError, ValueError) as exc:
    raise ValueError("Reference Loader manifest_json must be valid JSON.") from exc
  if not isinstance(manifest, Mapping):
    raise TypeError("Reference Loader manifest_json must contain an object.")

  image_ids = _manifest_output_ids(manifest, "images", len(references.images))
  video_ids = _manifest_output_ids(manifest, "videos", len(references.videos))
  audio_ids = _manifest_output_ids(manifest, "audios", len(references.audios))

  if len(image_ids) > H3_MAX_IMAGES:
    raise ValueError(f"MiniMax H3 accepts at most {H3_MAX_IMAGES} reference images.")
  if len(video_ids) > H3_MAX_VIDEOS:
    raise ValueError(f"MiniMax H3 accepts at most {H3_MAX_VIDEOS} reference videos.")

  audios_by_id = dict(zip(audio_ids, references.audios, strict=True))
  active_video_ids = set(video_ids)
  ref_images = {
    f"ref_image_{index}": image for index, image in enumerate(references.images)
  }
  ref_videos: dict[str, Any] = {}
  ref_video_audios: dict[str, Any] = {}

  for index, (video_id, video) in enumerate(
    zip(video_ids, references.videos, strict=True)
  ):
    ref_videos[f"ref_video_{index}"] = _video_frames_at_24fps(video)
    soundtrack = audios_by_id.get(f"{video_id}:audio")
    if soundtrack is not None:
      ref_video_audios[f"ref_video_audio_{index}"] = soundtrack

  ref_audios: dict[str, Any] = {}
  for audio_id, audio in zip(audio_ids, references.audios, strict=True):
    derived_video_id = (
      audio_id.removesuffix(":audio") if audio_id.endswith(":audio") else None
    )
    if derived_video_id is not None and derived_video_id in active_video_ids:
      continue
    ref_audios[f"ref_audio_{len(ref_audios)}"] = audio

  if len(ref_audios) > H3_MAX_AUDIOS:
    raise ValueError(
      f"MiniMax H3 accepts at most {H3_MAX_AUDIOS} standalone reference audios."
    )
  return ref_images, ref_videos, ref_video_audios, ref_audios


class MiniMaxH3ReferenceToVideoWrapperNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    original = _minimax_h3_node().define_schema()
    inputs = {field.id: field for field in original.inputs}
    return io.Schema(
      node_id="Alyac_MiniMaxH3ReferenceToVideoWrapper",
      display_name="MiniMax H3 Reference to Video Wrapper",
      category="reference/integration",
      description=(
        "Feeds a Reference Loader bundle into ComfyUI's native MiniMax H3 "
        "Reference to Video implementation. Reference videos are sampled at 24 fps."
      ),
      search_aliases=["reference loader minimax h3", "minimax h3 wrapper"],
      inputs=[
        inputs["clip"],
        inputs["vae"],
        inputs["audio_vae"],
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        ),
        inputs["prompt"],
        inputs["width"],
        inputs["height"],
        inputs["length"],
        inputs["ref_image_size"],
      ],
      outputs=original.outputs,
    )

  @classmethod
  def execute(
    cls,
    clip: Any,
    vae: Any,
    audio_vae: Any,
    references: ReferenceLoaderBundle,
    prompt: str,
    width: int,
    height: int,
    length: int,
    ref_image_size: str = "match",
  ) -> io.NodeOutput:
    if not isinstance(references, ReferenceLoaderBundle):
      raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")
    ref_images, ref_videos, ref_video_audios, ref_audios = _reference_inputs(references)
    return _minimax_h3_node().execute(
      clip=clip,
      vae=vae,
      audio_vae=audio_vae,
      prompt=prompt,
      width=width,
      height=height,
      length=length,
      ref_image_size=ref_image_size,
      ref_images=ref_images,
      ref_videos=ref_videos,
      ref_video_audios=ref_video_audios,
      ref_audios=ref_audios,
    )


__all__ = ["MiniMaxH3ReferenceToVideoWrapperNode"]
