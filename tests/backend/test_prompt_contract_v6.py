import json

import pytest

from backend.core.prompt_contract import (
  EMPTY_PROMPT_STATE_JSON,
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


def document():
  return {
    "version": 6,
    "view": "structured",
    "subjects": [
      {
        "id": "subject-1",
        "tag": "hero",
        "parts": [{"type": "text", "text": "red coat"}],
      }
    ],
    "shots": [
      {
        "id": "shot-1",
        "tag": "opening",
        "frameIndex": 49,
        "parts": [{"type": "definition-ref", "definitionId": "subject-1"}],
      }
    ],
    "sections": [
      {
        "id": "section-1",
        "title": "scene",
        "parts": [
          {"type": "text", "text": "Meet "},
          {"type": "definition-ref", "definitionId": "subject-1"},
          {"type": "text", "text": " at "},
          {
            "type": "mention",
            "referenceId": "image-a",
            "mediaKind": "image",
            "label": "image1",
          },
        ],
      }
    ],
  }


def test_empty_prompt_default_uses_v6_contract():
  assert json.loads(EMPTY_PROMPT_STATE_JSON)["version"] == 6


def test_v6_preserves_ids_and_compiles_definition_refs_directly():
  parsed = parse_prompt_state(document())
  assert (
    json.loads(serialize_prompt_document(parsed))["subjects"][0]["id"] == "subject-1"
  )
  assert compile_prompt_state(document(), reference_state()) == (
    "subject_definitions:\n<Subject 1>: red coat\n\n"
    "scene:\nMeet <Subject 1> at <Picture 1>\n\n"
    "timeline_direction:\n[Shot 1]\nAt 2.042 seconds: <Subject 1>"
  )


def test_v6_rejects_duplicate_ids_and_missing_definition_refs():
  with pytest.raises(PromptContractError, match="must be unique"):
    parse_prompt_state(
      {
        **document(),
        "shots": [{**document()["shots"][0], "id": "subject-1"}],
      }
    )
  with pytest.raises(PromptContractError, match="does not reference a definition"):
    parse_prompt_state(
      {
        **document(),
        "sections": [
          {
            **document()["sections"][0],
            "parts": [{"type": "definition-ref", "definitionId": "missing"}],
          }
        ],
      }
    )
