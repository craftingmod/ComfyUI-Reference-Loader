import sys
import types
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT_INIT_PATH = Path(__file__).resolve().parent / "__init__.py"


def _install_comfy_api_test_stub() -> None:
  try:
    import comfy_api.latest  # noqa: F401

    return
  except ModuleNotFoundError:
    pass

  class ComfyNode:
    pass

  class ComfyExtension:
    pass

  class Field:
    def __init__(self, data_type: str, name: str | None = None, **options):
      self.data_type = data_type
      self.name = name
      self.id = name
      self.options = options

  def field_type(data_type: str):
    class FieldType:
      @classmethod
      def Input(cls, name: str, **options):
        return Field(data_type, name, **options)

      @classmethod
      def Output(cls, name: str | None = None, **options):
        return Field(data_type, name, **options)

    return FieldType

  class Schema:
    def __init__(self, **kwargs):
      for key, value in kwargs.items():
        setattr(self, key, value)

  class NodeOutput(tuple):
    def __new__(cls, *values):
      return super().__new__(cls, values)

    @property
    def values(self):
      return tuple(self)

  io_module = types.ModuleType("comfy_api.latest.io")
  io_module.ComfyNode = ComfyNode
  io_module.NodeOutput = NodeOutput
  io_module.Schema = Schema
  io_module.Custom = field_type
  for name in (
    "Audio",
    "Boolean",
    "Clip",
    "Color",
    "Combo",
    "Conditioning",
    "Float",
    "Image",
    "Int",
    "Latent",
    "Mask",
    "String",
    "Vae",
    "Video",
  ):
    setattr(io_module, name, field_type(name.lower()))

  latest_module = types.ModuleType("comfy_api.latest")
  latest_module.ComfyExtension = ComfyExtension
  latest_module.io = io_module

  comfy_api_module = types.ModuleType("comfy_api")
  comfy_api_module.latest = latest_module

  sys.modules["comfy_api"] = comfy_api_module
  sys.modules["comfy_api.latest"] = latest_module
  sys.modules["comfy_api.latest.io"] = io_module

  class MiniMaxH3ReferenceToVideo:
    @classmethod
    def define_schema(cls):
      return Schema(
        inputs=[
          io_module.Clip.Input("clip"),
          io_module.Vae.Input("vae"),
          io_module.Vae.Input("audio_vae"),
          io_module.String.Input("prompt"),
          io_module.Int.Input("width"),
          io_module.Int.Input("height"),
          io_module.Int.Input("length"),
          io_module.Combo.Input("ref_image_size"),
        ],
        outputs=[
          io_module.Conditioning.Output("positive"),
          io_module.Latent.Output("LATENT"),
        ],
      )

  comfy_extras_module = types.ModuleType("comfy_extras")
  minimax_module = types.ModuleType("comfy_extras.nodes_minimax_h3")
  minimax_module.MiniMaxH3ReferenceToVideo = MiniMaxH3ReferenceToVideo
  comfy_extras_module.nodes_minimax_h3 = minimax_module
  sys.modules["comfy_extras"] = comfy_extras_module
  sys.modules["comfy_extras.nodes_minimax_h3"] = minimax_module

  class Routes:
    def __init__(self):
      self.handlers = {}

    def post(self, path):
      return lambda handler: (
        self.handlers.setdefault(("POST", path), handler) or handler
      )

    def get(self, path):
      return lambda handler: self.handlers.setdefault(("GET", path), handler) or handler

  server_module = types.ModuleType("server")
  server_module.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(routes=Routes())
  )
  sys.modules["server"] = server_module


def _preload_root_entrypoint_for_pytest() -> None:
  # Keep pytest collection on the supported package-style loading path.
  spec = spec_from_file_location(
    "__init__",
    ROOT_INIT_PATH,
    submodule_search_locations=[str(ROOT_INIT_PATH.parent)],
  )
  assert spec is not None
  assert spec.loader is not None

  module = module_from_spec(spec)
  sys.modules["__init__"] = module
  spec.loader.exec_module(module)


_install_comfy_api_test_stub()
_preload_root_entrypoint_for_pytest()
