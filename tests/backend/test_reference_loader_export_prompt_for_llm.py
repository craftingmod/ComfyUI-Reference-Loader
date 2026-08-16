import importlib
import json

import pytest


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
    '{"sections":[{"parts":[{"text":"Use ","type":"text"},'
    '{"label":"image1","mediaKind":"image","referenceId":"image",'
    '"type":"mention"},{"text":" carefully","type":"text"}],'
    '"title":"detailed_description"},{"parts":[{"text":"N/A",'
    '"type":"text"}],"title":"non_diegetic_music"}],"version":3}'
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
      "detailed_description:\nUse <Picture 1> carefully\n\nnon_diegetic_music:\nN/A"
    ),
  )


def test_export_prompt_for_llm_schema_and_strict_yaml():
  module = importlib.import_module(
    "backend.nodes.reference_loader_export_prompt_for_llm"
  )
  schema = module.ReferenceLoaderExportPromptForLLMNode.define_schema()

  assert schema.node_id == "Alyac_ReferenceLoaderExportPromptForLLM"
  assert schema.display_name == "Reference Loader Export Prompt for LLM"
  assert schema.category == "reference/output"
  assert [field.name for field in schema.inputs] == ["references"]
  assert schema.inputs[0].data_type == "REFERENCE_LOADER_BUNDLE"
  assert [field.name for field in schema.outputs] == ["prompt"]
  assert schema.outputs[0].data_type == "string"

  bundle = _bundle(module)
  exported = module.ReferenceLoaderExportPromptForLLMNode.execute(bundle)[0]
  assert exported == (
    "schema_version: 1\n"
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
    '  detailed_description: "Use <Picture 1> carefully"\n'
    '  non_diegetic_music: "N/A"'
  )
  assert "\nprompt:" not in exported
  assert "prompt_schema_preset" not in exported
  assert (
    len(module.ReferenceLoaderExportPromptForLLMNode.fingerprint_inputs(bundle)) == 64
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

  assert module.export_prompt_for_llm(bundle) == (
    "schema_version: 1\n"
    "\n"
    "references:\n"
    "  images: {}\n"
    "  videos: {}\n"
    "  audios: {}\n"
    "\n"
    "generation_directives: {}"
  )


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
