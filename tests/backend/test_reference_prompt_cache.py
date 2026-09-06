import hashlib
import importlib
import json

import pytest


def _bundle():
  contract = importlib.import_module("backend.core.reference_contract")
  manifest = importlib.import_module("backend.core.reference_manifest")
  bundle_module = importlib.import_module("backend.nodes.reference_bundle")
  state = contract.parse_reference_state(
    {
      "version": 1,
      "items": {},
      "imageOrder": [],
      "videoOrder": [],
      "audioOrder": [],
      "videoAudioPolicy": "preserve",
    }
  )
  return bundle_module.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=(),
    audio_captions=(),
    videos=(),
    video_captions=(),
    manifest_json=json.dumps(manifest.build_reference_manifest(state)),
    reference_fingerprint="a" * 64,
  )


def test_reference_prompt_cache_skips_lazy_prompt_when_hash_matches():
  module = importlib.import_module("backend.nodes.reference_prompt_cache")
  bundle = _bundle()
  node = module.ReferencePromptCacheNode

  assert node.define_schema().node_id == "Alyac_ReferencePromptCache"
  schema_inputs = node.define_schema().inputs
  inputs = {item.name: item.options for item in schema_inputs}
  assert schema_inputs[-1].name == "cached_invalidate_key"
  assert inputs["cached_prompt"].get("extra_dict", {}) == {}
  assert inputs["cached_ref_hash"]["extra_dict"] == {
    "read_only": True,
    "disabled": True,
  }
  assert inputs["cached_invalidate_key"]["extra_dict"] == {
    "read_only": True,
    "disabled": True,
  }
  assert node.check_lazy_status(bundle, None, "cached", "a" * 64, False) == []
  assert node.execute(bundle, None, "cached", "a" * 64, False) == ("cached",)


def test_reference_prompt_cache_invalidates_when_invalidate_key_changes():
  module = importlib.import_module("backend.nodes.reference_prompt_cache")
  bundle = _bundle()
  node = module.ReferencePromptCacheNode

  key = "fl2v|seed=42"
  key_hash = hashlib.sha256(key.encode("utf-8")).hexdigest()
  assert node.check_lazy_status(bundle, None, "cached", "a" * 64, False, key, "") == [
    "live_prompt"
  ]
  assert (
    node.check_lazy_status(bundle, None, "cached", "a" * 64, False, key, key_hash) == []
  )

  output = node.execute(bundle, "live", "cached", "a" * 64, False, key, "stale")
  assert output == ("live",)
  assert output.ui == {
    "cached_prompt": ["live"],
    "cached_ref_hash": ["a" * 64],
    "cached_invalidate_key": [key_hash],
  }


def test_reference_prompt_cache_refreshes_and_persists_ui_values():
  module = importlib.import_module("backend.nodes.reference_prompt_cache")
  bundle = _bundle()
  output = module.ReferencePromptCacheNode.execute(
    bundle,
    "live",
    "cached",
    "stale",
    False,
  )

  assert output == ("live",)
  assert output.ui == {
    "cached_prompt": ["live"],
    "cached_ref_hash": ["a" * 64],
    "cached_invalidate_key": [""],
  }
  assert module.ReferencePromptCacheNode.check_lazy_status(
    bundle, None, "cached", "stale", True
  ) == ["live_prompt"]


def test_reference_prompt_cache_requires_a_fingerprinted_bundle():
  module = importlib.import_module("backend.nodes.reference_prompt_cache")
  bundle = _bundle()
  legacy = type(bundle)(
    images=bundle.images,
    image_captions=bundle.image_captions,
    audios=bundle.audios,
    audio_captions=bundle.audio_captions,
    videos=bundle.videos,
    video_captions=bundle.video_captions,
    manifest_json=bundle.manifest_json,
  )

  with pytest.raises(ValueError, match="bundle fingerprint"):
    module.ReferencePromptCacheNode.check_lazy_status(legacy)
