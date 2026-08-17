import importlib
import json

import pytest


class FakeAlphaPlane:
  def __rsub__(self, value):
    return ("inverse", value, self)


class FakeImage:
  def __init__(self, channels: int):
    self.ndim = 4
    self.shape = (1, 2, 3, channels)
    self.alpha = FakeAlphaPlane()
    self.rgb = object()
    self.requested_zeros = None

  def __getitem__(self, key):
    if key == (Ellipsis, 3):
      return self.alpha
    if key == (Ellipsis, slice(None, 3)):
      return self.rgb
    raise AssertionError(f"Unexpected image index: {key!r}")

  def new_zeros(self, shape):
    self.requested_zeros = shape
    return ("zeros", shape)


def image_state(*, caption: str = "", enabled: bool = True) -> str:
  return json.dumps(
    {
      "version": 1,
      "items": {
        "image": {
          "id": "image",
          "kind": "image",
          "source": {
            "path": "reference_loader/sources/image.png",
            "mime": "image/png",
            "sha256": "a" * 64,
          },
          "caption": caption,
          "imageEnabled": enabled,
        }
      },
      "imageOrder": ["image"],
      "videoOrder": [],
      "audioOrder": [],
      "videoAudioPolicy": "preserve",
      "ui": {"previewMaxPixels": 1_000_000},
    }
  )


def load_module():
  return importlib.import_module("backend.nodes.load_reference_image")


def test_load_reference_image_schema_matches_single_image_contract():
  module = load_module()
  schema = module.LoadReferenceImageNode.define_schema()
  reference_schema = importlib.import_module(
    "backend.nodes.reference_loader"
  ).ReferenceLoaderNode.define_schema()

  assert schema.node_id == "Alyac_LoadReferenceImage"
  assert schema.display_name == "Load Reference Image"
  assert schema.category == "reference/loader"
  assert [field.name for field in schema.inputs] == [
    "image_state",
    "limit_image_pixels",
    "max_image_pixels",
    "composite_alpha",
    "alpha_background",
    "preview_pixels",
  ]
  assert schema.inputs[0].options["extra_dict"] == {
    "widgetType": "REFERENCE_IMAGE_LOADER"
  }
  assert schema.inputs[0].options["socketless"] is True
  assert schema.inputs[0].options["dynamic_prompts"] is False
  assert schema.inputs[1].options["socketless"] is False
  assert schema.inputs[2].options["default"] == 2.0
  assert schema.inputs[3].options["label_on"] == "Opaque"
  assert schema.inputs[4].options["default"] == "#000000"
  assert schema.inputs[5].options["default"] == 1.0
  assert schema.inputs[5].options["socketless"] is True
  shared_names = {
    "limit_image_pixels",
    "max_image_pixels",
    "composite_alpha",
    "alpha_background",
    "preview_pixels",
  }
  shared_inputs = {
    field.name: field for field in reference_schema.inputs if field.name in shared_names
  }
  assert {
    field.name: field.options for field in schema.inputs if field.name in shared_names
  } == {name: field.options for name, field in shared_inputs.items()}
  assert [field.name for field in schema.outputs] == ["image", "mask"]
  assert [field.data_type for field in schema.outputs] == ["image", "mask"]


@pytest.mark.parametrize("channels", [3, 4])
def test_load_reference_image_executes_through_shared_media_loader(
  monkeypatch, channels
):
  module = load_module()
  media_module = importlib.import_module("backend.core.reference_media")
  image = FakeImage(channels)
  settings = []
  monkeypatch.setattr(
    module,
    "load_reference_media",
    lambda _state, **kwargs: (
      settings.append(kwargs["image_output"])
      or media_module.LoadedReferenceMedia(images=(image,))
    ),
  )

  output = module.LoadReferenceImageNode.execute(
    image_state(caption="lighting reference"),
    limit_image_pixels=True,
    max_image_pixels=3.75,
    composite_alpha=channels == 3,
    alpha_background="#12345680",
    preview_pixels=0.25,
  )

  if channels == 4:
    assert output[0] is image.rgb
    assert output[1] == ("inverse", 1.0, image.alpha)
  else:
    assert output[0] is image
    assert output[1] == ("zeros", (1, 64, 64))
  assert len(output) == 2
  assert settings[0].projection() == {
    "mode": "limited",
    "alphaMode": "opaque" if channels == 3 else "preserve",
    "maxPixels": 3_750_000,
    **({"alphaBackground": "#123456"} if channels == 3 else {}),
  }


def test_load_reference_image_fingerprint_validates_sources_and_ignores_preview(
  monkeypatch,
):
  module = load_module()
  validated = []
  monkeypatch.setattr(module, "validate_reference_sources", validated.append)
  state = image_state(caption="reference")

  original = module.LoadReferenceImageNode.fingerprint_inputs(state)
  smaller_preview = module.LoadReferenceImageNode.fingerprint_inputs(
    state, preview_pixels=0.25
  )
  limited = module.LoadReferenceImageNode.fingerprint_inputs(
    state, limit_image_pixels=True, max_image_pixels=4.0
  )
  described = module.LoadReferenceImageNode.fingerprint_inputs(
    image_state(caption="different")
  )
  assert len(original) == 64
  assert smaller_preview == original
  assert limited != original
  assert described != original
  assert len(validated) == 4


def test_load_reference_image_rejects_missing_disabled_or_extra_media(monkeypatch):
  module = load_module()
  monkeypatch.setattr(module, "validate_reference_sources", lambda _state: None)

  with pytest.raises(ValueError, match="exactly one image"):
    module.LoadReferenceImageNode.fingerprint_inputs(module.EMPTY_LOADER_STATE_JSON)
  with pytest.raises(ValueError, match="enabled image"):
    module.LoadReferenceImageNode.fingerprint_inputs(image_state(enabled=False))

  mixed = json.loads(image_state())
  mixed["items"]["audio"] = {
    "id": "audio",
    "kind": "audio",
    "source": {
      "path": "reference_loader/sources/audio.wav",
      "mime": "audio/wav",
      "sha256": "b" * 64,
    },
    "caption": "",
    "audioEnabled": True,
  }
  mixed["audioOrder"] = ["audio"]
  with pytest.raises(ValueError, match="no audio or video"):
    module.LoadReferenceImageNode.fingerprint_inputs(json.dumps(mixed))


def test_load_reference_image_rejects_invalid_loaded_image_shape(monkeypatch):
  module = load_module()
  media_module = importlib.import_module("backend.core.reference_media")
  invalid = FakeImage(2)
  monkeypatch.setattr(
    module,
    "load_reference_media",
    lambda _state, **_kwargs: media_module.LoadedReferenceMedia(images=(invalid,)),
  )

  with pytest.raises(ValueError, match="unsupported channel count"):
    module.LoadReferenceImageNode.execute(image_state())
