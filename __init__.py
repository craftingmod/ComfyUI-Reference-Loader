from .backend import ReferenceLoaderExtension, ReferenceLoaderNode

WEB_DIRECTORY = "./dist"


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  from .backend import comfy_entrypoint as load_extension

  return await load_extension()


__all__ = [
  "WEB_DIRECTORY",
  "ReferenceLoaderExtension",
  "ReferenceLoaderNode",
  "comfy_entrypoint",
]
