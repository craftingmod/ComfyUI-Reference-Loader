import importlib
import json


def _bundle(module):
  contract = importlib.import_module("backend.core.reference_contract")
  manifest = importlib.import_module("backend.core.reference_manifest")
  prompt_contract = importlib.import_module("backend.core.prompt_contract")
  state = contract.parse_reference_state(
    {
      "version": 1,
      "items": {
        "image-a": {
          "id": "image-a",
          "kind": "image",
          "source": {
            "path": "reference_loader/sources/image-a.png",
            "mime": "image/png",
            "sha256": "a" * 64,
          },
          "caption": "",
          "imageEnabled": True,
        },
        "image-b": {
          "id": "image-b",
          "kind": "image",
          "source": {
            "path": "reference_loader/sources/image-b.png",
            "mime": "image/png",
            "sha256": "b" * 64,
          },
          "caption": "",
          "imageEnabled": True,
        },
        "audio-a": {
          "id": "audio-a",
          "kind": "audio",
          "source": {
            "path": "reference_loader/sources/audio-a.wav",
            "mime": "audio/wav",
            "sha256": "c" * 64,
          },
          "caption": "",
          "audioEnabled": True,
        },
        "video-a": {
          "id": "video-a",
          "kind": "video",
          "source": {
            "path": "reference_loader/sources/video-a.mp4",
            "mime": "video/mp4",
            "sha256": "d" * 64,
          },
          "caption": "",
          "videoEnabled": True,
          "videoAudioEnabled": False,
          "audioEnabled": True,
        },
        "video-b": {
          "id": "video-b",
          "kind": "video",
          "source": {
            "path": "reference_loader/sources/video-b.mp4",
            "mime": "video/mp4",
            "sha256": "e" * 64,
          },
          "caption": "",
          "videoEnabled": True,
          "videoAudioEnabled": False,
          "audioEnabled": True,
        },
      },
      "imageOrder": ["image-a", "image-b"],
      "videoOrder": ["video-a", "video-b"],
      "audioOrder": ["audio-a", "video-a", "video-b"],
      "videoAudioPolicy": "preserve",
    }
  )
  return module.ReferenceLoaderBundle(
    images=("image-a-payload", "image-b-payload"),
    image_captions=("", ""),
    audios=("audio-a-payload", "video-a-audio-payload", "video-b-audio-payload"),
    audio_captions=("", "", ""),
    videos=("video-a-payload", "video-b-payload"),
    video_captions=("", ""),
    manifest_json=json.dumps(manifest.build_reference_manifest(state)),
    prompt_state_json=prompt_contract.EMPTY_PROMPT_STATE_JSON,
    compiled_prompt="",
  )


def test_llm_description_inputs_schema():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  schema = module.ReferenceLoaderLLMDescriptionInputsNode.define_schema()

  assert schema.node_id == "Alyac_ReferenceLoaderLLMDescriptionInputs"
  assert schema.display_name == "[Reference Loader] LLM Description Inputs"
  assert schema.category == "reference/llm"
  assert [field.name for field in schema.inputs] == [
    "references",
    "response_format",
    "system_prompt",
    "image_prompt",
    "audio_prompt",
    "video_prompt",
    "json_field_guidance",
  ]
  assert schema.inputs[1].options["options"] == ["text", "json"]
  assert schema.inputs[1].options["default"] == "json"
  assert schema.inputs[1].options["advanced"] is True
  assert [field.options["default"] for field in schema.inputs[2:]] == [
    "",
    "",
    "",
    "",
    "",
  ]
  assert [field.options["multiline"] for field in schema.inputs[2:]] == [
    True,
    True,
    True,
    True,
    True,
  ]
  assert [field.options["advanced"] for field in schema.inputs[2:]] == [
    True,
    True,
    True,
    True,
    True,
  ]
  assert [field.name for field in schema.outputs] == [
    "images",
    "audio",
    "video",
    "system",
    "prompt",
    "request_manifest_json",
  ]
  assert [field.options.get("is_output_list", False) for field in schema.outputs] == [
    True,
    True,
    True,
    False,
    True,
    False,
  ]


def test_llm_description_inputs_use_trimmed_values_and_fallbacks():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  outputs = module.build_llm_description_inputs(
    _bundle(module),
    system_prompt="  Custom system.  ",
    image_prompt="\n  ",
    audio_prompt="  Custom audio prompt.\n",
    video_prompt="\tCustom video prompt.",
  )

  assert outputs[3] == ("Custom system.\n\n" + module.TEXT_RESPONSE_FORMAT)
  assert outputs[4] == [
    module.DEFAULT_IMAGE_PROMPT,
    module.DEFAULT_IMAGE_PROMPT,
    "Custom audio prompt.",
    "Custom audio prompt.",
    "Custom audio prompt.",
    "Custom video prompt.",
    "Custom video prompt.",
  ]


def test_default_video_prompt_summarizes_temporal_order():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )

  normalized_prompt = " ".join(module.DEFAULT_VIDEO_PROMPT.split())
  assert "Summarize temporal_order with key events and major changes" in (
    normalized_prompt
  )
  assert "do not enumerate every small action or fixed time interval" in (
    normalized_prompt
  )


def test_llm_description_inputs_emit_sequential_manifest():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  outputs = module.ReferenceLoaderLLMDescriptionInputsNode.execute(_bundle(module))

  assert outputs[:3] == (
    ["image-a-payload", "image-b-payload"],
    [
      "audio-a-payload",
      "video-a-audio-payload",
      "video-b-audio-payload",
    ],
    ["video-a-payload", "video-b-payload"],
  )
  assert outputs[4] == [
    module.DEFAULT_IMAGE_PROMPT,
    module.DEFAULT_IMAGE_PROMPT,
    module.DEFAULT_AUDIO_PROMPT,
    module.DEFAULT_AUDIO_PROMPT,
    module.DEFAULT_AUDIO_PROMPT,
    module.DEFAULT_VIDEO_PROMPT,
    module.DEFAULT_VIDEO_PROMPT,
  ]

  manifest = json.loads(outputs[5])
  assert [
    (item["index"], item["kind"], item["modality_index"], item["reference_id"])
    for item in manifest["items"]
  ] == [
    (0, "image", 0, "image-a"),
    (1, "image", 1, "image-b"),
    (2, "audio", 0, "audio-a"),
    (3, "audio", 1, "video-a:audio"),
    (4, "audio", 2, "video-b:audio"),
    (5, "video", 0, "video-a"),
    (6, "video", 1, "video-b"),
  ]
  assert manifest["by_kind"] == {
    "audio": ["audio-a", "video-a:audio", "video-b:audio"],
    "image": ["image-a", "image-b"],
    "video": ["video-a", "video-b"],
  }


def test_llm_description_inputs_do_not_duplicate_output_contract():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  prompt = module.build_system_prompt(
    f"Custom instructions\n\n{module.REQUIRED_OUTPUT_FORMAT}\n\n"
    f"{module.JSON_RESPONSE_FORMAT}",
    "json",
  )
  assert prompt.count(module.REQUIRED_OUTPUT_FORMAT) == 1
  assert prompt.count(module.JSON_RESPONSE_FORMAT) == 1


def test_llm_description_inputs_support_json_response_format():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  outputs = module.build_llm_description_inputs(
    _bundle(module),
    response_format="json",
  )

  assert (
    f"{module.REQUIRED_OUTPUT_FORMAT}\n\n{module.JSON_RESPONSE_FORMAT}" in outputs[3]
  )
  assert "Record<string, string>" in outputs[3]
  assert (
    "Do not use nested objects, arrays, numbers, booleans, or null values."
    in outputs[3]
  )
  assert "summarize them in one string field" in outputs[3]
  assert module.DEFAULT_JSON_FIELD_GUIDANCE in outputs[3]


def test_llm_description_inputs_accept_custom_json_field_guidance():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  prompt = module.build_system_prompt(
    response_format="json",
    json_field_guidance="Use exactly scene and mood fields.",
  )
  assert "Use exactly scene and mood fields." in prompt
  assert module.DEFAULT_JSON_FIELD_GUIDANCE not in prompt


def test_llm_description_inputs_json_contract_allows_arbitrary_string_fields():
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )
  references = _bundle(module)

  overlays = module._description_overlays(
    references,
    response=[
      '{"subject":"woman","clothing":"red coat"}',
      '{"environment":"forest"}',
      "{}",
      '{"action":"walking"}',
      '{"action":"running"}',
      '{"sound":"rain"}',
      '{"sound":"wind"}',
    ],
    response_format="json",
  )

  assert overlays[0][0] == {"subject": "woman", "clothing": "red coat"}
  assert overlays[0][1] == {"environment": "forest"}
  assert overlays[1][0] == {}
  assert overlays[1][1] == {"action": "walking"}
  assert overlays[2][0] == {"sound": "rain"}


def test_llm_description_inputs_reject_unknown_response_format():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  try:
    module.build_system_prompt(response_format="yaml")
  except ValueError as exc:
    assert "Expected text or json" in str(exc)
  else:
    raise AssertionError("unknown response format must fail")


def test_llm_description_inputs_text_format_replaces_legacy_json_contract():
  module = importlib.import_module(
    "backend.nodes.reference_loader_llm_description_inputs"
  )
  prompt = module.build_system_prompt(
    f"Legacy instructions\n\n{module.REQUIRED_OUTPUT_FORMAT}\n\n"
    f"{module.JSON_RESPONSE_FORMAT}",
    "text",
  )

  assert prompt == "Legacy instructions\n\n" + module.TEXT_RESPONSE_FORMAT
