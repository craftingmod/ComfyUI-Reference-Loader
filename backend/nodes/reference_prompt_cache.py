from __future__ import annotations

import time

from comfy_api.latest import io

from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)


def _cache_is_current(
  references: ReferenceLoaderBundle,
  cached_hash: str,
  force_refresh: bool,
) -> bool:
  return (
    not force_refresh
    and bool(references.reference_fingerprint)
    and cached_hash == references.reference_fingerprint
  )


class ReferencePromptCacheNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferencePromptCache",
      display_name="[Reference Loader] Reference Prompt Cache",
      category="reference/prompt",
      description=(
        "Uses the cached prompt when the Reference Loader fingerprint is unchanged. "
        "The live prompt input is evaluated only on a cache miss or forced refresh."
      ),
      search_aliases=[
        "reference prompt cache",
        "cache refined prompt",
        "prompt cache",
      ],
      inputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Input("references"),
        io.String.Input(
          "cached_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          advanced=True,
          tooltip=(
            "Editable workflow-persisted prompt. It is used while the cached fingerprint is current."
          ),
        ),
        io.Boolean.Input(
          "force_refresh",
          default=False,
          label_on="Refresh",
          label_off="Use cache",
          socketless=True,
          tooltip="Evaluate live_prompt even when the cached fingerprint matches.",
        ),
        io.String.Input(
          "live_prompt",
          optional=True,
          lazy=True,
          multiline=True,
          dynamic_prompts=False,
          tooltip="Prompt produced by the LLM. It is skipped while the cache is current.",
        ),
        io.String.Input(
          "cached_hash",
          default="",
          optional=True,
          socketless=True,
          advanced=True,
          extra_dict={"read_only": True, "disabled": True},
          tooltip="Workflow-persisted Reference Loader fingerprint for cached_prompt.",
        ),
      ],
      outputs=[
        io.String.Output(
          "prompt",
          tooltip="Cached prompt or the freshly evaluated live prompt.",
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    references: ReferenceLoaderBundle,
    live_prompt: str | None = None,
    cached_prompt: str = "",
    cached_hash: str = "",
    force_refresh: bool = False,
  ) -> str:
    _ = live_prompt
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if force_refresh:
      return f"{references.reference_fingerprint}\0{time.time_ns()}"
    return f"{references.reference_fingerprint}\0{cached_hash}\0{cached_prompt}"

  @classmethod
  def check_lazy_status(
    cls,
    references: ReferenceLoaderBundle,
    live_prompt: str | None = None,
    cached_prompt: str = "",
    cached_hash: str = "",
    force_refresh: bool = False,
  ) -> list[str]:
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if _cache_is_current(references, cached_hash, force_refresh):
      return []
    return [] if live_prompt is not None else ["live_prompt"]

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    live_prompt: str | None = None,
    cached_prompt: str = "",
    cached_hash: str = "",
    force_refresh: bool = False,
  ) -> io.NodeOutput:
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if _cache_is_current(references, cached_hash, force_refresh):
      return io.NodeOutput(cached_prompt)
    if live_prompt is None:
      raise ValueError(
        "Reference Prompt Cache needs live_prompt when the cache is stale."
      )
    return io.NodeOutput(
      live_prompt,
      ui={
        "cached_prompt": [live_prompt],
        "cached_hash": [references.reference_fingerprint],
      },
    )


__all__ = ["ReferencePromptCacheNode"]
