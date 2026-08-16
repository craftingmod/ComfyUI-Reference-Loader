from .backend import (
  MiniMaxH3ReferenceToVideoWrapperNode,
  ReferenceLoaderExportPromptForLLMNode,
  ReferenceLoaderExtension,
  ReferenceLoaderNode,
  ReferenceLoaderOptionsOverrideNode,
  ReferenceLoaderRawOutputsNode,
  ReferenceLoaderRawPromptNode,
  ReferenceLoaderStartEndFramesNode,
)

WEB_DIRECTORY = "./dist"


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  from .backend import comfy_entrypoint as load_extension

  return await load_extension()


__all__ = [
  "WEB_DIRECTORY",
  "MiniMaxH3ReferenceToVideoWrapperNode",
  "ReferenceLoaderExportPromptForLLMNode",
  "ReferenceLoaderExtension",
  "ReferenceLoaderNode",
  "ReferenceLoaderOptionsOverrideNode",
  "ReferenceLoaderRawOutputsNode",
  "ReferenceLoaderRawPromptNode",
  "ReferenceLoaderStartEndFramesNode",
  "comfy_entrypoint",
]
