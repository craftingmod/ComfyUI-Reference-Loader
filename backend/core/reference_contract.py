from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from types import MappingProxyType
from typing import Any, Literal

REFERENCE_STATE_VERSION = 1
VIDEO_AUDIO_POLICY = "preserve"
H3_TIMELINE_VERSION = 1
MAX_H3_GUIDES = 32

MAX_STATE_CHARACTERS = 1_000_000
MAX_IMAGES = 32
MAX_AUDIO_ITEMS = 8
MAX_VIDEO_ITEMS = 4
MAX_CAPTION_CHARACTERS = 16_384
MIN_OUTPUT_IMAGE_PIXELS = 250_000
MAX_OUTPUT_IMAGE_PIXELS = 40_000_000

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MIME_RE = re.compile(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_COLOR_WITH_OPTIONAL_ALPHA_RE = re.compile(r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")

MediaKind = Literal["image", "audio", "video"]


class ReferenceContractError(ValueError):
  """Raised when serialized Reference Loader state violates its contract."""


@dataclass(frozen=True, slots=True)
class H3GuideEntry:
  id: str
  frame_index: int
  visual_id: str | None
  audio_id: str | None

  def state_projection(self) -> dict[str, Any]:
    return {
      "id": self.id,
      "frameIndex": self.frame_index,
      "visualId": self.visual_id,
      "audioId": self.audio_id,
    }

  def manifest_projection(self) -> dict[str, Any]:
    return {
      "id": self.id,
      "frame_index": self.frame_index,
      "visual_id": self.visual_id,
      "audio_id": self.audio_id,
    }


@dataclass(frozen=True, slots=True)
class H3Timeline:
  version: int
  enabled: bool
  start_image_id: str | None
  end_image_id: str | None
  guides: tuple[H3GuideEntry, ...]

  @classmethod
  def empty(cls) -> H3Timeline:
    return cls(H3_TIMELINE_VERSION, False, None, None, ())

  def state_projection(self) -> dict[str, Any]:
    return {
      "version": self.version,
      "enabled": self.enabled,
      "startImageId": self.start_image_id,
      "endImageId": self.end_image_id,
      "guides": [guide.state_projection() for guide in self.guides],
    }

  def manifest_projection(self) -> dict[str, Any]:
    return {
      "version": self.version,
      "enabled": self.enabled,
      "start_image_id": self.start_image_id,
      "end_image_id": self.end_image_id,
      "guides": [guide.manifest_projection() for guide in self.guides],
    }


@dataclass(frozen=True, slots=True)
class ReferenceSource:
  path: str
  mime: str
  sha256: str
  size: int | None = None

  def projection(self) -> dict[str, Any]:
    value: dict[str, Any] = {
      "path": self.path,
      "mime": self.mime,
      "sha256": self.sha256,
    }
    if self.size is not None:
      value["size"] = self.size
    return value


@dataclass(frozen=True, slots=True)
class TimeRange:
  start: float
  end: float

  def projection(self) -> dict[str, float]:
    return {"start": self.start, "end": self.end}


@dataclass(frozen=True, slots=True)
class NormalizedCrop:
  x: float
  y: float
  width: float
  height: float

  def projection(self) -> dict[str, float]:
    return {
      "x": self.x,
      "y": self.y,
      "width": self.width,
      "height": self.height,
    }


@dataclass(frozen=True, slots=True)
class ImageEdit:
  crop: NormalizedCrop | None = None
  flip_x: bool = False
  flip_y: bool = False
  remove_background: bool = False
  background_mode: Literal["transparent", "solid"] | None = None
  background_color: str | None = None
  mask: ReferenceSource | None = None
  mask_mode: Literal["keep", "erase"] | None = None
  revision: int | None = None

  def projection(self) -> dict[str, Any]:
    value: dict[str, Any] = {}
    if self.crop is not None:
      value["crop"] = self.crop.projection()
    if self.flip_x:
      value["flipX"] = True
    if self.flip_y:
      value["flipY"] = True
    if self.remove_background:
      value["removeBackground"] = True
    if self.background_mode is not None:
      value["background"] = {
        "mode": self.background_mode,
        "color": self.background_color,
      }
    if self.mask is not None:
      value["mask"] = self.mask.projection()
      value["maskMode"] = self.mask_mode or "keep"
    if self.revision is not None:
      value["revision"] = self.revision
    return value


@dataclass(frozen=True, slots=True)
class ReferenceItem:
  id: str
  kind: MediaKind
  source: ReferenceSource
  caption: str
  image_enabled: bool | None = None
  video_enabled: bool | None = None
  video_audio_enabled: bool | None = None
  audio_enabled: bool | None = None
  audio_caption_override: str | None = None
  crop: TimeRange | None = None
  edit: ImageEdit | None = None


@dataclass(frozen=True, slots=True)
class ImageOutputSettings:
  limit_pixels: bool
  max_pixels: int
  composite_alpha: bool
  alpha_background: str

  def projection(self) -> dict[str, Any]:
    value: dict[str, Any] = {
      "mode": "limited" if self.limit_pixels else "original",
      "alphaMode": "opaque" if self.composite_alpha else "preserve",
    }
    if self.limit_pixels:
      value["maxPixels"] = self.max_pixels
    if self.composite_alpha:
      value["alphaBackground"] = self.alpha_background
    return value


@dataclass(frozen=True, slots=True)
class ReferenceState:
  version: int
  items: Mapping[str, ReferenceItem]
  image_order: tuple[str, ...]
  video_order: tuple[str, ...]
  audio_order: tuple[str, ...]
  video_audio_policy: Literal["preserve"]
  h3_timeline: H3Timeline = field(default_factory=H3Timeline.empty)


def _error(path: str, message: str) -> ReferenceContractError:
  return ReferenceContractError(f"{path}: {message}")


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  return value


def _string(value: Any, path: str, *, maximum: int | None = None) -> str:
  if not isinstance(value, str):
    raise _error(path, "must be a string")
  if maximum is not None and len(value) > maximum:
    raise _error(path, f"must contain at most {maximum} characters")
  return value


def _boolean(value: Any, path: str) -> bool:
  if not isinstance(value, bool):
    raise _error(path, "must be a boolean")
  return value


def _finite_number(value: Any, path: str) -> float:
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    raise _error(path, "must be a finite number")
  result = float(value)
  if not math.isfinite(result):
    raise _error(path, "must be a finite number")
  return result


def image_output_settings(
  limit_image_pixels: bool,
  max_image_pixels: float,
  composite_alpha: bool,
  alpha_background: str,
) -> ImageOutputSettings:
  limit_pixels = _boolean(limit_image_pixels, "limit_image_pixels")
  max_megapixels = _finite_number(max_image_pixels, "max_image_pixels")
  max_pixels = round(max_megapixels * 1_000_000)
  if not MIN_OUTPUT_IMAGE_PIXELS <= max_pixels <= MAX_OUTPUT_IMAGE_PIXELS:
    raise _error(
      "max_image_pixels",
      "must be between 0.25 and 40 megapixels",
    )
  composite = _boolean(composite_alpha, "composite_alpha")
  background = _string(alpha_background, "alpha_background").lower()
  if not _COLOR_WITH_OPTIONAL_ALPHA_RE.fullmatch(background):
    raise _error("alpha_background", "must be a #RRGGBB or #RRGGBBAA color")
  background = background[:7]
  return ImageOutputSettings(
    limit_pixels=limit_pixels,
    max_pixels=max_pixels,
    composite_alpha=composite,
    alpha_background=background,
  )


def _source(value: Any, path: str, kind: MediaKind) -> ReferenceSource:
  source = _mapping(value, path)
  raw_path = _string(source.get("path"), f"{path}.path", maximum=512)
  if not raw_path or "\\" in raw_path or "\x00" in raw_path:
    raise _error(f"{path}.path", "must be a non-empty POSIX relative path")
  pure = PurePosixPath(raw_path)
  if (
    pure.is_absolute()
    or not pure.parts
    or any(part in {"", ".", ".."} or ":" in part for part in pure.parts)
  ):
    raise _error(f"{path}.path", "must stay relative to the ComfyUI input directory")
  if pure.parts[0].lower() == "input":
    raise _error(f"{path}.path", "must not include an input/ prefix")

  mime = _string(source.get("mime"), f"{path}.mime", maximum=100).lower()
  if not _MIME_RE.fullmatch(mime) or not mime.startswith(f"{kind}/"):
    raise _error(f"{path}.mime", f"must be a valid {kind} MIME type")
  sha256 = _string(source.get("sha256"), f"{path}.sha256").lower()
  if not _SHA256_RE.fullmatch(sha256):
    raise _error(f"{path}.sha256", "must be 64 lowercase hexadecimal characters")

  raw_size = source.get("size")
  size: int | None = None
  if raw_size is not None:
    if isinstance(raw_size, bool) or not isinstance(raw_size, int) or raw_size < 0:
      raise _error(f"{path}.size", "must be a non-negative integer")
    size = raw_size
  return ReferenceSource(path=pure.as_posix(), mime=mime, sha256=sha256, size=size)


def _time_range(value: Any, path: str) -> TimeRange:
  crop = _mapping(value, path)
  start = _finite_number(crop.get("start"), f"{path}.start")
  end = _finite_number(crop.get("end"), f"{path}.end")
  if start < 0 or end <= start:
    raise _error(path, "must satisfy 0 <= start < end")
  return TimeRange(start=start, end=end)


def _normalized_crop(value: Any, path: str) -> NormalizedCrop:
  crop = _mapping(value, path)
  x = _finite_number(crop.get("x"), f"{path}.x")
  y = _finite_number(crop.get("y"), f"{path}.y")
  width = _finite_number(crop.get("width"), f"{path}.width")
  height = _finite_number(crop.get("height"), f"{path}.height")
  epsilon = 1e-9
  if (
    x < 0
    or y < 0
    or width <= 0
    or height <= 0
    or x + width > 1.0 + epsilon
    or y + height > 1.0 + epsilon
  ):
    raise _error(path, "must be a non-empty normalized rectangle inside the source")
  return NormalizedCrop(x=x, y=y, width=width, height=height)


def _image_edit(value: Any, path: str) -> ImageEdit:
  edit = _mapping(value, path)
  crop = _normalized_crop(edit["crop"], f"{path}.crop") if "crop" in edit else None
  flip_x = _boolean(edit.get("flipX", False), f"{path}.flipX")
  flip_y = _boolean(edit.get("flipY", False), f"{path}.flipY")
  remove_background = _boolean(
    edit.get("removeBackground", False), f"{path}.removeBackground"
  )

  background_mode: Literal["transparent", "solid"] | None = None
  background_color: str | None = None
  if "background" in edit:
    background = _mapping(edit["background"], f"{path}.background")
    mode = background.get("mode")
    if mode not in {"transparent", "solid"}:
      raise _error(f"{path}.background.mode", "must be transparent or solid")
    color = _string(background.get("color"), f"{path}.background.color")
    if not _COLOR_RE.fullmatch(color):
      raise _error(f"{path}.background.color", "must be a #RRGGBB color")
    background_mode = mode
    background_color = color.lower()

  mask: ReferenceSource | None = None
  mask_mode: Literal["keep", "erase"] | None = None
  if "mask" in edit:
    mask = _source(edit["mask"], f"{path}.mask", "image")
    raw_mask_mode = edit.get("maskMode", "keep")
    if raw_mask_mode not in {"keep", "erase"}:
      raise _error(f"{path}.maskMode", "must be keep or erase")
    mask_mode = raw_mask_mode
  elif "maskMode" in edit:
    raise _error(f"{path}.maskMode", "requires an edit.mask source")

  revision: int | None = None
  if "revision" in edit:
    raw_revision = edit["revision"]
    if (
      isinstance(raw_revision, bool)
      or not isinstance(raw_revision, int)
      or raw_revision < 0
    ):
      raise _error(f"{path}.revision", "must be a non-negative integer")
    revision = raw_revision
  return ImageEdit(
    crop=crop,
    flip_x=flip_x,
    flip_y=flip_y,
    remove_background=remove_background,
    background_mode=background_mode,
    background_color=background_color,
    mask=mask,
    mask_mode=mask_mode,
    revision=revision,
  )


def _item(key: str, value: Any) -> ReferenceItem:
  path = f"state.items.{key}"
  item = _mapping(value, path)
  item_id = _string(item.get("id"), f"{path}.id")
  if item_id != key or not _ID_RE.fullmatch(item_id):
    raise _error(f"{path}.id", "must equal its map key and be a stable identifier")
  kind = item.get("kind")
  if kind not in {"image", "audio", "video"}:
    raise _error(f"{path}.kind", "must be image, audio, or video")
  caption = _string(
    item.get("caption"), f"{path}.caption", maximum=MAX_CAPTION_CHARACTERS
  )
  source = _source(item.get("source"), f"{path}.source", kind)

  if kind == "image":
    if (
      "videoEnabled" in item
      or "videoAudioEnabled" in item
      or "audioEnabled" in item
      or "crop" in item
      or "audioCaptionOverride" in item
    ):
      raise _error(path, "image items cannot contain audio or time-crop fields")
    return ReferenceItem(
      id=item_id,
      kind=kind,
      source=source,
      caption=caption,
      image_enabled=_boolean(item.get("imageEnabled"), f"{path}.imageEnabled"),
      edit=_image_edit(item["edit"], f"{path}.edit") if "edit" in item else None,
    )

  if "edit" in item:
    raise _error(path, "only image items can contain edit recipes")
  crop = _time_range(item["crop"], f"{path}.crop") if "crop" in item else None
  if kind == "audio":
    if (
      "imageEnabled" in item
      or "videoEnabled" in item
      or "videoAudioEnabled" in item
      or "audioCaptionOverride" in item
    ):
      raise _error(
        path, "audio items cannot contain image, video, or video-caption fields"
      )
    return ReferenceItem(
      id=item_id,
      kind=kind,
      source=source,
      caption=caption,
      audio_enabled=_boolean(item.get("audioEnabled"), f"{path}.audioEnabled"),
      crop=crop,
    )

  override = item.get("audioCaptionOverride")
  if override is not None:
    override = _string(
      override,
      f"{path}.audioCaptionOverride",
      maximum=MAX_CAPTION_CHARACTERS,
    )
  return ReferenceItem(
    id=item_id,
    kind=kind,
    source=source,
    caption=caption,
    video_enabled=_boolean(item.get("videoEnabled"), f"{path}.videoEnabled"),
    video_audio_enabled=_boolean(
      item.get("videoAudioEnabled", True), f"{path}.videoAudioEnabled"
    ),
    audio_enabled=_boolean(item.get("audioEnabled"), f"{path}.audioEnabled"),
    audio_caption_override=override,
    crop=crop,
  )


def _order(
  value: Any,
  path: str,
  *,
  expected: set[str],
) -> tuple[str, ...]:
  if not isinstance(value, list):
    raise _error(path, "must be an array")
  if any(not isinstance(item_id, str) for item_id in value):
    raise _error(path, "must contain only stable item IDs")
  order = tuple(value)
  if len(order) != len(set(order)):
    raise _error(path, "must not contain duplicate IDs")
  actual = set(order)
  if actual != expected:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    details = []
    if missing:
      details.append(f"missing {missing}")
    if extra:
      details.append(f"unexpected {extra}")
    raise _error(path, "; ".join(details))
  return order


def _timeline_media_id(
  value: Any,
  path: str,
  items: Mapping[str, ReferenceItem],
  *,
  allowed_kinds: set[MediaKind],
) -> str | None:
  if value is None:
    return None
  media_id = _string(value, path, maximum=128)
  item = items.get(media_id)
  if item is None or item.kind not in allowed_kinds:
    allowed = ", ".join(sorted(allowed_kinds))
    raise _error(path, f"must refer to an existing {allowed} item")
  return media_id


def _h3_timeline(value: Any, items: Mapping[str, ReferenceItem]) -> H3Timeline:
  if value is None:
    return H3Timeline.empty()
  timeline = _mapping(value, "state.h3Timeline")
  version = timeline.get("version")
  if isinstance(version, bool) or version != H3_TIMELINE_VERSION:
    raise _error(
      "state.h3Timeline.version",
      f"must equal {H3_TIMELINE_VERSION}",
    )
  enabled = _boolean(timeline.get("enabled"), "state.h3Timeline.enabled")

  start_image_id = _timeline_media_id(
    timeline.get("startImageId"),
    "state.h3Timeline.startImageId",
    items,
    allowed_kinds={"image"},
  )
  end_image_id = _timeline_media_id(
    timeline.get("endImageId"),
    "state.h3Timeline.endImageId",
    items,
    allowed_kinds={"image"},
  )

  raw_guides = timeline.get("guides")
  if not isinstance(raw_guides, list):
    raise _error("state.h3Timeline.guides", "must be an array")
  if len(raw_guides) > MAX_H3_GUIDES:
    raise _error(
      "state.h3Timeline.guides",
      f"must contain at most {MAX_H3_GUIDES} guides",
    )

  guides: list[H3GuideEntry] = []
  guide_ids: set[str] = set()
  for index, raw_guide in enumerate(raw_guides):
    path = f"state.h3Timeline.guides[{index}]"
    guide = _mapping(raw_guide, path)
    guide_id = _string(guide.get("id"), f"{path}.id", maximum=128)
    if not _ID_RE.fullmatch(guide_id):
      raise _error(f"{path}.id", "must be a stable identifier")
    if guide_id in guide_ids:
      raise _error(f"{path}.id", "must be unique")
    guide_ids.add(guide_id)

    raw_frame_index = guide.get("frameIndex")
    if (
      isinstance(raw_frame_index, bool)
      or not isinstance(raw_frame_index, int)
      or raw_frame_index < 0
    ):
      raise _error(
        f"{path}.frameIndex",
        "must be a non-negative integer",
      )
    visual_id = _timeline_media_id(
      guide.get("visualId"),
      f"{path}.visualId",
      items,
      allowed_kinds={"image"},
    )
    audio_id = _timeline_media_id(
      guide.get("audioId"),
      f"{path}.audioId",
      items,
      allowed_kinds={"audio"},
    )
    guides.append(
      H3GuideEntry(
        id=guide_id,
        frame_index=raw_frame_index,
        visual_id=visual_id,
        audio_id=audio_id,
      )
    )

  return H3Timeline(
    version=H3_TIMELINE_VERSION,
    enabled=enabled,
    start_image_id=start_image_id,
    end_image_id=end_image_id,
    guides=tuple(guides),
  )


def h3_timeline_media_ids(state: ReferenceState) -> tuple[str, ...]:
  """Return unique media IDs consumed by an enabled H3 timeline."""

  timeline = state.h3_timeline
  if not timeline.enabled:
    return ()
  values: list[str] = []
  for media_id in (timeline.start_image_id, timeline.end_image_id):
    if media_id is not None and media_id not in values:
      values.append(media_id)
  for guide in timeline.guides:
    for media_id in (guide.visual_id, guide.audio_id):
      if media_id is not None and media_id not in values:
        values.append(media_id)
  return tuple(values)


def parse_reference_state(value: str | Mapping[str, Any]) -> ReferenceState:
  """Parse and strictly validate version 1 persisted state."""

  if isinstance(value, str):
    if len(value) > MAX_STATE_CHARACTERS:
      raise _error("state", "serialized state exceeds the size limit")
    try:
      raw = json.loads(value)
    except (TypeError, ValueError) as exc:
      raise _error("state", "must be valid JSON") from exc
  else:
    raw = value
  state = _mapping(raw, "state")
  if state.get("version") != REFERENCE_STATE_VERSION:
    raise _error("state.version", f"must equal {REFERENCE_STATE_VERSION}")

  raw_items = _mapping(state.get("items"), "state.items")
  items: dict[str, ReferenceItem] = {}
  for key, raw_item in raw_items.items():
    if not isinstance(key, str):
      raise _error("state.items", "must use string item IDs")
    items[key] = _item(key, raw_item)

  image_count = sum(item.kind == "image" for item in items.values())
  audio_count = sum(item.kind == "audio" for item in items.values())
  video_count = sum(item.kind == "video" for item in items.values())
  if image_count > MAX_IMAGES:
    raise _error("state.items", f"image count exceeds {MAX_IMAGES}")
  if audio_count > MAX_AUDIO_ITEMS:
    raise _error("state.items", f"audio count exceeds {MAX_AUDIO_ITEMS}")
  if video_count > MAX_VIDEO_ITEMS:
    raise _error("state.items", f"video count exceeds {MAX_VIDEO_ITEMS}")

  image_ids = {item.id for item in items.values() if item.kind == "image"}
  video_ids = {item.id for item in items.values() if item.kind == "video"}
  audio_ids = {item.id for item in items.values() if item.kind in {"audio", "video"}}
  image_order = _order(state.get("imageOrder"), "state.imageOrder", expected=image_ids)
  video_order = _order(state.get("videoOrder"), "state.videoOrder", expected=video_ids)
  audio_order = _order(state.get("audioOrder"), "state.audioOrder", expected=audio_ids)
  if state.get("videoAudioPolicy") != VIDEO_AUDIO_POLICY:
    raise _error("state.videoAudioPolicy", f"must equal {VIDEO_AUDIO_POLICY!r}")

  h3_timeline = _h3_timeline(state.get("h3Timeline"), items)

  return ReferenceState(
    version=REFERENCE_STATE_VERSION,
    items=MappingProxyType(items),
    image_order=image_order,
    video_order=video_order,
    audio_order=audio_order,
    video_audio_policy=VIDEO_AUDIO_POLICY,
    h3_timeline=h3_timeline,
  )


def _execution_item(
  item: ReferenceItem,
  *,
  item_id: str | None = None,
  kind: MediaKind | None = None,
  enabled: bool,
  caption: str | None = None,
  derived_from: str | None = None,
) -> dict[str, Any]:
  value: dict[str, Any] = {
    "id": item_id or item.id,
    "kind": kind or item.kind,
    "source": item.source.projection(),
    "caption": item.caption if caption is None else caption,
    "enabled": enabled,
  }
  if item.crop is not None:
    value["crop"] = item.crop.projection()
  if item.edit is not None:
    value["edit"] = item.edit.projection()
  if derived_from is not None:
    value["derivedFrom"] = derived_from
  return value


def execution_projection(
  state: ReferenceState,
  *,
  image_output: ImageOutputSettings | None = None,
) -> dict[str, Any]:
  """Return the deterministic execution state, excluding all UI preferences."""

  images: list[dict[str, Any]] = []
  videos: list[dict[str, Any]] = []
  audios: list[dict[str, Any]] = []
  for item_id in state.image_order:
    item = state.items[item_id]
    images.append(_execution_item(item, enabled=bool(item.image_enabled)))
  for item_id in state.video_order:
    item = state.items[item_id]
    video = _execution_item(item, enabled=bool(item.video_enabled))
    video["videoAudioEnabled"] = bool(item.video_audio_enabled)
    videos.append(video)
  for item_id in state.audio_order:
    item = state.items[item_id]
    if item.kind == "audio":
      audios.append(_execution_item(item, enabled=bool(item.audio_enabled)))
    else:
      audios.append(
        _execution_item(
          item,
          item_id=f"{item.id}:audio",
          kind="audio",
          enabled=bool(item.audio_enabled),
          caption=(
            item.audio_caption_override
            if item.audio_caption_override is not None
            else item.caption
          ),
          derived_from=item.id,
        )
      )
  value = {
    "version": state.version,
    "imageOrder": list(state.image_order),
    "videoOrder": list(state.video_order),
    "audioOrder": list(state.audio_order),
    "videoAudioPolicy": state.video_audio_policy,
    "h3Timeline": state.h3_timeline.state_projection(),
    "images": images,
    "audios": audios,
    "videos": videos,
  }
  if image_output is not None:
    value["imageOutput"] = image_output.projection()
  return value


def execution_fingerprint(
  state: ReferenceState,
  *,
  image_output: ImageOutputSettings | None = None,
) -> str:
  payload = json.dumps(
    execution_projection(state, image_output=image_output),
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
  ).encode("utf-8")
  return hashlib.sha256(payload).hexdigest()


def reference_loader_fingerprint(
  manifest_json: str,
  prompt_state_json: str,
  compiled_prompt: str,
) -> str:
  """Fingerprint the complete execution-visible Reference Loader snapshot."""

  payload = json.dumps(
    {
      "manifest": json.loads(manifest_json),
      "prompt_state": json.loads(prompt_state_json),
      "compiled_prompt": compiled_prompt,
    },
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
  ).encode("utf-8")
  return hashlib.sha256(payload).hexdigest()


__all__ = [
  "H3_TIMELINE_VERSION",
  "MAX_H3_GUIDES",
  "MAX_OUTPUT_IMAGE_PIXELS",
  "MIN_OUTPUT_IMAGE_PIXELS",
  "REFERENCE_STATE_VERSION",
  "VIDEO_AUDIO_POLICY",
  "H3GuideEntry",
  "H3Timeline",
  "ImageEdit",
  "ImageOutputSettings",
  "NormalizedCrop",
  "ReferenceContractError",
  "ReferenceItem",
  "ReferenceSource",
  "ReferenceState",
  "TimeRange",
  "execution_fingerprint",
  "execution_projection",
  "h3_timeline_media_ids",
  "image_output_settings",
  "parse_reference_state",
  "reference_loader_fingerprint",
]
