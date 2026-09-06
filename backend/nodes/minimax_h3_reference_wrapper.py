from __future__ import annotations

import importlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

from comfy_api.latest import io

from ..core.reference_contract import H3Timeline
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)

H3_REFERENCE_FPS = 24
H3_MAX_IMAGES = 9
H3_MAX_VIDEOS = 3
H3_MAX_AUDIOS = 3

_AUDIO_TAG_RE = re.compile(r"<Audio ([1-9][0-9]*)>")


def _minimax_h3_node() -> type[io.ComfyNode]:
  try:
    module = importlib.import_module("comfy_extras.nodes_minimax_h3")
    return module.MiniMaxH3ReferenceToVideo
  except (AttributeError, ImportError) as exc:
    raise RuntimeError(
      "MiniMax H3 Reference to Video requires a ComfyUI version with native "
      "MiniMax H3 support."
    ) from exc


def _minimax_h3_add_guide_node() -> type[io.ComfyNode]:
  try:
    module = importlib.import_module("comfy_extras.nodes_minimax_h3")
    return module.MiniMaxH3AddGuide
  except (AttributeError, ImportError) as exc:
    raise RuntimeError(
      "H3 Timeline Guides require a ComfyUI version with native "
      "MiniMaxH3AddGuide support."
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


def _remap_audio_tags(
  prompt: str,
  loader_audio_ids: tuple[str, ...],
  h3_audio_ids: tuple[str, ...],
) -> str:
  """Translate Loader audio ordinals to MiniMax H3 presentation ordinals."""

  h3_ordinals = {
    audio_id: index for index, audio_id in enumerate(h3_audio_ids, start=1)
  }
  ordinal_map = {
    loader_ordinal: h3_ordinals[audio_id]
    for loader_ordinal, audio_id in enumerate(loader_audio_ids, start=1)
  }

  def replace(match: re.Match[str]) -> str:
    ordinal = int(match.group(1))
    h3_ordinal = ordinal_map.get(ordinal)
    return match.group(0) if h3_ordinal is None else f"<Audio {h3_ordinal}>"

  return _AUDIO_TAG_RE.sub(replace, prompt)


def _reference_inputs(
  references: ReferenceLoaderBundle,
) -> tuple[
  dict[str, Any],
  dict[str, Any],
  dict[str, Any],
  dict[str, Any],
  tuple[str, ...],
  tuple[str, ...],
]:
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
  paired_audio_ids = tuple(
    f"{video_id}:audio" for video_id in video_ids if f"{video_id}:audio" in audios_by_id
  )
  paired_audio_id_set = set(paired_audio_ids)
  standalone_audio_ids = tuple(
    audio_id for audio_id in audio_ids if audio_id not in paired_audio_id_set
  )
  h3_audio_ids = paired_audio_ids + standalone_audio_ids
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
  return (
    ref_images,
    ref_videos,
    ref_video_audios,
    ref_audios,
    audio_ids,
    h3_audio_ids,
  )


def _manifest(references: ReferenceLoaderBundle) -> Mapping[str, Any]:
  try:
    value = json.loads(references.manifest_json)
  except (TypeError, ValueError) as exc:
    raise ValueError("Reference Loader manifest_json must be valid JSON.") from exc
  if not isinstance(value, Mapping):
    raise TypeError("Reference Loader manifest_json must contain an object.")
  return value


def _validated_timeline(
  references: ReferenceLoaderBundle,
  manifest: Mapping[str, Any],
) -> H3Timeline:
  # Older hand-built bundles used by integrations may only carry the output map.
  # Full bundles emitted by Reference Loader always have items and can therefore
  # be checked as one aligned snapshot before a timeline is consumed.
  if "items" in manifest and "version" in manifest:
    return validate_reference_loader_bundle(references).h3_timeline
  raw = manifest.get("h3_timeline")
  if raw is None:
    return H3Timeline.empty()
  if not isinstance(raw, Mapping):
    raise TypeError("Reference Loader manifest h3_timeline must be an object.")
  raw_guides = raw.get("guides")
  if not isinstance(raw_guides, list):
    raise TypeError("Reference Loader manifest h3_timeline.guides must be a list.")
  # Minimal compatibility bundles cannot prove media kinds, but still receive
  # strict shape checks before the native node is called.
  guides = []
  for index, raw_guide in enumerate(raw_guides):
    if not isinstance(raw_guide, Mapping):
      raise TypeError(f"H3 timeline guide {index + 1} must be an object.")
    guide_id = raw_guide.get("id")
    frame_index = raw_guide.get("frame_index")
    if not isinstance(guide_id, str) or not guide_id:
      raise ValueError(f"H3 timeline guide {index + 1} has an invalid ID.")
    if (
      isinstance(frame_index, bool)
      or not isinstance(frame_index, int)
      or frame_index < 0
    ):
      raise ValueError(f"H3 timeline guide {guide_id} has an invalid frame index.")
    from ..core.reference_contract import H3GuideEntry

    guides.append(
      H3GuideEntry(
        id=guide_id,
        frame_index=frame_index,
        visual_id=raw_guide.get("visual_id"),
        audio_id=raw_guide.get("audio_id"),
      )
    )
  version = raw.get("version")
  enabled = raw.get("enabled")
  if isinstance(version, bool) or version != 1 or not isinstance(enabled, bool):
    raise ValueError(
      "Reference Loader manifest h3_timeline has an invalid version or enabled flag."
    )
  return H3Timeline(
    version=1,
    enabled=enabled,
    start_image_id=raw.get("start_image_id"),
    end_image_id=raw.get("end_image_id"),
    guides=tuple(guides),
  )


def _node_output_values(output: Any) -> tuple[Any, ...]:
  result = getattr(output, "result", None)
  if callable(result):
    result = result()
  if result is not None:
    try:
      return tuple(result)
    except TypeError:
      pass
  try:
    return tuple(output)
  except TypeError as exc:
    raise RuntimeError("A native MiniMax H3 node returned an invalid output.") from exc


def _latent_frame_count(latent: Any, requested_length: int) -> int:
  raw_frame_count = latent.get("frame_count") if isinstance(latent, Mapping) else None
  if isinstance(raw_frame_count, int) and raw_frame_count > 0:
    return raw_frame_count
  try:
    samples = latent["samples"]
    tensors = samples.tensors
    video = tensors[0]
    temporal_tokens = int(video.shape[2])
    model = importlib.import_module("comfy.ldm.minimax.model")
    frame_per_token = model.FRAME_PER_TOKEN
    frame_count = sum(frame_per_token[index % 5] for index in range(temporal_tokens))
    if frame_count > 0:
      return frame_count
  except (AttributeError, ImportError, KeyError, IndexError, TypeError, ValueError):
    pass
  try:
    module = importlib.import_module("comfy_extras.nodes_minimax_h3")
    frame_count = int(module.temporal_shape(requested_length)[0])
    if frame_count > 0:
      return frame_count
  except (AttributeError, ImportError, IndexError, TypeError, ValueError):
    pass
  if isinstance(requested_length, int) and requested_length > 0:
    return requested_length
  raise ValueError("MiniMax H3 returned a latent with no usable frame count.")


def _image_frame_count(image: Any) -> int:
  shape = getattr(image, "shape", ())
  if len(shape) > 0:
    try:
      return max(1, int(shape[0]))
    except (TypeError, ValueError):
      pass
  try:
    return max(1, len(image))
  except TypeError:
    return 1


def _native_guide_frame_count(image: Any) -> int:
  frame_count = _image_frame_count(image)
  if frame_count < 5:
    return 1
  while frame_count % 17 != 5:
    frame_count -= 1
  return frame_count


def _audio_guide_frame_count(audio: Any) -> int:
  """Estimate an audio guide's video-frame span without copying its waveform."""

  if isinstance(audio, Mapping):
    waveform = audio.get("waveform")
    sample_rate = audio.get("sample_rate")
    shape = getattr(waveform, "shape", ())
    if (
      isinstance(sample_rate, (int, float))
      and not isinstance(sample_rate, bool)
      and sample_rate > 0
      and len(shape) > 0
    ):
      try:
        return max(1, math.ceil(float(shape[-1]) * H3_REFERENCE_FPS / sample_rate))
      except (TypeError, ValueError, OverflowError):
        pass
  return 1


def _timeline_media(
  references: ReferenceLoaderBundle,
  media_id: str,
  *,
  role: str,
) -> Any:
  if media_id not in references.guide_media:
    raise ValueError(
      f"H3 timeline {role} media {media_id!r} was not loaded by Reference Loader."
    )
  value = references.guide_media[media_id]
  if value is None:
    raise ValueError(f"H3 timeline {role} media {media_id!r} is empty.")
  return value


def _timeline_entries(
  references: ReferenceLoaderBundle,
  timeline: H3Timeline,
) -> list[tuple[str, int, Any, Any, int, int]]:
  """Resolve timeline rows to AddGuide payloads and validate visual ranges."""

  entries: list[tuple[str, int, Any, Any, int, int]] = []
  if timeline.start_image_id is not None:
    entries.append(
      (
        "Start",
        0,
        _timeline_media(references, timeline.start_image_id, role="Start"),
        None,
        1,
        0,
      )
    )
  for guide in sorted(timeline.guides, key=lambda item: (item.frame_index, item.id)):
    if guide.visual_id is None and guide.audio_id is None:
      raise ValueError(
        f"H3 timeline guide {guide.id!r} needs a Visual or Audio selection."
      )
    image = None
    if guide.visual_id is not None:
      image = _timeline_media(references, guide.visual_id, role=f"guide {guide.id}")
      if guide.visual_id in references.guide_media and hasattr(image, "get_components"):
        # VIDEO values expose the same components as reference videos; IMAGE
        # tensors do not. Only convert values that actually look like VIDEO.
        image = _video_frames_at_24fps(image)
    audio = (
      _timeline_media(references, guide.audio_id, role=f"guide {guide.id}")
      if guide.audio_id is not None
      else None
    )
    entries.append(
      (
        f"Guide {guide.id}",
        guide.frame_index,
        image,
        audio,
        _native_guide_frame_count(image) if image is not None else 0,
        _audio_guide_frame_count(audio) if audio is not None else 0,
      )
    )
  if timeline.end_image_id is not None:
    entries.append(
      (
        "End",
        -1,
        _timeline_media(references, timeline.end_image_id, role="End"),
        None,
        1,
        0,
      )
    )
  return entries


def _validate_timeline_ranges(
  entries: list[tuple[str, int, Any, Any, int, int]],
  frame_count: int,
) -> None:
  visual_ranges: list[tuple[int, int, str]] = []
  audio_ranges: list[tuple[int, int, str]] = []
  for label, frame_index, image, audio, visual_length, audio_length in entries:
    resolved = frame_count + frame_index if frame_index < 0 else frame_index
    if resolved < 0 or resolved >= frame_count:
      raise ValueError(
        f"{label} requests frame {frame_index}, outside the {frame_count}-frame output."
      )
    if image is not None:
      end = resolved + visual_length
      if end > frame_count:
        raise ValueError(
          f"{label} visual guide ({visual_length} frames) at {frame_index} "
          f"does not fit in the {frame_count}-frame output."
        )
      for other_start, other_end, other_label in visual_ranges:
        if resolved < other_end and other_start < end:
          raise ValueError(
            f"{label} overlaps visual guide {other_label}; choose non-overlapping frames."
          )
      visual_ranges.append((resolved, end, label))
    if audio is not None:
      audio_end = min(frame_count, resolved + audio_length)
      for other_start, other_end, other_label in audio_ranges:
        if resolved < other_end and other_start < audio_end:
          raise ValueError(
            f"{label} overlaps audio guide {other_label}; choose non-overlapping frames."
          )
      if audio_end <= resolved:
        raise ValueError(f"{label} audio guide is empty at frame {resolved}.")
      audio_ranges.append((resolved, audio_end, label))


class MiniMaxH3ReferenceToVideoWrapperNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    original = _minimax_h3_node().define_schema()
    inputs = {field.id: field for field in original.inputs}
    return io.Schema(
      node_id="Alyac_MiniMaxH3ReferenceToVideoWrapper",
      display_name="[Reference Loader] MiniMax H3 Wrapper",
      category="reference/integration",
      description=(
        "Feeds a Reference Loader bundle into ComfyUI's native MiniMax H3 "
        "Reference to Video implementation. Reference videos are sampled at 24 fps."
      ),
      search_aliases=[
        "minimax h3 reference to video wrapper",
        "reference loader minimax h3",
        "minimax h3 wrapper",
      ],
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
    vae: Any = None,
    audio_vae: Any = None,
    references: ReferenceLoaderBundle | None = None,
    prompt: str = "",
    width: int = 1344,
    height: int = 768,
    length: int = 124,
    ref_image_size: str = "match",
  ) -> io.NodeOutput:
    if not isinstance(references, ReferenceLoaderBundle):
      raise TypeError("references must be a REFERENCE_LOADER_BUNDLE value.")
    manifest = _manifest(references)
    timeline = _validated_timeline(references, manifest)
    (
      ref_images,
      ref_videos,
      ref_video_audios,
      ref_audios,
      loader_audio_ids,
      h3_audio_ids,
    ) = _reference_inputs(references)
    h3_prompt = _remap_audio_tags(prompt, loader_audio_ids, h3_audio_ids)
    entries: list[tuple[str, int, Any, Any, int, int]] = []
    add_guide: type[io.ComfyNode] | None = None
    if timeline.enabled:
      entries = _timeline_entries(references, timeline)
      if entries:
        if any(image is not None for _, _, image, _, _, _ in entries) and vae is None:
          raise ValueError("H3 Timeline visual guides require the video VAE input.")
        if (
          any(audio is not None for _, _, _, audio, _, _ in entries)
          and audio_vae is None
        ):
          raise ValueError("H3 Timeline audio guides require the audio VAE input.")
        add_guide = _minimax_h3_add_guide_node()
    native_output = _minimax_h3_node().execute(
      clip=clip,
      vae=vae,
      audio_vae=audio_vae,
      prompt=h3_prompt,
      width=width,
      height=height,
      length=length,
      ref_image_size=ref_image_size,
      ref_images=ref_images,
      ref_videos=ref_videos,
      ref_video_audios=ref_video_audios,
      ref_audios=ref_audios,
    )
    if not timeline.enabled:
      return native_output

    if not entries:
      return native_output

    values = _node_output_values(native_output)
    if len(values) < 2:
      raise RuntimeError(
        "MiniMax H3 Reference to Video must return conditioning and an AV latent."
      )
    positive, latent = values[0], values[1]
    frame_count = _latent_frame_count(latent, length)
    _validate_timeline_ranges(entries, frame_count)
    if add_guide is None:
      raise RuntimeError("MiniMax H3 Add Guide is unavailable.")
    for _label, frame_index, image, audio, _visual_length, _audio_length in entries:
      added = add_guide.execute(
        positive=positive,
        latent=latent,
        frame_idx=frame_index,
        vae=vae,
        audio_vae=audio_vae,
        image=image,
        audio=audio,
      )
      added_values = _node_output_values(added)
      if not added_values:
        raise RuntimeError("MiniMax H3 Add Guide returned no conditioning output.")
      positive = added_values[0]
    return io.NodeOutput(positive, latent)


__all__ = ["MiniMaxH3ReferenceToVideoWrapperNode"]
