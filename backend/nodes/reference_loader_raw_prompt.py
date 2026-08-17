from __future__ import annotations

import hashlib

from comfy_api.latest import io

from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)


class ReferenceLoaderRawPromptNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoaderRawPrompt",
      display_name="[Reference Loader] Raw Prompt",
      category="reference/output",
      description=(
        "Extracts the compiled raw prompt stored in a Reference Loader bundle."
      ),
      search_aliases=[
        "reference loader raw prompt",
        "reference prompt output",
        "extract reference prompt",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input(
          "references",
          tooltip="Reference bundle emitted by Reference Loader.",
        ),
      ],
      outputs=[
        io.String.Output(
          "raw_prompt",
          tooltip="Compiled prompt with resolved media tags.",
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(cls, references: ReferenceLoaderBundle) -> str:
    validate_reference_loader_bundle(references)
    return hashlib.sha256(references.compiled_prompt.encode("utf-8")).hexdigest()

  @classmethod
  def execute(cls, references: ReferenceLoaderBundle) -> io.NodeOutput:
    validate_reference_loader_bundle(references)
    return io.NodeOutput(references.compiled_prompt)


__all__ = ["ReferenceLoaderRawPromptNode"]
