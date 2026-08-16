from typing import override

from comfy_api.latest import ComfyExtension, io

from .nodes import (
  MiniMaxH3ReferenceToVideoWrapperNode,
  ReferenceLoaderNode,
  ReferenceLoaderOptionsOverrideNode,
  ReferenceLoaderRawOutputsNode,
)
from .reference_routes import register_reference_routes


class ReferenceLoaderExtension(ComfyExtension):
  @override
  async def get_node_list(self) -> list[type[io.ComfyNode]]:
    return [
      ReferenceLoaderNode,
      ReferenceLoaderOptionsOverrideNode,
      ReferenceLoaderRawOutputsNode,
      MiniMaxH3ReferenceToVideoWrapperNode,
    ]


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  register_reference_routes()
  return ReferenceLoaderExtension()


__all__ = [
  "MiniMaxH3ReferenceToVideoWrapperNode",
  "ReferenceLoaderExtension",
  "ReferenceLoaderNode",
  "ReferenceLoaderOptionsOverrideNode",
  "ReferenceLoaderRawOutputsNode",
  "comfy_entrypoint",
]
