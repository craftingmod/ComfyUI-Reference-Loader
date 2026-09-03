from typing import override

from comfy_api.latest import ComfyExtension, io

from .nodes import (
  LoadReferenceImageNode,
  MiniMaxH3ReferenceToVideoWrapperNode,
  ReferenceLoaderExportPromptForLLMNode,
  ReferenceLoaderLLMDescriptionInputsNode,
  ReferenceLoaderNode,
  ReferenceLoaderOptionsOverrideNode,
  ReferenceLoaderRawOutputsNode,
  ReferenceLoaderRawPromptNode,
  ReferenceLoaderStartEndFramesNode,
)
from .reference_routes import register_reference_routes


class ReferenceLoaderExtension(ComfyExtension):
  @override
  async def get_node_list(self) -> list[type[io.ComfyNode]]:
    return [
      ReferenceLoaderNode,
      LoadReferenceImageNode,
      ReferenceLoaderOptionsOverrideNode,
      ReferenceLoaderExportPromptForLLMNode,
      ReferenceLoaderLLMDescriptionInputsNode,
      ReferenceLoaderRawOutputsNode,
      ReferenceLoaderRawPromptNode,
      ReferenceLoaderStartEndFramesNode,
      MiniMaxH3ReferenceToVideoWrapperNode,
    ]


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  register_reference_routes()
  return ReferenceLoaderExtension()


__all__ = [
  "LoadReferenceImageNode",
  "MiniMaxH3ReferenceToVideoWrapperNode",
  "ReferenceLoaderExportPromptForLLMNode",
  "ReferenceLoaderExtension",
  "ReferenceLoaderLLMDescriptionInputsNode",
  "ReferenceLoaderNode",
  "ReferenceLoaderOptionsOverrideNode",
  "ReferenceLoaderRawOutputsNode",
  "ReferenceLoaderRawPromptNode",
  "ReferenceLoaderStartEndFramesNode",
  "comfy_entrypoint",
]
