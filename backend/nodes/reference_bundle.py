from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from comfy_api.latest import io

REFERENCE_LOADER_BUNDLE_TYPE = io.Custom("REFERENCE_LOADER_BUNDLE")


@dataclass(frozen=True, slots=True, eq=False)
class ReferenceLoaderBundle:
  images: tuple[Any, ...]
  image_captions: tuple[str, ...]
  audios: tuple[Any, ...]
  audio_captions: tuple[str, ...]
  videos: tuple[Any, ...]
  video_captions: tuple[str, ...]
  manifest_json: str


__all__ = ["REFERENCE_LOADER_BUNDLE_TYPE", "ReferenceLoaderBundle"]
