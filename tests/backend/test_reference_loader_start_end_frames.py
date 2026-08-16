import importlib

import pytest


def _bundle(module, images=()):
  return module.ReferenceLoaderBundle(
    images=images,
    image_captions=tuple(f"caption {index}" for index, _ in enumerate(images)),
    audios=(),
    audio_captions=(),
    videos=(),
    video_captions=(),
    manifest_json="{}",
  )


def test_start_end_frames_schema_declares_nullable_image_contract():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  schema = module.ReferenceLoaderStartEndFramesNode.define_schema()

  assert schema.node_id == "Alyac_ReferenceLoaderStartEndFrames"
  assert schema.display_name == "Reference Loader Start/End Frames"
  assert [field.name for field in schema.inputs] == [
    "references",
    "mode",
    "enum_string",
  ]
  assert schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert schema.inputs[1].data_type == "combo"
  assert schema.inputs[1].options["options"] == [
    "I2V",
    "L2V",
    "FL2V",
    "FL2V_LOOP",
    "T2V",
  ]
  assert schema.inputs[1].options["default"] == "FL2V"
  assert schema.inputs[2].data_type == "string"
  assert schema.inputs[2].options["optional"] is True
  assert schema.inputs[2].options["force_input"] is True
  assert [field.name for field in schema.outputs] == ["start_image", "end_image"]
  assert [field.data_type for field in schema.outputs] == ["image", "image"]
  assert "None" in schema.outputs[0].options["tooltip"]
  assert "None" in schema.outputs[1].options["tooltip"]


@pytest.mark.parametrize(
  ("images", "expected"),
  [
    ((), (None, None)),
    (("start",), ("start", None)),
    (("start", "end"), ("start", "end")),
  ],
)
def test_start_end_frames_defaults_to_flf2v_projection(images, expected):
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  output = module.ReferenceLoaderStartEndFramesNode.execute(_bundle(module, images))

  assert output == expected


@pytest.mark.parametrize(
  ("mode", "images", "expected"),
  [
    ("I2V", (), (None, None)),
    ("I2V", ("first", "last"), ("first", None)),
    ("L2V", (), (None, None)),
    ("L2V", ("only",), (None, "only")),
    ("L2V", ("first", "last"), (None, "last")),
    ("FL2V", ("first", "last"), ("first", "last")),
    ("FL2V_LOOP", (), (None, None)),
    ("FL2V_LOOP", ("only",), ("only", "only")),
    ("FL2V_LOOP", ("first", "second"), ("first", "first")),
    ("T2V", ("ignored",), (None, None)),
  ],
)
def test_start_end_frames_projects_selected_mode(mode, images, expected):
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  output = module.ReferenceLoaderStartEndFramesNode.execute(
    _bundle(module, images), mode=mode
  )

  assert output == expected


def test_enum_string_overrides_combo_and_normalizes_case_and_whitespace():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  output = module.ReferenceLoaderStartEndFramesNode.execute(
    _bundle(module, ("first", "last")), mode="I2V", enum_string="  l2v  "
  )

  assert output == (None, "last")


def test_blank_enum_string_falls_back_to_combo():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  output = module.ReferenceLoaderStartEndFramesNode.execute(
    _bundle(module, ("first", "last")), mode="I2V", enum_string="  "
  )

  assert output == ("first", None)


def test_start_end_frames_rejects_unknown_mode():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  with pytest.raises(
    ValueError, match="mode must be one of I2V, L2V, FL2V, FL2V_LOOP, T2V"
  ):
    module.ReferenceLoaderStartEndFramesNode.execute(
      _bundle(module, ("first",)), enum_string="V2V"
    )


def test_start_end_frames_rejects_more_than_two_enabled_images():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  with pytest.raises(ValueError, match="at most two enabled images; received 3"):
    module.ReferenceLoaderStartEndFramesNode.execute(
      _bundle(module, ("first", "middle", "last"))
    )


def test_t2v_ignores_enabled_images_including_more_than_two():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  output = module.ReferenceLoaderStartEndFramesNode.execute(
    _bundle(module, ("first", "middle", "last")), mode="T2V"
  )

  assert output == (None, None)


def test_start_end_frames_rejects_non_bundle_input():
  module = importlib.import_module("backend.nodes.reference_loader_start_end_frames")

  with pytest.raises(TypeError, match="REFERENCE_LOADER_BUNDLE"):
    module.ReferenceLoaderStartEndFramesNode.execute(object())
