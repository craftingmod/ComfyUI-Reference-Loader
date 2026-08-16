from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .reference_contract import (
  ImageOutputSettings,
  ReferenceContractError,
  ReferenceItem,
  ReferenceState,
  execution_projection,
  parse_reference_state,
)

MAX_MANIFEST_CHARACTERS = 1_000_000


@dataclass(frozen=True, slots=True)
class ReferenceOutputPlan:
  image_ids: tuple[str, ...]
  image_captions: tuple[str, ...]
  audio_ids: tuple[str, ...]
  audio_captions: tuple[str, ...]
  video_ids: tuple[str, ...]
  video_captions: tuple[str, ...]


def build_reference_output_plan(state: ReferenceState) -> ReferenceOutputPlan:
  projection = execution_projection(state)

  def active(name: str) -> list[dict[str, Any]]:
    return [entry for entry in projection[name] if entry["enabled"]]

  images = active("images")
  audios = active("audios")
  videos = active("videos")
  return ReferenceOutputPlan(
    image_ids=tuple(entry["id"] for entry in images),
    image_captions=tuple(entry["caption"] for entry in images),
    audio_ids=tuple(entry["id"] for entry in audios),
    audio_captions=tuple(entry["caption"] for entry in audios),
    video_ids=tuple(entry["id"] for entry in videos),
    video_captions=tuple(entry["caption"] for entry in videos),
  )


def _original_item_manifest(item: ReferenceItem) -> dict[str, Any]:
  value: dict[str, Any] = {
    "kind": item.kind,
    "source": item.source.projection(),
    "caption": {"text": item.caption, "source": "user"},
    "enabled": {},
  }
  if item.image_enabled is not None:
    value["enabled"]["image"] = item.image_enabled
  if item.video_enabled is not None:
    value["enabled"]["video"] = item.video_enabled
  if item.audio_enabled is not None:
    value["enabled"]["audio"] = item.audio_enabled
  if item.crop is not None:
    value["crop"] = item.crop.projection()
  if item.edit is not None:
    value["edit"] = item.edit.projection()
  if item.audio_caption_override is not None:
    value["audio_caption_override"] = item.audio_caption_override
  return value


def _derived_audio_manifest(item: ReferenceItem) -> dict[str, Any]:
  caption = (
    item.audio_caption_override
    if item.audio_caption_override is not None
    else item.caption
  )
  value: dict[str, Any] = {
    "kind": "audio",
    "source": item.source.projection(),
    "caption": {"text": caption, "source": "user"},
    "enabled": {"audio": item.audio_enabled},
    "derived_from": item.id,
    "derivation": "embedded_audio",
  }
  if item.crop is not None:
    value["crop"] = item.crop.projection()
  return value


def build_reference_manifest(
  state: ReferenceState,
  *,
  image_output: ImageOutputSettings | None = None,
) -> dict[str, Any]:
  """Build a payload-free manifest for both active and disabled references."""

  plan = build_reference_output_plan(state)
  items: dict[str, Any] = {}
  for item_id in sorted(state.items):
    item = state.items[item_id]
    items[item_id] = _original_item_manifest(item)
    if item.kind == "video":
      items[f"{item_id}:audio"] = _derived_audio_manifest(item)

  return {
    "version": state.version,
    "video_audio_policy": state.video_audio_policy,
    "image_output": (
      image_output or ImageOutputSettings(False, 2_000_000, False, "#000000")
    ).projection(),
    "image_order": list(state.image_order),
    "video_order": list(state.video_order),
    # audio_order deliberately stores original item IDs, including videos.
    "audio_order": list(state.audio_order),
    "outputs": {
      "images": list(plan.image_ids),
      "audios": list(plan.audio_ids),
      "videos": list(plan.video_ids),
    },
    "output_captions": {
      "images": list(plan.image_captions),
      "audios": list(plan.audio_captions),
      "videos": list(plan.video_captions),
    },
    "items": items,
  }


def parse_reference_manifest_state(value: str | Mapping[str, Any]) -> ReferenceState:
  """Reconstruct validated Reference Loader state from an emitted manifest."""

  if isinstance(value, str):
    if len(value) > MAX_MANIFEST_CHARACTERS:
      raise ReferenceContractError(
        "manifest: serialized manifest exceeds the size limit"
      )
    try:
      raw = json.loads(value)
    except (TypeError, ValueError) as exc:
      raise ReferenceContractError("manifest: must be valid JSON") from exc
  else:
    raw = value
  if not isinstance(raw, Mapping):
    raise ReferenceContractError("manifest: must contain an object")

  raw_items = raw.get("items")
  if not isinstance(raw_items, Mapping):
    raise ReferenceContractError("manifest.items: must contain an object")

  state_items: dict[str, Any] = {}
  original_ids: set[str] = set()
  for order_name in ("image_order", "video_order", "audio_order"):
    order = raw.get(order_name)
    if not isinstance(order, list) or any(
      not isinstance(item_id, str) for item_id in order
    ):
      raise ReferenceContractError(
        f"manifest.{order_name}: must contain an array of item IDs"
      )
    original_ids.update(order)

  for item_id in original_ids:
    manifest_item = raw_items.get(item_id)
    if not isinstance(manifest_item, Mapping):
      raise ReferenceContractError(
        f"manifest.items.{item_id}: must contain an original reference object"
      )
    caption = manifest_item.get("caption")
    enabled = manifest_item.get("enabled")
    if not isinstance(caption, Mapping):
      raise ReferenceContractError(
        f"manifest.items.{item_id}.caption: must contain an object"
      )
    if not isinstance(enabled, Mapping):
      raise ReferenceContractError(
        f"manifest.items.{item_id}.enabled: must contain an object"
      )

    kind = manifest_item.get("kind")
    item: dict[str, Any] = {
      "id": item_id,
      "kind": kind,
      "source": manifest_item.get("source"),
      "caption": caption.get("text"),
    }
    if kind == "image":
      item["imageEnabled"] = enabled.get("image")
    elif kind == "audio":
      item["audioEnabled"] = enabled.get("audio")
    elif kind == "video":
      item["videoEnabled"] = enabled.get("video")
      item["audioEnabled"] = enabled.get("audio")
    if "crop" in manifest_item:
      item["crop"] = manifest_item["crop"]
    if "edit" in manifest_item:
      item["edit"] = manifest_item["edit"]
    if "audio_caption_override" in manifest_item:
      item["audioCaptionOverride"] = manifest_item["audio_caption_override"]
    state_items[item_id] = item

  return parse_reference_state(
    {
      "version": raw.get("version"),
      "items": state_items,
      "imageOrder": raw.get("image_order"),
      "videoOrder": raw.get("video_order"),
      "audioOrder": raw.get("audio_order"),
      "videoAudioPolicy": raw.get("video_audio_policy"),
    }
  )


__all__ = [
  "MAX_MANIFEST_CHARACTERS",
  "ReferenceOutputPlan",
  "build_reference_manifest",
  "build_reference_output_plan",
  "parse_reference_manifest_state",
]
