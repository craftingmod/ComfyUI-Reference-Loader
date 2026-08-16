import importlib
import json

import pytest


def _state():
  return {
    "version": 1,
    "items": {
      "img": {
        "id": "img",
        "kind": "image",
        "source": {
          "path": "reference_loader/sources/image.png",
          "mime": "image/png",
          "sha256": "a" * 64,
        },
        "caption": "image caption",
        "imageEnabled": True,
      },
      "audio": {
        "id": "audio",
        "kind": "audio",
        "source": {
          "path": "reference_loader/sources/audio.wav",
          "mime": "audio/wav",
          "sha256": "b" * 64,
        },
        "caption": "audio caption",
        "audioEnabled": True,
      },
      "video": {
        "id": "video",
        "kind": "video",
        "source": {
          "path": "reference_loader/sources/video.mp4",
          "mime": "video/mp4",
          "sha256": "c" * 64,
        },
        "caption": "video caption",
        "videoEnabled": True,
        "audioEnabled": False,
      },
    },
    "imageOrder": ["img"],
    "videoOrder": ["video"],
    "audioOrder": ["audio", "video"],
    "videoAudioPolicy": "preserve",
  }


def _bundle(module):
  contract = importlib.import_module("backend.core.reference_contract")
  manifest = importlib.import_module("backend.core.reference_manifest")
  state = contract.parse_reference_state(_state())
  return module.ReferenceLoaderBundle(
    images=("original-image",),
    image_captions=("image caption",),
    audios=("original-audio",),
    audio_captions=("audio caption",),
    videos=("original-video",),
    video_captions=("video caption",),
    manifest_json=json.dumps(manifest.build_reference_manifest(state)),
    prompt_state_json=(
      '{"sections":[{"parts":[{"text":"Keep this prompt",'
      '"type":"text"}],"title":"scene"}],"version":3}'
    ),
    compiled_prompt="scene:\nKeep this prompt",
  )


def test_options_override_schema_and_execute_preserve_non_image_media(monkeypatch):
  module = importlib.import_module("backend.nodes.reference_loader_options_override")
  schema = module.ReferenceLoaderOptionsOverrideNode.define_schema()

  assert schema.node_id == "Alyac_ReferenceLoaderOptionsOverride"
  assert schema.display_name == "Reference Loader Options Override"
  assert schema.category == "reference/loader"
  assert [field.name for field in schema.inputs] == [
    "references",
    "limit_image_pixels",
    "max_image_pixels",
    "composite_alpha",
    "alpha_background",
  ]
  assert schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert schema.inputs[1].options["socketless"] is False
  assert schema.inputs[2].options["socketless"] is False
  assert schema.inputs[3].options["socketless"] is False
  assert schema.inputs[4].options["socketless"] is False
  assert [field.name for field in schema.outputs] == ["references"]

  bundle = _bundle(module)
  loaded_type = importlib.import_module(
    "backend.core.reference_media"
  ).LoadedReferenceMedia
  calls = []

  def fake_load(state, *, image_output):
    calls.append((state, image_output))
    assert state.items["img"].image_enabled is True
    assert state.items["audio"].audio_enabled is False
    assert state.items["video"].video_enabled is False
    assert state.items["video"].audio_enabled is False
    return loaded_type(images=("overridden-image",))

  monkeypatch.setattr(module, "load_reference_media", fake_load)
  output = module.ReferenceLoaderOptionsOverrideNode.execute(
    bundle,
    limit_image_pixels=True,
    max_image_pixels=3.5,
    composite_alpha=True,
    alpha_background="#12345680",
  )[0]

  assert output is not bundle
  assert output.images == ("overridden-image",)
  assert output.image_captions is bundle.image_captions
  assert output.audios is bundle.audios
  assert output.audio_captions is bundle.audio_captions
  assert output.videos is bundle.videos
  assert output.video_captions is bundle.video_captions
  assert output.prompt_state_json is bundle.prompt_state_json
  assert output.compiled_prompt is bundle.compiled_prompt
  assert json.loads(output.manifest_json)["image_output"] == {
    "mode": "limited",
    "maxPixels": 3_500_000,
    "alphaMode": "opaque",
    "alphaBackground": "#123456",
  }
  assert calls[0][1].projection() == {
    "mode": "limited",
    "maxPixels": 3_500_000,
    "alphaMode": "opaque",
    "alphaBackground": "#123456",
  }


def test_options_override_rejects_manifest_bundle_mismatch():
  module = importlib.import_module("backend.nodes.reference_loader_options_override")
  bundle = _bundle(module)
  mismatched = module.ReferenceLoaderBundle(
    images=bundle.images,
    image_captions=("wrong caption",),
    audios=bundle.audios,
    audio_captions=bundle.audio_captions,
    videos=bundle.videos,
    video_captions=bundle.video_captions,
    manifest_json=bundle.manifest_json,
  )

  with pytest.raises(ValueError, match="bundled IMAGE"):
    module.ReferenceLoaderOptionsOverrideNode.execute(mismatched)


def test_options_override_rejects_non_bundle_value():
  module = importlib.import_module("backend.nodes.reference_loader_options_override")

  with pytest.raises(TypeError, match="REFERENCE_LOADER_BUNDLE"):
    module.ReferenceLoaderOptionsOverrideNode.execute(object())


def test_options_override_fingerprint_includes_prompt_snapshot(monkeypatch):
  module = importlib.import_module("backend.nodes.reference_loader_options_override")
  monkeypatch.setattr(module, "validate_reference_sources", lambda _state: None)
  bundle = _bundle(module)
  changed = module.ReferenceLoaderBundle(
    images=bundle.images,
    image_captions=bundle.image_captions,
    audios=bundle.audios,
    audio_captions=bundle.audio_captions,
    videos=bundle.videos,
    video_captions=bundle.video_captions,
    manifest_json=bundle.manifest_json,
    prompt_state_json=(
      '{"sections":[{"parts":[{"text":"Changed prompt",'
      '"type":"text"}],"title":"scene"}],"version":3}'
    ),
    compiled_prompt="scene:\nChanged prompt",
  )

  original_fingerprint = module.ReferenceLoaderOptionsOverrideNode.fingerprint_inputs(
    bundle
  )
  changed_fingerprint = module.ReferenceLoaderOptionsOverrideNode.fingerprint_inputs(
    changed
  )

  assert original_fingerprint != changed_fingerprint
