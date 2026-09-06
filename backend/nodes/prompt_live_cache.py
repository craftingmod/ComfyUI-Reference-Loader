from __future__ import annotations

import time

from comfy_api.latest import io

from .prompt_cache_common import invalidate_key_fingerprint


def _validate_invalidate_key(invalidate_key: str) -> None:
  if not isinstance(invalidate_key, str) or not invalidate_key:
    raise ValueError("Prompt Live Cache requires a non-empty invalidate_key.")


def _cache_is_current(
  invalidate_key: str,
  cached_invalidate_key: str,
  force_refresh: bool,
) -> bool:
  return not force_refresh and cached_invalidate_key == invalidate_key_fingerprint(
    invalidate_key
  )


class PromptLiveCacheNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_PromptLiveCache",
      display_name="Prompt Live Cache",
      category="reference/util",
      description=(
        "Uses cached_prompt while the required invalidate_key is unchanged. "
        "The live prompt input is evaluated only on a cache miss or forced refresh."
      ),
      search_aliases=[
        "prompt live cache",
        "generic prompt cache",
        "string prompt cache",
      ],
      inputs=[
        io.String.Input(
          "invalidate_key",
          force_input=True,
          tooltip=(
            "Required complete cache identity. Any change evaluates live_prompt again."
          ),
        ),
        io.String.Input(
          "cached_prompt",
          default="",
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          advanced=True,
          tooltip="Editable workflow-persisted prompt used while invalidate_key is current.",
        ),
        io.Boolean.Input(
          "force_refresh",
          default=False,
          label_on="Refresh",
          label_off="Use cache",
          socketless=True,
          tooltip="Evaluate live_prompt even when invalidate_key matches.",
        ),
        io.String.Input(
          "live_prompt",
          optional=True,
          lazy=True,
          multiline=True,
          dynamic_prompts=False,
          tooltip="Prompt produced by the upstream generator. It is skipped while the cache is current.",
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
    invalidate_key: str,
    cached_prompt: str = "",
    force_refresh: bool = False,
    live_prompt: str | None = None,
    cached_invalidate_key: str = "",
  ) -> str:
    _ = live_prompt, cached_invalidate_key
    _validate_invalidate_key(invalidate_key)
    if force_refresh:
      return f"{invalidate_key}\0{time.time_ns()}"
    return f"{invalidate_key}\0{cached_prompt}"

  @classmethod
  def check_lazy_status(
    cls,
    invalidate_key: str,
    cached_prompt: str = "",
    force_refresh: bool = False,
    live_prompt: str | None = None,
    cached_invalidate_key: str = "",
  ) -> list[str]:
    _validate_invalidate_key(invalidate_key)
    if _cache_is_current(invalidate_key, cached_invalidate_key, force_refresh):
      return []
    return [] if live_prompt is not None else ["live_prompt"]

  @classmethod
  def execute(
    cls,
    invalidate_key: str,
    cached_prompt: str = "",
    force_refresh: bool = False,
    live_prompt: str | None = None,
    cached_invalidate_key: str = "",
  ) -> io.NodeOutput:
    _validate_invalidate_key(invalidate_key)
    if _cache_is_current(invalidate_key, cached_invalidate_key, force_refresh):
      return io.NodeOutput(cached_prompt)
    if live_prompt is None:
      raise ValueError("Prompt Live Cache needs live_prompt when the cache is stale.")
    return io.NodeOutput(
      live_prompt,
      ui={
        "cached_prompt": [live_prompt],
        "cached_invalidate_key": [invalidate_key_fingerprint(invalidate_key)],
      },
    )


__all__ = ["PromptLiveCacheNode"]
