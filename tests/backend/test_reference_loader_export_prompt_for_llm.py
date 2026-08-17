import importlib
import json

import pytest
import yaml


def _bundle(module):
  contract = importlib.import_module("backend.core.reference_contract")
  manifest = importlib.import_module("backend.core.reference_manifest")
  state = contract.parse_reference_state(
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
          "caption": "Woman at a station:\nwearing a black coat",
          "imageEnabled": True,
        },
        "video": {
          "id": "video",
          "kind": "video",
          "source": {
            "path": "reference_loader/sources/video.mp4",
            "mime": "video/mp4",
            "sha256": "b" * 64,
          },
          "caption": "Tracking shot #1",
          "videoEnabled": True,
          "audioEnabled": True,
          "audioCaptionOverride": "Rain and a station announcement",
        },
        "audio": {
          "id": "audio",
          "kind": "audio",
          "source": {
            "path": "reference_loader/sources/audio.wav",
            "mime": "audio/wav",
            "sha256": "c" * 64,
          },
          "caption": "Sparse piano",
          "audioEnabled": True,
        },
      },
      "imageOrder": ["image"],
      "videoOrder": ["video"],
      "audioOrder": ["video", "audio"],
      "videoAudioPolicy": "preserve",
    }
  )
  prompt_state_json = (
    '{"sections":[{"parts":[{"label":"woman","subjectId":"subject-woman",'
    '"type":"subject"},{"text":" uses ","type":"text"},'
    '{"label":"image1","mediaKind":"image","referenceId":"image",'
    '"type":"mention"},{"text":" carefully","type":"text"}],'
    '"title":"detailed_description"},{"parts":[{"text":"N/A",'
    '"type":"text"}],"title":"non_diegetic_music"}],'
    '"subjects":[{"subjectId":"subject-woman","label":"woman"}],"version":4}'
  )
  return module.ReferenceLoaderBundle(
    images=("image-payload",),
    image_captions=("Woman at a station:\nwearing a black coat",),
    audios=("video-audio-payload", "audio-payload"),
    audio_captions=("Rain and a station announcement", "Sparse piano"),
    videos=("video-payload",),
    video_captions=("Tracking shot #1",),
    manifest_json=json.dumps(manifest.build_reference_manifest(state)),
    prompt_state_json=prompt_state_json,
    compiled_prompt=(
      "detailed_description:\n<Subject 1> uses <Picture 1> carefully"
      "\n\nnon_diegetic_music:\nN/A"
    ),
  )


def test_export_prompt_for_llm_schema_and_strict_yaml():
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )
  schema = module.ReferenceLoaderExportPromptForLLMNode.define_schema()

  assert schema.node_id == "Alyac_ReferenceLoaderExportPromptForLLM"
  assert schema.display_name == "[Reference Loader] Export Prompt for LLM"
  assert schema.category == "reference/output"
  assert [field.name for field in schema.inputs] == [
    "references",
    "seconds",
    "additional_yaml",
  ]
  assert schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert schema.inputs[1].data_type == "float"
  assert schema.inputs[1].options["default"] == 6.0
  assert schema.inputs[1].options["min"] == 4.0
  assert schema.inputs[1].options["max"] == 15.0
  assert schema.inputs[1].options["socketless"] is False
  assert schema.inputs[2].data_type == "string"
  assert schema.inputs[2].options["multiline"] is True
  assert schema.inputs[2].options["dynamic_prompts"] is False
  assert schema.inputs[2].options["socketless"] is False
  assert [field.name for field in schema.outputs] == [
    "prompt",
    "references_yaml",
    "generation_directives_yaml",
  ]
  assert [field.data_type for field in schema.outputs] == [
    "string",
    "string",
    "string",
  ]

  bundle = _bundle(module)
  additional_yaml = (
    "mode: minimax_h3_reference\n"
    "language: ko\n"
    "requirements:\n"
    "  - Preserve reference tags exactly\n"
    "  - Write detailed shot timing"
  )
  exported, references_yaml, generation_directives_yaml = (
    module.ReferenceLoaderExportPromptForLLMNode.execute(
      bundle,
      seconds=8.5,
      additional_yaml=additional_yaml,
    )
  )
  assert references_yaml == (
    "references:\n"
    "  images:\n"
    '    "<Picture 1>": "Woman at a station:\\nwearing a black coat"\n'
    "  videos:\n"
    '    "<Video 1>": "Tracking shot #1"\n'
    "  audios:\n"
    '    "<Audio 1>":\n'
    '      caption: "Rain and a station announcement"\n'
    '      source_video: "<Video 1>"\n'
    '    "<Audio 2>":\n'
    '      caption: "Sparse piano"'
  )
  assert generation_directives_yaml == (
    "generation_directives:\n"
    '  detailed_description: "<Subject 1> uses <Picture 1> carefully"\n'
    '  non_diegetic_music: "N/A"'
  )
  assert yaml.safe_load(references_yaml) == {
    "references": yaml.safe_load(exported)["references"]
  }
  assert yaml.safe_load(generation_directives_yaml) == {
    "generation_directives": yaml.safe_load(exported)["generation_directives"]
  }
  assert exported == (
    "video_duration_seconds: 8.5\n"
    "\n"
    "mode: minimax_h3_reference\n"
    "language: ko\n"
    "requirements:\n"
    "  - Preserve reference tags exactly\n"
    "  - Write detailed shot timing\n"
    "\n"
    "references:\n"
    "  images:\n"
    '    "<Picture 1>": "Woman at a station:\\nwearing a black coat"\n'
    "  videos:\n"
    '    "<Video 1>": "Tracking shot #1"\n'
    "  audios:\n"
    '    "<Audio 1>":\n'
    '      caption: "Rain and a station announcement"\n'
    '      source_video: "<Video 1>"\n'
    '    "<Audio 2>":\n'
    '      caption: "Sparse piano"\n'
    "\n"
    "generation_directives:\n"
    '  detailed_description: "<Subject 1> uses <Picture 1> carefully"\n'
    '  non_diegetic_music: "N/A"'
  )
  assert "schema_version" not in exported
  assert "\nprompt:" not in exported
  assert "prompt_schema_preset" not in exported
  parsed = yaml.safe_load(exported)
  assert list(parsed) == [
    "video_duration_seconds",
    "mode",
    "language",
    "requirements",
    "references",
    "generation_directives",
  ]
  assert parsed["video_duration_seconds"] == 8.5
  assert parsed["references"]["images"]["<Picture 1>"] == (
    "Woman at a station:\nwearing a black coat"
  )
  assert (
    len(
      module.ReferenceLoaderExportPromptForLLMNode.fingerprint_inputs(
        bundle,
        seconds=8.5,
        additional_yaml=additional_yaml,
      )
    )
    == 64
  )


def test_export_prompt_for_llm_emits_empty_collections():
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )
  bundle_type = importlib.import_module("backend.nodes.reference_bundle")
  bundle = bundle_type.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=(),
    audio_captions=(),
    videos=(),
    video_captions=(),
    manifest_json=json.dumps(
      {
        "version": 1,
        "video_audio_policy": "preserve",
        "image_output": {"mode": "original", "alphaMode": "preserve"},
        "image_order": [],
        "video_order": [],
        "audio_order": [],
        "outputs": {"images": [], "audios": [], "videos": []},
        "output_captions": {"images": [], "audios": [], "videos": []},
        "items": {},
      }
    ),
  )

  prompt, references_yaml, generation_directives_yaml = (
    module.export_prompt_parts_for_llm(bundle)
  )
  assert prompt == (
    "video_duration_seconds: 6.0\n"
    "\n"
    "references:\n"
    "  images: {}\n"
    "  videos: {}\n"
    "  audios: {}\n"
    "\n"
    "generation_directives: {}"
  )
  assert references_yaml == ("references:\n  images: {}\n  videos: {}\n  audios: {}")
  assert generation_directives_yaml == "generation_directives: {}"
  assert module.export_prompt_for_llm(bundle) == prompt


@pytest.mark.parametrize(
  ("additional_yaml", "message"),
  [
    ("references: {}", "reserved top-level key"),
    ("mode: first\nmode: second", "duplicate key"),
    ("- item", "top-level mapping"),
    ("mode: first\n---\nmode: second", "single-document YAML"),
    ("base: &base\n  mode: first\ncopy: *base", "anchors are not supported"),
    ("released: 2026-08-17", "unsupported YAML value date"),
  ],
)
def test_export_prompt_for_llm_rejects_invalid_additional_yaml(
  additional_yaml,
  message,
):
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )

  with pytest.raises((TypeError, ValueError), match=message):
    module.export_prompt_for_llm(_bundle(module), additional_yaml=additional_yaml)


@pytest.mark.parametrize("seconds", [3.99, 15.01, float("nan"), True])
def test_export_prompt_for_llm_rejects_invalid_seconds(seconds):
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )

  with pytest.raises(ValueError, match="seconds"):
    module.export_prompt_for_llm(_bundle(module), seconds=seconds)


def test_export_prompt_for_llm_rejects_misaligned_prompt():
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )
  bundle = _bundle(module)
  mismatched = module.ReferenceLoaderBundle(
    images=bundle.images,
    image_captions=bundle.image_captions,
    audios=bundle.audios,
    audio_captions=bundle.audio_captions,
    videos=bundle.videos,
    video_captions=bundle.video_captions,
    manifest_json=bundle.manifest_json,
    prompt_state_json=bundle.prompt_state_json,
    compiled_prompt="wrong",
  )

  with pytest.raises(ValueError, match="prompt state"):
    module.ReferenceLoaderExportPromptForLLMNode.execute(mismatched)
