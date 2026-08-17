import importlib
import json
import sys

import pytest


def load_node_module(monkeypatch):
  for name in tuple(sys.modules):
    if name == "backend.nodes" or name.startswith("backend.nodes."):
      monkeypatch.delitem(sys.modules, name)
  return importlib.import_module("backend.nodes.reference_loader")


def test_reference_loader_schema_and_aligned_execute(monkeypatch):
  module = load_node_module(monkeypatch)
  schema = module.ReferenceLoaderNode.define_schema()
  assert schema.node_id == "Alyac_ReferenceLoader"
  assert schema.category == "reference/loader"
  assert [field.name for field in schema.inputs] == [
    "loader_state",
    "prompt",
    "limit_image_pixels",
    "max_image_pixels",
    "composite_alpha",
    "alpha_background",
    "prompt_schema_preset",
    "grid_columns",
    "preview_pixels",
    "show_captions",
    "two_image_mode",
    "prompt_by_order",
    "card_aspect",
    "preview_fit",
    "waveform_pairs",
  ]
  assert schema.inputs[0].options["extra_dict"] == {"widgetType": "REFERENCE_LOADER"}
  prompt = schema.inputs[1]
  assert prompt.data_type == "string"
  assert prompt.options["extra_dict"]["widgetType"] == "REFERENCE_PROMPT"
  assert prompt.options["extra_dict"]["promptPresets"] == module.PROMPT_PRESET_CATALOG
  assert prompt.options["socketless"] is True
  assert prompt.options["dynamic_prompts"] is False
  limit_image_pixels = schema.inputs[2]
  assert limit_image_pixels.data_type == "boolean"
  assert limit_image_pixels.options["default"] is False
  assert limit_image_pixels.options["label_off"] == "Original"
  assert limit_image_pixels.options["label_on"] == "Limited"
  assert limit_image_pixels.options["advanced"] is True
  assert limit_image_pixels.options["socketless"] is False
  max_image_pixels = schema.inputs[3]
  assert max_image_pixels.data_type == "float"
  assert max_image_pixels.options["display_name"] == "max_image_pixels (MPixel)"
  assert max_image_pixels.options["default"] == 2.0
  assert max_image_pixels.options["min"] == 0.25
  assert max_image_pixels.options["max"] == 40.0
  assert max_image_pixels.options["advanced"] is True
  assert max_image_pixels.options["socketless"] is False
  composite_alpha = schema.inputs[4]
  assert composite_alpha.data_type == "boolean"
  assert composite_alpha.options["default"] is False
  assert composite_alpha.options["label_off"] == "Preserve"
  assert composite_alpha.options["label_on"] == "Opaque"
  assert composite_alpha.options["advanced"] is True
  assert composite_alpha.options["socketless"] is False
  alpha_background = schema.inputs[5]
  assert alpha_background.data_type == "color"
  assert alpha_background.options["default"] == "#000000"
  assert alpha_background.options["advanced"] is True
  assert alpha_background.options["socketless"] is False
  prompt_schema_preset = schema.inputs[6]
  assert prompt_schema_preset.data_type == "combo"
  assert prompt_schema_preset.options["display_name"] == "prompt_schema_preset"
  assert prompt_schema_preset.options["options"] == [
    "generic",
    "minimax_h3_base",
    "minimax_h3_reference",
    "freeform",
  ]
  assert prompt_schema_preset.options["default"] == "generic"
  assert prompt_schema_preset.options["advanced"] is True
  assert prompt_schema_preset.options["socketless"] is True
  grid_columns = schema.inputs[7]
  assert grid_columns.data_type == "int"
  assert grid_columns.options["display_name"] == "grid_columns"
  assert grid_columns.options["default"] == 3
  assert grid_columns.options["advanced"] is True
  assert grid_columns.options["socketless"] is True
  preview_pixels = schema.inputs[8]
  assert preview_pixels.data_type == "float"
  assert preview_pixels.options["display_name"] == "preview_pixels (MPixel)"
  assert preview_pixels.options["default"] == 1.0
  assert preview_pixels.options["advanced"] is True
  assert preview_pixels.options["socketless"] is True
  show_captions = schema.inputs[9]
  assert show_captions.data_type == "boolean"
  assert show_captions.options["display_name"] == "show_captions"
  assert show_captions.options["default"] is True
  assert show_captions.options["advanced"] is True
  assert show_captions.options["socketless"] is True
  two_image_mode = schema.inputs[10]
  assert two_image_mode.data_type == "boolean"
  assert two_image_mode.options["display_name"] == "two_image_mode"
  assert two_image_mode.options["default"] is False
  assert two_image_mode.options["label_off"] == "Unlimited"
  assert two_image_mode.options["label_on"] == "Up to 2"
  assert two_image_mode.options["advanced"] is True
  assert two_image_mode.options["socketless"] is True
  prompt_by_order = schema.inputs[11]
  assert prompt_by_order.data_type == "boolean"
  assert prompt_by_order.options["display_name"] == "prompt_by_order"
  assert prompt_by_order.options["default"] is False
  assert prompt_by_order.options["label_off"] == "By media"
  assert prompt_by_order.options["label_on"] == "By order"
  assert prompt_by_order.options["advanced"] is True
  assert prompt_by_order.options["socketless"] is True
  card_aspect = schema.inputs[12]
  assert card_aspect.data_type == "combo"
  assert card_aspect.options["display_name"] == "card_aspect"
  assert card_aspect.options["options"] == [
    "1 / 1",
    "4 / 3",
    "3 / 4",
    "16 / 9",
    "9 / 16",
  ]
  assert card_aspect.options["default"] == "4 / 3"
  assert card_aspect.options["advanced"] is True
  assert card_aspect.options["socketless"] is True
  preview_fit = schema.inputs[13]
  assert preview_fit.data_type == "combo"
  assert preview_fit.options["display_name"] == "preview_fit"
  assert preview_fit.options["options"] == ["contain", "cover"]
  assert preview_fit.options["default"] == "contain"
  assert preview_fit.options["advanced"] is True
  assert preview_fit.options["socketless"] is True
  waveform_pairs = schema.inputs[14]
  assert waveform_pairs.data_type == "int"
  assert waveform_pairs.options["display_name"] == "waveform_pairs"
  assert waveform_pairs.options["default"] == 300
  assert waveform_pairs.options["min"] == 100
  assert waveform_pairs.options["max"] == 1000
  assert waveform_pairs.options["step"] == 50
  assert waveform_pairs.options["advanced"] is True
  assert waveform_pairs.options["socketless"] is True
  assert [field.name for field in schema.outputs] == ["references"]
  assert schema.outputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert schema.outputs[0].options.get("is_output_list", False) is False

  state = {
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
        "caption": "caption",
        "imageEnabled": True,
      }
    },
    "imageOrder": ["img"],
    "videoOrder": [],
    "audioOrder": [],
    "videoAudioPolicy": "preserve",
    "ui": {"previewMaxPixels": 1},
  }
  loaded_type = importlib.import_module(
    "backend.core.reference_media"
  ).LoadedReferenceMedia
  loaded_settings = []
  monkeypatch.setattr(
    module,
    "load_reference_media",
    lambda _state, **kwargs: (
      loaded_settings.append(kwargs["image_output"])
      or loaded_type(images=("native-image",))
    ),
  )
  prompt_state = {
    "version": 4,
    "view": "structured",
    "subjects": [{"subjectId": "fighter", "label": "fighter"}],
    "sections": [
      {
        "title": "scene",
        "parts": [
          {"type": "text", "text": "Use "},
          {"type": "subject", "subjectId": "fighter", "label": "fighter"},
          {"type": "text", "text": " from "},
          {
            "type": "mention",
            "referenceId": "img",
            "mediaKind": "image",
            "label": "image1",
          },
        ],
      }
    ],
  }
  output = module.ReferenceLoaderNode.execute(
    json.dumps(state), prompt=json.dumps(prompt_state)
  )
  assert len(output) == 1
  bundle = output[0]
  assert bundle.images == ("native-image",)
  assert bundle.image_captions == ("caption",)
  assert bundle.audios == ()
  assert bundle.audio_captions == ()
  assert bundle.videos == ()
  assert bundle.video_captions == ()
  assert json.loads(bundle.prompt_state_json) == {
    "version": 4,
    "subjects": prompt_state["subjects"],
    "sections": prompt_state["sections"],
  }
  assert bundle.compiled_prompt == "scene:\nUse <Subject 1> from <Picture 1>"
  assert json.loads(bundle.manifest_json)["outputs"]["images"] == ["img"]
  assert json.loads(bundle.manifest_json)["image_output"] == {
    "mode": "original",
    "alphaMode": "preserve",
  }
  assert loaded_settings[0].projection() == {
    "mode": "original",
    "alphaMode": "preserve",
  }

  outputs_module = importlib.import_module("backend.nodes.reference_loader_raw_outputs")
  outputs_schema = outputs_module.ReferenceLoaderRawOutputsNode.define_schema()
  assert outputs_schema.node_id == "Alyac_ReferenceLoaderRawOutputs"
  assert outputs_schema.display_name == "[Reference Loader] Media Outputs"
  assert outputs_schema.category == "reference/output"
  assert [field.name for field in outputs_schema.inputs] == ["references"]
  assert outputs_schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert [field.name for field in outputs_schema.outputs] == [
    "images",
    "image_captions",
    "audios",
    "audio_captions",
    "videos",
    "video_captions",
    "manifest_json",
    "first_image",
  ]
  assert [
    field.options.get("is_output_list", False) for field in outputs_schema.outputs
  ] == [True, True, True, True, True, True, False, False]
  unpacked = outputs_module.ReferenceLoaderRawOutputsNode.execute(bundle)
  assert unpacked[:6] == (
    ["native-image"],
    ["caption"],
    [],
    [],
    [],
    [],
  )
  assert unpacked[6] == bundle.manifest_json
  assert unpacked[7] == "native-image"
  limited_output = module.ReferenceLoaderNode.execute(
    json.dumps(state),
    limit_image_pixels=True,
    max_image_pixels=3.75,
  )
  assert json.loads(limited_output[0].manifest_json)["image_output"] == {
    "mode": "limited",
    "alphaMode": "preserve",
    "maxPixels": 3_750_000,
  }
  assert loaded_settings[1].projection() == {
    "mode": "limited",
    "alphaMode": "preserve",
    "maxPixels": 3_750_000,
  }
  opaque_output = module.ReferenceLoaderNode.execute(
    json.dumps(state),
    composite_alpha=True,
    alpha_background="#12345680",
  )
  assert json.loads(opaque_output[0].manifest_json)["image_output"] == {
    "mode": "original",
    "alphaMode": "opaque",
    "alphaBackground": "#123456",
  }
  replacement_prompt = json.loads(json.dumps(prompt_state))
  replacement_prompt["sections"][0]["parts"][3]["referenceId"] = "removed-image"
  order_bound_output = module.ReferenceLoaderNode.execute(
    json.dumps(state),
    prompt=json.dumps(replacement_prompt),
    prompt_by_order=True,
  )
  assert (
    order_bound_output[0].compiled_prompt == "scene:\nUse <Subject 1> from <Picture 1>"
  )
  assert (
    json.loads(order_bound_output[0].prompt_state_json)["sections"][0]["parts"][3][
      "referenceId"
    ]
    == "img"
  )


def test_reference_loader_raw_outputs_rejects_non_bundle_value(monkeypatch):
  load_node_module(monkeypatch)
  outputs_module = importlib.import_module("backend.nodes.reference_loader_raw_outputs")

  with pytest.raises(TypeError, match="REFERENCE_LOADER_BUNDLE"):
    outputs_module.ReferenceLoaderRawOutputsNode.execute(object())


def test_reference_loader_raw_prompt_extracts_compiled_bundle_prompt(monkeypatch):
  load_node_module(monkeypatch)
  raw_prompt_module = importlib.import_module(
    "backend.nodes.reference_loader_raw_prompt"
  )
  bundle_module = importlib.import_module("backend.nodes.reference_bundle")
  contract = importlib.import_module("backend.core.reference_contract")
  manifest = importlib.import_module("backend.core.reference_manifest")
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
  bundle = bundle_module.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=(),
    audio_captions=(),
    videos=(),
    video_captions=(),
    manifest_json=json.dumps(manifest.build_reference_manifest(state)),
    prompt_state_json=json.dumps(
      {
        "version": 4,
        "subjects": [],
        "sections": [
          {
            "title": "scene",
            "parts": [{"type": "text", "text": "A quiet station"}],
          }
        ],
      }
    ),
    compiled_prompt="scene:\nA quiet station",
  )

  schema = raw_prompt_module.ReferenceLoaderRawPromptNode.define_schema()
  assert schema.node_id == "Alyac_ReferenceLoaderRawPrompt"
  assert schema.display_name == "[Reference Loader] Raw Prompt"
  assert schema.category == "reference/output"
  assert [field.name for field in schema.inputs] == ["references"]
  assert schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert [field.name for field in schema.outputs] == ["raw_prompt"]
  assert schema.outputs[0].data_type == "string"

  output = raw_prompt_module.ReferenceLoaderRawPromptNode.execute(bundle)
  assert output == ("scene:\nA quiet station",)
  assert (
    len(raw_prompt_module.ReferenceLoaderRawPromptNode.fingerprint_inputs(bundle)) == 64
  )

  with pytest.raises(TypeError, match="REFERENCE_LOADER_BUNDLE"):
    raw_prompt_module.ReferenceLoaderRawPromptNode.execute(object())


def test_reference_loader_media_outputs_returns_none_without_a_first_image(monkeypatch):
  load_node_module(monkeypatch)
  outputs_module = importlib.import_module("backend.nodes.reference_loader_raw_outputs")
  bundle_module = importlib.import_module("backend.nodes.reference_bundle")
  bundle = bundle_module.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=(),
    audio_captions=(),
    videos=(),
    video_captions=(),
    manifest_json="{}",
  )

  unpacked = outputs_module.ReferenceLoaderRawOutputsNode.execute(bundle)

  assert unpacked[7] is None


def test_reference_loader_rejects_loader_alignment_mismatch(monkeypatch):
  module = load_node_module(monkeypatch)
  loaded_type = importlib.import_module(
    "backend.core.reference_media"
  ).LoadedReferenceMedia
  monkeypatch.setattr(
    module,
    "load_reference_media",
    lambda _state, **_kwargs: loaded_type(images=("unexpected",)),
  )
  with pytest.raises(ValueError, match="IMAGE count"):
    module.ReferenceLoaderNode.execute(module.EMPTY_LOADER_STATE_JSON)


def test_prompt_preset_catalog_loads_user_json_and_rejects_invalid_aliases(
  monkeypatch,
  tmp_path,
):
  module = load_node_module(monkeypatch)
  preset = {
    "version": 1,
    "order": 10,
    "default": True,
    "id": "custom_video",
    "label": {"en": "Custom video", "ko": "사용자 비디오"},
    "description": {"en": "Custom", "ko": "사용자 정의"},
    "defaultSectionTitle": "custom_direction",
    "subjectMode": "disabled",
    "aliases": [
      {
        "command": "custom",
        "title": "custom_direction",
        "label": {"en": "Custom", "ko": "사용자"},
        "description": {"en": "Custom field", "ko": "사용자 필드"},
        "icon": "C",
      }
    ],
  }
  directory = tmp_path / "prompt"
  directory.mkdir()
  path = directory / "custom_video.json"
  path.write_text(json.dumps(preset, ensure_ascii=False), encoding="utf-8")
  assert module.load_prompt_preset_catalog(directory) == {
    "version": 1,
    "defaultPresetId": "custom_video",
    "presets": [
      {
        key: value
        for key, value in preset.items()
        if key not in {"version", "order", "default"}
      }
    ],
  }

  preset["aliases"][0]["command"] = "not-valid"
  path.write_text(json.dumps(preset, ensure_ascii=False), encoding="utf-8")
  with pytest.raises(ValueError, match="invalid alias"):
    module.load_prompt_preset_catalog(directory)


def test_fingerprint_strongly_validates_sources_before_returning_cache_key(
  monkeypatch,
):
  module = load_node_module(monkeypatch)
  calls = []
  monkeypatch.setattr(
    module,
    "validate_reference_sources",
    lambda state: calls.append(state),
  )

  fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON
  )
  display_only_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    grid_columns=8,
    preview_pixels=16.0,
    show_captions=False,
    two_image_mode=True,
    prompt_by_order=True,
    card_aspect="16 / 9",
    preview_fit="cover",
    waveform_pairs=1000,
  )
  preset_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    prompt_schema_preset="minimax_h3_base",
  )
  inactive_max_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    max_image_pixels=40.0,
  )
  limited_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    limit_image_pixels=True,
    max_image_pixels=4.0,
  )
  inactive_background_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    alpha_background="#ffffff",
  )
  opaque_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    composite_alpha=True,
    alpha_background="#ffffff",
  )
  opaque_alpha_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    composite_alpha=True,
    alpha_background="#ffffff00",
  )
  prompt_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    prompt="A different prompt",
  )
  raw_view_fingerprint = module.ReferenceLoaderNode.fingerprint_inputs(
    module.EMPTY_LOADER_STATE_JSON,
    prompt=json.dumps({"version": 4, "view": "raw", "subjects": [], "sections": []}),
  )

  assert len(fingerprint) == 64
  assert display_only_fingerprint == fingerprint
  assert preset_fingerprint == fingerprint
  assert inactive_max_fingerprint == fingerprint
  assert inactive_background_fingerprint == fingerprint
  assert limited_fingerprint != fingerprint
  assert opaque_fingerprint != fingerprint
  assert opaque_alpha_fingerprint == opaque_fingerprint
  assert prompt_fingerprint != fingerprint
  assert raw_view_fingerprint == fingerprint
  assert len(calls) == 10
