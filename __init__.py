from .backend import (
  LoadReferenceImageNode,
  MiniMaxH3ReferenceToVideoWrapperNode,
  ReferenceLoaderExportPromptForLLMNode,
  ReferenceLoaderExtension,
  ReferenceLoaderLLMDescriptionInputsNode,
  ReferenceLoaderNode,
  ReferenceLoaderOptionsOverrideNode,
  ReferenceLoaderRawOutputsNode,
  ReferenceLoaderRawPromptNode,
  ReferenceLoaderStartEndFramesNode,
  ReferencePromptCacheNode,
)

WEB_DIRECTORY = "./dist"


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  from .backend import comfy_entrypoint as load_extension

  return await load_extension()


__all__ = [
  "WEB_DIRECTORY",
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
  "ReferencePromptCacheNode",
  "comfy_entrypoint",
]
