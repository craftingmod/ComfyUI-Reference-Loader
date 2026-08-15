from typing import override

from comfy_api.latest import ComfyExtension, io

from .nodes import ReferenceLoaderNode
from .reference_routes import register_reference_routes


class ReferenceLoaderExtension(ComfyExtension):
  @override
  async def get_node_list(self) -> list[type[io.ComfyNode]]:
    return [ReferenceLoaderNode]


async def comfy_entrypoint() -> ReferenceLoaderExtension:
  register_reference_routes()
  return ReferenceLoaderExtension()


__all__ = ["ReferenceLoaderExtension", "ReferenceLoaderNode", "comfy_entrypoint"]
