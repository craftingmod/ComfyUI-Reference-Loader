import json

import pytest

from backend.core.prompt_contract import (
  PromptContractError,
  compile_prompt_state,
  parse_prompt_state,
  serialize_prompt_document,
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
        }
      },
      "imageOrder": ["image-a"],
      "videoOrder": [],
      "audioOrder": [],
      "videoAudioPolicy": "preserve",
    }
  )


def test_compiles_subject_and_shot_tags_only_at_the_output_boundary():
  document = {
    "version": 5,
    "view": "structured",
    "subjects": [{"tag": "hero", "parts": [{"type": "text", "text": "red coat"}]}],
    "shots": [
      {
        "tag": "opening",
        "frameIndex": 49,
        "parts": [{"type": "text", "text": "#hero enters"}],
      }
    ],
    "sections": [
      {"title": "scene", "parts": [{"type": "text", "text": "#hero waits"}]}
    ],
  }
  parsed = parse_prompt_state(document)
  assert json.loads(serialize_prompt_document(parsed))["shots"][0]["frameIndex"] == 49
  assert compile_prompt_state(document, reference_state()) == (
    "subject_definitions:\n<Subject 1>: red coat\n\n"
    "scene:\n<Subject 1> waits\n\n"
    "timeline_direction:\n[Shot 1]\nAt 2.042 seconds: <Subject 1> enters"
  )


def test_accepts_cross_kind_references_and_rejects_duplicate_tags_or_unsafe_frames():
  base = {
    "version": 5,
    "subjects": [{"tag": "hero", "parts": []}],
    "shots": [{"tag": "opening", "frameIndex": 0, "parts": []}],
    "sections": [],
  }
  assert parse_prompt_state(
    {
      **base,
      "subjects": [{"tag": "hero", "parts": [{"type": "text", "text": "#opening"}]}],
      "shots": [
        {
          "tag": "opening",
          "frameIndex": 0,
          "parts": [{"type": "text", "text": "#hero"}],
        }
      ],
    }
  )
  with pytest.raises(PromptContractError, match="must be unique"):
    parse_prompt_state(
      {**base, "shots": [{"tag": "hero", "frameIndex": 0, "parts": []}]}
    )
  with pytest.raises(PromptContractError, match="safe integer"):
    parse_prompt_state(
      {**base, "shots": [{"tag": "opening", "frameIndex": 2**53, "parts": []}]}
    )
