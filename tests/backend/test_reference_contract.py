import copy
import json

import pytest

from backend.core.reference_contract import (
  ReferenceContractError,
  execution_fingerprint,
  execution_projection,
  parse_reference_state,
)
from backend.core.reference_manifest import (
  build_reference_manifest,
  build_reference_output_plan,
  parse_reference_manifest_state,
)

HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
HASH_D = "d" * 64


def loader_state():
  return {
    "version": 1,
    "items": {
      "img-a": {
        "id": "img-a",
        "kind": "image",
        "source": {
          "path": f"reference_loader/sources/{HASH_A}.png",
          "mime": "image/png",
          "sha256": HASH_A,
          "size": 123,
        },
        "caption": "image caption",
        "imageEnabled": True,
        "edit": {
          "crop": {"x": 0.1, "y": 0.2, "width": 0.8, "height": 0.7},
          "flipX": True,
          "removeBackground": True,
          "background": {"mode": "transparent", "color": "#FFFFFF"},
          "mask": {
            "path": f"reference_loader/sources/{HASH_D}.png",
            "mime": "image/png",
            "sha256": HASH_D,
          },
          "maskMode": "keep",
          "revision": 2,
        },
      },
      "aud-b": {
        "id": "aud-b",
        "kind": "audio",
        "source": {
          "path": f"reference_loader/sources/{HASH_B}.wav",
          "mime": "audio/wav",
          "sha256": HASH_B,
        },
        "caption": "disabled audio",
        "audioEnabled": False,
        "crop": {"start": 0.25, "end": 1.5},
      },
      "vid-c": {
        "id": "vid-c",
        "kind": "video",
        "source": {
          "path": f"reference_loader/sources/{HASH_C}.mp4",
          "mime": "video/mp4",
          "sha256": HASH_C,
        },
        "caption": "video caption",
        "audioCaptionOverride": "video audio caption",
        "videoEnabled": False,
        "audioEnabled": True,
        "crop": {"start": 1.0, "end": 3.0},
      },
    },
    "imageOrder": ["img-a"],
    "videoOrder": ["vid-c"],
    "audioOrder": ["aud-b", "vid-c"],
    "videoAudioPolicy": "preserve",
    "ui": {
      "cardAspectRatio": "4 / 3",
      "previewMaxPixels": 1_000_000,
      "waveformPeaks": 300,
    },
  }


def test_contract_projection_is_deterministic_and_excludes_ui_state():
  first = loader_state()
  second = copy.deepcopy(first)
  second["ui"] = {"cardAspectRatio": "1 / 1", "previewMaxPixels": 10}

  parsed = parse_reference_state(json.dumps(first))
  assert execution_fingerprint(parsed) == execution_fingerprint(
    parse_reference_state(second)
  )
  projection = execution_projection(parsed)
  assert "ui" not in projection
  assert projection["imageOrder"] == ["img-a"]
  assert projection["videoOrder"] == ["vid-c"]
  assert [item["id"] for item in projection["images"]] == ["img-a"]
  assert [item["id"] for item in projection["videos"]] == ["vid-c"]
  assert [item["id"] for item in projection["audios"]] == [
    "aud-b",
    "vid-c:audio",
  ]
  assert projection["audios"][1]["derivedFrom"] == "vid-c"
  assert projection["images"][0]["edit"]["mask"]["sha256"] == HASH_D
  assert projection["images"][0]["edit"]["removeBackground"] is True


def test_h3_output_settings_are_execution_visible_and_round_trip_through_manifest():
  raw = loader_state()
  raw["h3Output"] = {
    "fps": 24,
    "totalFrames": 203,
    "resolutionMultiple": 64,
    "frameModulo": 10,
    "frameRemainder": 3,
    "width": 1024,
    "height": 576,
    "mode": "manual",
    "imageId": None,
    "aspect": "16:9",
    "targetMegapixels": 1.234,
  }
  state = parse_reference_state(raw)

  assert state.h3_output.fps == 24
  assert state.h3_output.total_frames == 203
  assert state.h3_output.resolution_multiple == 64
  assert state.h3_output.frame_modulo == 10
  assert state.h3_output.frame_remainder == 3
  assert state.h3_output.width == 1024
  assert state.h3_output.height == 576
  assert execution_projection(state)["h3Output"] == raw["h3Output"]

  changed = copy.deepcopy(raw)
  changed["h3Output"]["width"] = 1088
  assert execution_fingerprint(state) != execution_fingerprint(
    parse_reference_state(changed)
  )

  manifest = build_reference_manifest(state)
  assert manifest["h3_output"] == {
    "fps": 24,
    "total_frames": 203,
    "resolution_multiple": 64,
    "frame_modulo": 10,
    "frame_remainder": 3,
    "width": 1024,
    "height": 576,
    "mode": "manual",
    "image_id": None,
    "aspect": "16:9",
    "target_megapixels": 1.234,
  }
  assert parse_reference_manifest_state(manifest).h3_output == state.h3_output


def test_h3_output_dimensions_migrate_when_older_state_omits_them():
  raw = loader_state()
  raw["h3Output"] = {"fps": 24, "totalFrames": 124}

  state = parse_reference_state(raw)

  assert state.h3_output.width == 1344
  assert state.h3_output.height == 768


@pytest.mark.parametrize(
  ("field", "value"),
  [("width", 31), ("width", 33), ("height", 16_385), ("height", True)],
)
def test_h3_output_dimensions_require_configured_resolution_steps(field, value):
  raw = loader_state()
  raw["h3Output"] = {"fps": 24, "totalFrames": 124, "width": 1344, "height": 768}
  raw["h3Output"][field] = value

  with pytest.raises(ReferenceContractError, match=f"h3_output\\.{field}"):
    parse_reference_state(raw)


@pytest.mark.parametrize(
  ("mutate", "match"),
  [
    (
      lambda state: state["items"]["img-a"]["source"].update(path="../secret.png"),
      "path",
    ),
    (lambda state: state.update(imageOrder=["img-a", "img-a"]), "duplicate"),
    (lambda state: state.update(audioOrder=["aud-b"]), "missing"),
    (
      lambda state: state["items"]["vid-c"].update(crop={"start": 3.0, "end": 2.0}),
      "start < end",
    ),
    (lambda state: state["items"]["img-a"].update(id="other"), "map key"),
  ],
)
def test_contract_rejects_invalid_paths_orders_ids_and_crops(mutate, match):
  state = loader_state()
  mutate(state)
  with pytest.raises(ReferenceContractError, match=match):
    parse_reference_state(state)


def test_manifest_keeps_disabled_items_and_aligns_active_ids_and_captions():
  state = parse_reference_state(loader_state())
  plan = build_reference_output_plan(state)
  manifest = build_reference_manifest(state)

  assert plan.image_ids == ("img-a",)
  assert plan.image_captions == ("image caption",)
  assert plan.audio_ids == ("vid-c:audio",)
  assert plan.audio_captions == ("video audio caption",)
  assert plan.video_ids == ()
  assert manifest["image_order"] == ["img-a"]
  assert manifest["video_order"] == ["vid-c"]
  assert manifest["audio_order"] == ["aud-b", "vid-c"]
  assert manifest["outputs"] == {
    "images": ["img-a"],
    "audios": ["vid-c:audio"],
    "videos": [],
  }
  assert manifest["image_output"] == {
    "mode": "original",
    "alphaMode": "preserve",
  }
  assert manifest["items"]["aud-b"]["enabled"] == {"audio": False}
  assert manifest["items"]["img-a"]["enabled"] == {"image": True}
  assert manifest["items"]["vid-c"]["enabled"] == {
    "video": False,
    "video_audio": True,
    "audio": True,
  }
  assert manifest["items"]["vid-c:audio"]["derived_from"] == "vid-c"
  assert manifest["items"]["img-a"]["edit"]["maskMode"] == "keep"
  serialized = json.dumps(manifest)
  assert "payload" not in serialized
  assert "C:\\" not in serialized


def test_video_audio_defaults_true_and_round_trips_from_manifest():
  state = parse_reference_state(loader_state())
  assert state.items["vid-c"].video_audio_enabled is True

  manifest = build_reference_manifest(state)
  assert manifest["items"]["vid-c"]["enabled"]["video_audio"] is True
  manifest["items"]["vid-c"]["enabled"].pop("video_audio")
  restored = parse_reference_manifest_state(manifest)
  assert restored.items["vid-c"].video_audio_enabled is True


def test_video_audio_is_strict_and_part_of_the_execution_fingerprint():
  enabled = parse_reference_state(loader_state())
  disabled_raw = loader_state()
  disabled_raw["items"]["vid-c"]["videoAudioEnabled"] = False
  disabled = parse_reference_state(disabled_raw)

  assert enabled.items["vid-c"].video_audio_enabled is True
  assert disabled.items["vid-c"].video_audio_enabled is False
  assert execution_fingerprint(enabled) != execution_fingerprint(disabled)

  invalid_raw = loader_state()
  invalid_raw["items"]["vid-c"]["videoAudioEnabled"] = "false"
  with pytest.raises(ReferenceContractError, match="videoAudioEnabled.*boolean"):
    parse_reference_state(invalid_raw)


def test_contract_requires_a_safe_image_descriptor_for_edit_masks():
  state = loader_state()
  state["items"]["img-a"]["edit"]["mask"]["path"] = "../mask.png"
  with pytest.raises(ReferenceContractError, match="mask.path"):
    parse_reference_state(state)

  state = loader_state()
  state["items"]["img-a"]["edit"]["mask"].pop("mime")
  with pytest.raises(ReferenceContractError, match="mask.mime"):
    parse_reference_state(state)


def test_h3_timeline_round_trips_without_changing_reference_outputs():
  raw = loader_state()
  raw["h3Timeline"] = {
    "version": 1,
    "enabled": True,
    "startImageId": "img-a",
    "endImageId": None,
    "disabledVisualIds": ["img-a"],
    "disabledAudioIds": ["aud-b"],
    "guides": [
      {
        "id": "guide-middle",
        "frameIndex": 48,
        "visualId": None,
        "audioId": "aud-b",
      }
    ],
  }
  state = parse_reference_state(raw)
  assert state.h3_timeline.guides[0].frame_index == 48
  assert state.h3_timeline.guides[0].audio_id == "aud-b"
  assert state.h3_timeline.disabled_visual_ids == ("img-a",)
  assert state.h3_timeline.disabled_audio_ids == ("aud-b",)
  assert execution_projection(state)["h3Timeline"] == raw["h3Timeline"]

  manifest = build_reference_manifest(state)
  restored = parse_reference_manifest_state(manifest)
  assert restored.h3_timeline == state.h3_timeline
  assert build_reference_output_plan(restored) == build_reference_output_plan(state)


@pytest.mark.parametrize(
  ("field", "value", "match"),
  [
    ("startImageId", "vid-c", "startImageId"),
    ("audioId", "img-a", "audioId"),
    ("frameIndex", True, "frameIndex"),
    ("id", "bad id", "stable identifier"),
  ],
)
def test_h3_timeline_rejects_invalid_media_types_and_frame_values(field, value, match):
  raw = loader_state()
  raw["h3Timeline"] = {
    "version": 1,
    "enabled": True,
    "startImageId": None,
    "endImageId": None,
    "guides": [
      {
        "id": "guide-middle",
        "frameIndex": 48,
        "visualId": None,
        "audioId": None,
      }
    ],
  }
  if field in {"audioId", "frameIndex", "id"}:
    raw["h3Timeline"]["guides"][0][field] = value
  else:
    raw["h3Timeline"][field] = value
  with pytest.raises(ReferenceContractError, match=match):
    parse_reference_state(raw)


@pytest.mark.parametrize(
  ("field", "value"),
  [("visualId", "vid-c"), ("audioId", "vid-c:audio")],
)
def test_h3_timeline_rejects_video_and_video_derived_audio_guides(field, value):
  raw = loader_state()
  raw["h3Timeline"] = {
    "version": 1,
    "enabled": True,
    "startImageId": None,
    "endImageId": None,
    "guides": [
      {
        "id": "guide-middle",
        "frameIndex": 48,
        "visualId": None,
        "audioId": None,
      }
    ],
  }
  raw["h3Timeline"]["guides"][0][field] = value
  with pytest.raises(ReferenceContractError, match=field):
    parse_reference_state(raw)
