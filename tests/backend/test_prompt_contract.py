import pytest

from backend.core.prompt_contract import (
  PromptContractError,
  compile_prompt,
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
          "imageEnabled": True,
        },
      },
      "imageOrder": ["image-b", "image-a"],
      "videoOrder": [],
      "audioOrder": [],
      "videoAudioPolicy": "preserve",
    }
  )


def document():
  return {
    "version": 6,
    "view": "structured",
    "subjects": [],
    "shots": [],
    "sections": [
      {
        "id": "section-1",
        "title": "scene",
        "parts": [
          {"type": "text", "text": "Meet "},
          {
            "type": "mention",
            "referenceId": "removed-image",
            "mediaKind": "image",
            "label": "image1",
          },
        ],
      }
    ],
  }


def test_compiles_v6_mentions_without_promoting_text():
  assert compile_prompt(parse_prompt_state(document()), reference_state()) == (
    "scene:\nMeet @image1"
  )


@pytest.mark.parametrize(
  "value",
  [
    "literal text",
    {"version": 3, "subjects": [], "sections": []},
    {"version": 4, "subjects": [], "sections": []},
    {"version": 5, "subjects": [], "shots": [], "sections": []},
  ],
)
def test_rejects_non_v6_prompt_state(value):
  with pytest.raises(PromptContractError, match="v6 JSON|must equal 6"):
    parse_prompt_state(value)


def test_rejects_v6_definitions_without_stable_ids():
  with pytest.raises(PromptContractError, match="must be a string|stable identity"):
    parse_prompt_state(
      {
        "version": 6,
        "view": "structured",
        "subjects": [{"tag": "hero", "parts": []}],
        "shots": [],
        "sections": [],
      }
    )
