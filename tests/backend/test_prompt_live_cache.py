import hashlib
import importlib

import pytest


def test_prompt_live_cache_uses_required_key_and_lazy_refresh():
  module = importlib.import_module("backend.nodes.prompt_live_cache")
  node = module.PromptLiveCacheNode

  schema = node.define_schema()
  assert schema.node_id == "Alyac_PromptLiveCache"
  assert schema.category == "reference/util"
  assert [item.name for item in schema.inputs] == [
    "invalidate_key",
    "cached_prompt",
    "force_refresh",
    "live_prompt",
    "cached_invalidate_key",
  ]

  key = "r2v|seed=42"
  key_hash = hashlib.sha256(key.encode("utf-8")).hexdigest()
  assert node.check_lazy_status(key, "cached", False, None, "") == ["live_prompt"]
  assert node.check_lazy_status(key, "cached", False, None, key_hash) == []

  output = node.execute(key, "cached", False, "fresh", "stale")
  assert output == ("fresh",)
  assert output.ui == {
    "cached_prompt": ["fresh"],
    "cached_invalidate_key": [key_hash],
  }


def test_prompt_live_cache_force_refresh_and_empty_live_prompt():
  module = importlib.import_module("backend.nodes.prompt_live_cache")
  node = module.PromptLiveCacheNode
  key_hash = hashlib.sha256(b"stable").hexdigest()

  assert node.check_lazy_status("stable", "cached", True, None, key_hash) == [
    "live_prompt"
  ]
  assert node.execute("stable", "cached", True, "", key_hash) == ("",)

  with pytest.raises(ValueError, match="non-empty invalidate_key"):
    node.execute("", "cached", False, "live", "")
