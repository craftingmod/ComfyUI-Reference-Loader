import json

import pytest

from backend.core.prompt_contract import (
  PromptContractError,
  compile_prompt,
  compile_prompt_state,
  parse_prompt_state,
  rebind_prompt_mentions_by_order,
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
    "version": 4,
    "view": "structured",
    "subjects": [
      {"subjectId": "woman", "label": "woman"},
      {"subjectId": "station", "label": "station"},
    ],
    "sections": [
      {
        "title": "integrated_multimodal_description",
        "parts": [
          {"type": "text", "text": "A "},
          {"type": "subject", "subjectId": "woman", "label": "woman"},
          {"type": "text", "text": " from "},
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
          {"type": "text", "text": "안녕하세요"},
        ],
      },
      {
        "title": "visual_style",
        "parts": [{"type": "text", "text": "Soft 3D"}],
      },
      {
        "title": "overall_soundscape",
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
    ],
  }
  assert compile_prompt_state(json.dumps(document), reference_state()) == (
    "integrated_multimodal_description:\n"
    "A <Subject 1> from <Picture 1> watches <Video 1> with <Audio 1> and <Audio 2>안녕하세요"
    "\n\nvisual_style:\nSoft 3D"
    "\n\noverall_soundscape:\nNo music for <Picture 1>"
  )


def test_unavailable_mentions_remain_visible_without_rebinding_to_another_item():
  document = {
    "version": 4,
    "subjects": [],
    "sections": [
      {
        "title": "scene",
        "parts": [
          {
            "type": "mention",
            "referenceId": "image-b",
            "mediaKind": "image",
            "label": "disabled-image",
          }
        ],
      }
    ],
  }
  assert compile_prompt_state(document, reference_state()) == "scene:\n@disabled-image"


def test_rebinds_standard_mention_labels_to_current_output_positions():
  document = parse_prompt_state(
    {
      "version": 4,
      "subjects": [],
      "sections": [
        {
          "title": "scene",
          "parts": [
            {
              "type": "mention",
              "referenceId": "removed-image",
              "mediaKind": "image",
              "label": "image1",
            },
            {"type": "text", "text": " and "},
            {
              "type": "mention",
              "referenceId": "removed-audio",
              "mediaKind": "audio",
              "label": "audio2",
            },
          ],
        }
      ],
    }
  )

  rebound = rebind_prompt_mentions_by_order(document, reference_state())

  assert rebound.sections[0].parts[0].reference_id == "image-a"
  assert rebound.sections[0].parts[2].reference_id == "audio-a"
  assert compile_prompt(rebound, reference_state()) == (
    "scene:\n<Picture 1> and <Audio 2>"
  )


def test_accepts_literal_prompt_strings_and_rejects_invalid_structured_state():
  assert (
    compile_prompt_state("literal text", reference_state()) == "scene:\nliteral text"
  )
  with pytest.raises(PromptContractError, match="prompt.sections"):
    parse_prompt_state(
      json.dumps({"version": 4, "subjects": [], "sections": "invalid"})
    )
  with pytest.raises(PromptContractError, match="lowercase snake_case"):
    parse_prompt_state(
      {
        "version": 4,
        "subjects": [],
        "sections": [{"title": "Bad Title", "parts": []}],
      }
    )
  with pytest.raises(PromptContractError, match="must be text, mention, or subject"):
    parse_prompt_state(
      {
        "version": 4,
        "subjects": [],
        "sections": [
          {
            "title": "scene",
            "parts": [{"type": "dialogue", "text": "removed"}],
          }
        ],
      }
    )
  with pytest.raises(PromptContractError, match="letters, numbers"):
    parse_prompt_state(
      {
        "version": 4,
        "subjects": [{"subjectId": "bad", "label": "bad label"}],
        "sections": [],
      }
    )


def test_rejects_version_3_prompt_state_without_migration():
  with pytest.raises(PromptContractError, match="prompt.version: must equal 4"):
    parse_prompt_state({"version": 3, "subjects": [], "sections": []})


def test_rejects_duplicate_section_titles():
  with pytest.raises(PromptContractError, match="must be unique"):
    parse_prompt_state(
      {
        "version": 4,
        "subjects": [],
        "sections": [
          {"title": "scene", "parts": []},
          {"title": "scene", "parts": []},
        ],
      }
    )
