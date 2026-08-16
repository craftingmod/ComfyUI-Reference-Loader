from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .reference_contract import ReferenceState
from .reference_manifest import build_reference_output_plan

PROMPT_STATE_VERSION = 1
MAX_PROMPT_STATE_CHARACTERS = 250_000
MAX_PROMPT_TEXT_CHARACTERS = 100_000

PromptMediaKind = Literal["image", "video", "audio"]


class PromptContractError(ValueError):
  """Raised when serialized Reference Prompt state violates its contract."""


@dataclass(frozen=True, slots=True)
class PromptPart:
  type: Literal["text", "dialogue", "mention"]
  text: str = ""
  reference_id: str = ""
  media_kind: PromptMediaKind | None = None
  label: str = ""


@dataclass(frozen=True, slots=True)
class PromptDocument:
  version: int
  parts: tuple[PromptPart, ...]


def empty_prompt_state() -> dict[str, Any]:
  return {
    "version": PROMPT_STATE_VERSION,
    "view": "structured",
    "parts": [],
  }


EMPTY_PROMPT_STATE_JSON = json.dumps(
  empty_prompt_state(),
  ensure_ascii=False,
  sort_keys=True,
  separators=(",", ":"),
)


def _error(path: str, message: str) -> PromptContractError:
  return PromptContractError(f"{path}: {message}")


def _text(value: Any, path: str, maximum: int) -> str:
  if not isinstance(value, str):
    raise _error(path, "must be a string")
  if len(value) > maximum:
    raise _error(path, f"must contain at most {maximum} characters")
  return value


def _part(value: Any, index: int) -> PromptPart:
  path = f"prompt.parts[{index}]"
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  part_type = value.get("type")
  if part_type in {"text", "dialogue"}:
    return PromptPart(
      type=part_type,
      text=_text(value.get("text"), f"{path}.text", MAX_PROMPT_TEXT_CHARACTERS),
    )
  if part_type != "mention":
    raise _error(f"{path}.type", "must be text, dialogue, or mention")
  reference_id = _text(value.get("referenceId"), f"{path}.referenceId", 160)
  if not reference_id or any(character.isspace() for character in reference_id):
    raise _error(f"{path}.referenceId", "must be a non-empty stable reference ID")
  media_kind = value.get("mediaKind")
  if media_kind not in {"image", "video", "audio"}:
    raise _error(f"{path}.mediaKind", "must be image, video, or audio")
  return PromptPart(
    type="mention",
    reference_id=reference_id,
    media_kind=media_kind,
    label=_text(value.get("label", ""), f"{path}.label", 255),
  )


def parse_prompt_state(value: str | Mapping[str, Any]) -> PromptDocument:
  """Parse a prompt document; a non-JSON string remains a literal prompt."""

  if isinstance(value, str):
    if len(value) > MAX_PROMPT_STATE_CHARACTERS:
      raise _error("prompt", "serialized state exceeds the size limit")
    try:
      raw: Any = json.loads(value)
    except (TypeError, ValueError):
      return PromptDocument(
        version=PROMPT_STATE_VERSION,
        parts=(PromptPart(type="text", text=value),),
      )
  else:
    raw = value
  if not isinstance(raw, Mapping):
    raise _error("prompt", "must be an object")
  if raw.get("version") != PROMPT_STATE_VERSION:
    raise _error("prompt.version", f"must equal {PROMPT_STATE_VERSION}")
  raw_parts = raw.get("parts")
  if not isinstance(raw_parts, Sequence) or isinstance(raw_parts, (str, bytes)):
    raise _error("prompt.parts", "must be an array")
  parts = tuple(_part(value, index) for index, value in enumerate(raw_parts))
  text_length = sum(len(part.text) for part in parts)
  if text_length > MAX_PROMPT_TEXT_CHARACTERS:
    raise _error(
      "prompt.parts",
      f"combined text must contain at most {MAX_PROMPT_TEXT_CHARACTERS} characters",
    )
  return PromptDocument(version=PROMPT_STATE_VERSION, parts=parts)


def compile_prompt(document: PromptDocument, references: ReferenceState) -> str:
  """Resolve stable mentions to the active MiniMax H3 reference ordinals."""

  plan = build_reference_output_plan(references)
  ids_by_kind = {
    "image": plan.image_ids,
    "video": plan.video_ids,
    "audio": plan.audio_ids,
  }
  tag_names = {"image": "Picture", "video": "Video", "audio": "Audio"}
  ordinals = {
    kind: {reference_id: index for index, reference_id in enumerate(ids, start=1)}
    for kind, ids in ids_by_kind.items()
  }
  output: list[str] = []
  for part in document.parts:
    if part.type == "text":
      output.append(part.text)
    elif part.type == "dialogue":
      output.append(f"<d>{part.text}</d>")
    else:
      kind = part.media_kind or "image"
      ordinal = ordinals[kind].get(part.reference_id)
      if ordinal is None:
        output.append(f"@{part.label or part.reference_id}")
      else:
        output.append(f"<{tag_names[kind]} {ordinal}>")
  return "".join(output)


def compile_prompt_state(
  value: str | Mapping[str, Any], references: ReferenceState
) -> str:
  return compile_prompt(parse_prompt_state(value), references)


__all__ = [
  "EMPTY_PROMPT_STATE_JSON",
  "MAX_PROMPT_STATE_CHARACTERS",
  "MAX_PROMPT_TEXT_CHARACTERS",
  "PROMPT_STATE_VERSION",
  "PromptContractError",
  "PromptDocument",
  "PromptPart",
  "compile_prompt",
  "compile_prompt_state",
  "empty_prompt_state",
  "parse_prompt_state",
]
