import importlib
import json
from types import SimpleNamespace
from typing import ClassVar

import pytest
from comfy_api.latest import io


def _field_type(name):
  return getattr(io, name)


class FakeFrames:
  def __init__(self, count):
    self.shape = (count, 2, 3, 3)

  def __getitem__(self, indices):
    return tuple(indices)


class FakeVideo:
  def __init__(self, count, frame_rate):
    self.frames = FakeFrames(count)
    self.frame_rate = frame_rate

  def get_components(self):
    return SimpleNamespace(images=self.frames, frame_rate=self.frame_rate)


class FakeMiniMaxH3:
  calls: ClassVar[list[dict]] = []

  @classmethod
  def define_schema(cls):
    return io.Schema(
      inputs=[
        _field_type("Clip").Input("clip"),
        _field_type("Vae").Input("vae"),
        _field_type("Vae").Input("audio_vae"),
        _field_type("String").Input("prompt"),
        _field_type("Int").Input("width"),
        _field_type("Int").Input("height"),
        _field_type("Int").Input("length"),
        _field_type("Combo").Input("ref_image_size"),
        _field_type("Image").Input("ref_images"),
      ],
      outputs=[
        _field_type("Conditioning").Output("positive"),
        _field_type("Latent").Output("LATENT"),
      ],
    )

  @classmethod
  def execute(cls, **kwargs):
    cls.calls.append(kwargs)
    return io.NodeOutput("conditioning", "latent")


def _bundle(module):
  manifest = {
    "outputs": {
      "images": ["image-1"],
      "videos": ["video-1"],
      "audios": ["video-1:audio", "video-2:audio", "audio-1"],
    }
  }
  return module.ReferenceLoaderBundle(
    images=("image",),
    image_captions=("image caption",),
    audios=("paired", "audio-only video", "standalone"),
    audio_captions=("paired", "audio-only video", "standalone"),
    videos=(FakeVideo(30, 30),),
    video_captions=("video caption",),
    manifest_json=json.dumps(manifest),
  )


def test_wrapper_schema_reuses_native_controls(monkeypatch):
  module = importlib.import_module("backend.nodes.minimax_h3_reference_wrapper")
  monkeypatch.setattr(module, "_minimax_h3_node", lambda: FakeMiniMaxH3)

  schema = module.MiniMaxH3ReferenceToVideoWrapperNode.define_schema()

  assert schema.node_id == "Alyac_MiniMaxH3ReferenceToVideoWrapper"
  assert schema.display_name == "[Reference Loader] MiniMax H3 Wrapper"
  assert [field.name for field in schema.inputs] == [
    "clip",
    "vae",
    "audio_vae",
    "references",
    "prompt",
    "width",
    "height",
    "length",
    "ref_image_size",
  ]
  assert schema.inputs[3].data_type == "REFERENCE_LOADER_BUNDLE"
  assert [field.data_type for field in schema.outputs] == ["conditioning", "latent"]


def test_wrapper_maps_toggle_policy_and_samples_video_at_24fps(monkeypatch):
  module = importlib.import_module("backend.nodes.minimax_h3_reference_wrapper")
  FakeMiniMaxH3.calls.clear()
  monkeypatch.setattr(module, "_minimax_h3_node", lambda: FakeMiniMaxH3)

  output = module.MiniMaxH3ReferenceToVideoWrapperNode.execute(
    clip="clip",
    vae="vae",
    audio_vae="audio vae",
    references=_bundle(module),
    prompt="<Audio 1> then <Audio 2> and <Audio 3>",
    width=1344,
    height=768,
    length=124,
    ref_image_size="match",
  )

  assert output == ("conditioning", "latent")
  call = FakeMiniMaxH3.calls[-1]
  assert call["prompt"] == "<Audio 1> then <Audio 2> and <Audio 3>"
  assert call["ref_images"] == {"ref_image_0": "image"}
  assert call["ref_videos"]["ref_video_0"] == tuple(
    min(29, index * 30 // 24) for index in range(24)
  )
  assert call["ref_video_audios"] == {"ref_video_audio_0": "paired"}
  assert call["ref_audios"] == {
    "ref_audio_0": "audio-only video",
    "ref_audio_1": "standalone",
  }


def test_wrapper_remaps_loader_audio_order_to_h3_presentation_order(monkeypatch):
  module = importlib.import_module("backend.nodes.minimax_h3_reference_wrapper")
  FakeMiniMaxH3.calls.clear()
  monkeypatch.setattr(module, "_minimax_h3_node", lambda: FakeMiniMaxH3)
  manifest = {
    "outputs": {
      "images": [],
      "videos": ["video-1"],
      "audios": ["audio-1", "video-1:audio"],
    }
  }
  bundle = module.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=("standalone", "paired"),
    audio_captions=("standalone", "paired"),
    videos=(FakeVideo(24, 24),),
    video_captions=("video",),
    manifest_json=json.dumps(manifest),
  )

  module.MiniMaxH3ReferenceToVideoWrapperNode.execute(
    clip="clip",
    vae="vae",
    audio_vae="audio vae",
    references=bundle,
    prompt="Use <Audio 1>, <Audio 2>, and leave <Audio 10> unchanged.",
    width=1344,
    height=768,
    length=124,
  )

  call = FakeMiniMaxH3.calls[-1]
  assert call["prompt"] == ("Use <Audio 2>, <Audio 1>, and leave <Audio 10> unchanged.")
  assert call["ref_video_audios"] == {"ref_video_audio_0": "paired"}
  assert call["ref_audios"] == {"ref_audio_0": "standalone"}


def test_wrapper_remaps_multiple_soundtracks_in_video_order(monkeypatch):
  module = importlib.import_module("backend.nodes.minimax_h3_reference_wrapper")
  FakeMiniMaxH3.calls.clear()
  monkeypatch.setattr(module, "_minimax_h3_node", lambda: FakeMiniMaxH3)
  manifest = {
    "outputs": {
      "images": [],
      "videos": ["video-2", "video-1"],
      "audios": [
        "video-1:audio",
        "video-3:audio",
        "video-2:audio",
        "audio-1",
      ],
    }
  }
  bundle = module.ReferenceLoaderBundle(
    images=(),
    image_captions=(),
    audios=("video one", "audio-only video", "video two", "standalone"),
    audio_captions=("video one", "audio-only video", "video two", "standalone"),
    videos=(FakeVideo(24, 24), FakeVideo(24, 24)),
    video_captions=("video two", "video one"),
    manifest_json=json.dumps(manifest),
  )

  module.MiniMaxH3ReferenceToVideoWrapperNode.execute(
    clip="clip",
    vae="vae",
    audio_vae="audio vae",
    references=bundle,
    prompt="<Audio 1> <Audio 2> <Audio 3> <Audio 4>",
    width=1344,
    height=768,
    length=124,
  )

  call = FakeMiniMaxH3.calls[-1]
  assert call["prompt"] == "<Audio 2> <Audio 3> <Audio 1> <Audio 4>"
  assert call["ref_video_audios"] == {
    "ref_video_audio_0": "video two",
    "ref_video_audio_1": "video one",
  }
  assert call["ref_audios"] == {
    "ref_audio_0": "audio-only video",
    "ref_audio_1": "standalone",
  }


def test_wrapper_rejects_manifest_alignment_mismatch(monkeypatch):
  module = importlib.import_module("backend.nodes.minimax_h3_reference_wrapper")
  monkeypatch.setattr(module, "_minimax_h3_node", lambda: FakeMiniMaxH3)
  bundle = _bundle(module)
  bundle = module.ReferenceLoaderBundle(
    images=bundle.images,
    image_captions=bundle.image_captions,
    audios=bundle.audios,
    audio_captions=bundle.audio_captions,
    videos=(),
    video_captions=(),
    manifest_json=bundle.manifest_json,
  )

  with pytest.raises(ValueError, match="outputs.videos"):
    module.MiniMaxH3ReferenceToVideoWrapperNode.execute(
      clip=None,
      vae=None,
      audio_vae=None,
      references=bundle,
      prompt="",
      width=1344,
      height=768,
      length=124,
    )
