from __future__ import annotations

import time

from comfy_api.latest import io

from .prompt_cache_common import invalidate_key_fingerprint
from .reference_bundle import (
  REFERENCE_LOADER_BUNDLE_TYPE,
  ReferenceLoaderBundle,
  validate_reference_loader_bundle,
)


def _cache_is_current(
  references: ReferenceLoaderBundle,
  cached_ref_hash: str,
  force_refresh: bool,
  invalidate_key: str | None,
  cached_invalidate_key: str,
) -> bool:
  return (
    not force_refresh
    and bool(references.reference_fingerprint)
    and cached_ref_hash == references.reference_fingerprint
    and (
      invalidate_key is None
      or cached_invalidate_key == invalidate_key_fingerprint(invalidate_key)
    )
  )


class ReferencePromptCacheNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferencePromptCache",
      display_name="[Reference Loader] Reference Prompt Cache",
      category="reference/prompt",
      description=(
        "Uses the cached prompt when the Reference Loader fingerprint and optional invalidate key are unchanged. "
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
          "invalidate_key",
          optional=True,
          force_input=True,
          tooltip=(
            "Optional string that invalidates the cached prompt when it changes."
          ),
        ),
        io.String.Input(
          "cached_ref_hash",
          default="",
          optional=True,
          socketless=True,
          advanced=True,
          extra_dict={"read_only": True, "disabled": True},
          tooltip="Workflow-persisted Reference Loader fingerprint for cached_prompt.",
        ),
        io.String.Input(
          "cached_invalidate_key",
          default="",
          optional=True,
          socketless=True,
          advanced=True,
          extra_dict={"read_only": True, "disabled": True},
          tooltip="Workflow-persisted SHA-256 fingerprint of invalidate_key.",
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
    cached_ref_hash: str = "",
    force_refresh: bool = False,
    invalidate_key: str | None = None,
    cached_invalidate_key: str = "",
  ) -> str:
    _ = live_prompt
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if force_refresh:
      return f"{references.reference_fingerprint}\0{time.time_ns()}"
    return f"{references.reference_fingerprint}\0{cached_ref_hash}\0{cached_prompt}\0{invalidate_key!r}"

  @classmethod
  def check_lazy_status(
    cls,
    references: ReferenceLoaderBundle,
    live_prompt: str | None = None,
    cached_prompt: str = "",
    cached_ref_hash: str = "",
    force_refresh: bool = False,
    invalidate_key: str | None = None,
    cached_invalidate_key: str = "",
  ) -> list[str]:
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if _cache_is_current(
      references,
      cached_ref_hash,
      force_refresh,
      invalidate_key,
      cached_invalidate_key,
    ):
      return []
    return [] if live_prompt is not None else ["live_prompt"]

  @classmethod
  def execute(
    cls,
    references: ReferenceLoaderBundle,
    live_prompt: str | None = None,
    cached_prompt: str = "",
    cached_ref_hash: str = "",
    force_refresh: bool = False,
    invalidate_key: str | None = None,
    cached_invalidate_key: str = "",
  ) -> io.NodeOutput:
    validate_reference_loader_bundle(references)
    if not references.reference_fingerprint:
      raise ValueError(
        "Reference Prompt Cache requires a Reference Loader bundle fingerprint."
      )
    if _cache_is_current(
      references,
      cached_ref_hash,
      force_refresh,
      invalidate_key,
      cached_invalidate_key,
    ):
      return io.NodeOutput(cached_prompt)
    if live_prompt is None:
      raise ValueError(
        "Reference Prompt Cache needs live_prompt when the cache is stale."
      )
    return io.NodeOutput(
      live_prompt,
      ui={
        "cached_prompt": [live_prompt],
        "cached_ref_hash": [references.reference_fingerprint],
        "cached_invalidate_key": [invalidate_key_fingerprint(invalidate_key)],
      },
    )


__all__ = ["ReferencePromptCacheNode"]
