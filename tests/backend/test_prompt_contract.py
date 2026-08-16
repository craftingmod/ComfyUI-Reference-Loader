import json

import pytest

from backend.core.prompt_contract import (
  PromptContractError,
  compile_prompt_state,
  parse_prompt_state,
)
from backend.core.reference_contract import parse_reference_state


def reference_state():
  return parse_reference_state(
    {
      "version": 1,
      "items": {
        "image-a": {
          "id": "image-a",
          "kind": "image",
          "source": {
            "path": "reference_loader/sources/a.png",
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
            "path": "reference_loader/sources/b.png",
            "mime": "image/png",
            "sha256": "b" * 64,
          },
          "caption": "",
          "imageEnabled": False,
        },
        "video-a": {
          "id": "video-a",
          "kind": "video",
          "source": {
            "path": "reference_loader/sources/a.mp4",
            "mime": "video/mp4",
            "sha256": "c" * 64,
          },
          "caption": "",
          "videoEnabled": True,
          "audioEnabled": True,
        },
        "audio-a": {
          "id": "audio-a",
          "kind": "audio",
          "source": {
            "path": "reference_loader/sources/a.wav",
            "mime": "audio/wav",
            "sha256": "d" * 64,
          },
          "caption": "",
          "audioEnabled": True,
        },
      },
      "imageOrder": ["image-b", "image-a"],
      "videoOrder": ["video-a"],
      "audioOrder": ["video-a", "audio-a"],
      "videoAudioPolicy": "preserve",
    }
  )


def test_compiles_stable_mentions_against_active_per_type_orders():
  document = {
    "version": 1,
    "view": "structured",
    "parts": [
      {"type": "text", "text": "A "},
      {
        "type": "mention",
        "referenceId": "image-a",
        "mediaKind": "image",
        "label": "image1",
      },
      {"type": "text", "text": " watches "},
      {
        "type": "mention",
        "referenceId": "video-a",
        "mediaKind": "video",
        "label": "video1",
      },
      {"type": "text", "text": " with "},
      {
        "type": "mention",
        "referenceId": "video-a:audio",
        "mediaKind": "audio",
        "label": "audio1",
      },
      {"type": "text", "text": " and "},
      {
        "type": "mention",
        "referenceId": "audio-a",
        "mediaKind": "audio",
        "label": "audio2",
      },
      {"type": "dialogue", "text": "안녕하세요"},
      {
        "type": "directive",
        "kind": "audio",
        "parts": [
          {"type": "text", "text": "No music for "},
          {
            "type": "mention",
            "referenceId": "image-a",
            "mediaKind": "image",
            "label": "image1",
          },
        ],
      },
      {"type": "directive", "kind": "style", "text": "Soft 3D"},
    ],
  }
  assert compile_prompt_state(json.dumps(document), reference_state()) == (
    "A <Picture 1> watches <Video 1> with <Audio 1> and <Audio 2><d>안녕하세요</d>"
    "<audio>No music for <Picture 1></audio><style>Soft 3D</style>"
  )


def test_unavailable_mentions_remain_visible_without_rebinding_to_another_item():
  document = {
    "version": 1,
    "parts": [
      {
        "type": "mention",
        "referenceId": "image-b",
        "mediaKind": "image",
        "label": "disabled-image",
      }
    ],
  }
  assert compile_prompt_state(document, reference_state()) == "@disabled-image"


def test_accepts_literal_prompt_strings_and_rejects_invalid_structured_state():
  assert compile_prompt_state("literal text", reference_state()) == "literal text"
  with pytest.raises(PromptContractError, match="prompt.parts"):
    parse_prompt_state(json.dumps({"version": 1, "parts": "invalid"}))
  with pytest.raises(PromptContractError, match="must be audio or style"):
    parse_prompt_state(
      {"version": 1, "parts": [{"type": "directive", "kind": "camera", "text": ""}]}
    )
