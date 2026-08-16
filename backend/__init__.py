from typing import override

from comfy_api.latest import ComfyExtension, io

from .nodes import (
  MiniMaxH3ReferenceToVideoWrapperNode,
  ReferenceLoaderExportPromptForLLMNode,
  ReferenceLoaderNode,
  ReferenceLoaderOptionsOverrideNode,
  ReferenceLoaderRawOutputsNode,
  ReferenceLoaderStartEndFramesNode,
)
from .reference_routes import register_reference_routes


class ReferenceLoaderExtension(ComfyExtension):
  @override
  async def get_node_list(self) -> list[type[io.ComfyNode]]:
    return [
      ReferenceLoaderNode,
      ReferenceLoaderOptionsOverrideNode,
      ReferenceLoaderExportPromptForLLMNode,
      ReferenceLoaderRawOutputsNode,
      ReferenceLoaderStartEndFramesNode,
      MiniMaxH3ReferenceToVideoWrapperNode,
    ]


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  register_reference_routes()
  return ReferenceLoaderExtension()


__all__ = [
  "MiniMaxH3ReferenceToVideoWrapperNode",
  "ReferenceLoaderExportPromptForLLMNode",
  "ReferenceLoaderExtension",
  "ReferenceLoaderNode",
  "ReferenceLoaderOptionsOverrideNode",
  "ReferenceLoaderRawOutputsNode",
  "ReferenceLoaderStartEndFramesNode",
  "comfy_entrypoint",
]
