import asyncio
from pathlib import Path

from conftest import load_package_from_path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT_PATH = REPO_ROOT / "__init__.py"


def test_python_lane_loads_reference_loader_via_entrypoint():
  module = load_package_from_path(
    "reference_loader_entrypoint_compat",
    ENTRYPOINT_PATH,
    repo_root=REPO_ROOT,
  )
  extension = asyncio.run(module.comfy_entrypoint())
  node_classes = asyncio.run(extension.get_node_list())

  assert [node.define_schema().node_id for node in node_classes] == [
    "Alyac_ReferenceLoader",
    "Alyac_ReferenceLoaderOptionsOverride",
    "Alyac_ReferenceLoaderExportPromptForLLM",
    "Alyac_ReferenceLoaderRawOutputs",
    "Alyac_ReferenceLoaderRawPrompt",
    "Alyac_ReferenceLoaderStartEndFrames",
    "Alyac_MiniMaxH3ReferenceToVideoWrapper",
  ]
  assert module.WEB_DIRECTORY == "./dist"
  assert module.__all__ == [
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
