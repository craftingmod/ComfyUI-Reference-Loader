from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .reference_contract import ReferenceState
from .reference_manifest import build_reference_output_plan

PROMPT_STATE_VERSION = 3
MAX_PROMPT_STATE_CHARACTERS = 250_000
MAX_PROMPT_TEXT_CHARACTERS = 100_000
MAX_PROMPT_SECTION_TITLE_CHARACTERS = 64

PromptMediaKind = Literal["image", "video", "audio"]
PromptPartKind = Literal["text", "dialogue", "mention"]
SECTION_TITLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class PromptContractError(ValueError):
  """Raised when serialized Reference Prompt state violates its contract."""


@dataclass(frozen=True, slots=True)
class PromptPart:
  type: PromptPartKind
  text: str = ""
  reference_id: str = ""
  media_kind: PromptMediaKind | None = None
  label: str = ""


@dataclass(frozen=True, slots=True)
class PromptSection:
  title: str
  parts: tuple[PromptPart, ...]


@dataclass(frozen=True, slots=True)
class PromptDocument:
  version: int
  sections: tuple[PromptSection, ...]


def empty_prompt_state() -> dict[str, Any]:
  return {
    "version": PROMPT_STATE_VERSION,
    "view": "structured",
    "sections": [],
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


def _mention_part(value: Mapping[str, Any], path: str) -> PromptPart:
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


def _part(value: Any, path: str) -> PromptPart:
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  part_type = value.get("type")
  if part_type in {"text", "dialogue"}:
    return PromptPart(
      type=part_type,
      text=_text(value.get("text"), f"{path}.text", MAX_PROMPT_TEXT_CHARACTERS),
    )
  if part_type == "mention":
    return _mention_part(value, path)
  raise _error(f"{path}.type", "must be text, dialogue, or mention")


def _section(value: Any, index: int) -> PromptSection:
  path = f"prompt.sections[{index}]"
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  title = _text(
    value.get("title"),
    f"{path}.title",
    MAX_PROMPT_SECTION_TITLE_CHARACTERS,
  )
  if SECTION_TITLE_PATTERN.fullmatch(title) is None:
    raise _error(f"{path}.title", "must be a lowercase snake_case title tag")
  raw_parts = value.get("parts")
  if not isinstance(raw_parts, Sequence) or isinstance(raw_parts, (str, bytes)):
    raise _error(f"{path}.parts", "must be an array")
  return PromptSection(
    title=title,
    parts=tuple(
      _part(raw_part, f"{path}.parts[{part_index}]")
      for part_index, raw_part in enumerate(raw_parts)
    ),
  )


def parse_prompt_state(value: str | Mapping[str, Any]) -> PromptDocument:
  """Parse a title-based prompt document; a non-JSON string is a scene section."""

  if isinstance(value, str):
    if len(value) > MAX_PROMPT_STATE_CHARACTERS:
      raise _error("prompt", "serialized state exceeds the size limit")
    try:
      raw: Any = json.loads(value)
    except (TypeError, ValueError):
      sections = (
        (PromptSection(title="scene", parts=(PromptPart(type="text", text=value),)),)
        if value
        else ()
      )
      return PromptDocument(version=PROMPT_STATE_VERSION, sections=sections)
  else:
    raw = value
  if not isinstance(raw, Mapping):
    raise _error("prompt", "must be an object")
  if raw.get("version") != PROMPT_STATE_VERSION:
    raise _error("prompt.version", f"must equal {PROMPT_STATE_VERSION}")
  raw_sections = raw.get("sections")
  if not isinstance(raw_sections, Sequence) or isinstance(raw_sections, (str, bytes)):
    raise _error("prompt.sections", "must be an array")
  sections = tuple(
    _section(section, index) for index, section in enumerate(raw_sections)
  )
  titles: set[str] = set()
  for index, section in enumerate(sections):
    if section.title in titles:
      raise _error(f"prompt.sections[{index}].title", "must be unique")
    titles.add(section.title)
  text_length = sum(len(part.text) for section in sections for part in section.parts)
  if text_length > MAX_PROMPT_TEXT_CHARACTERS:
    raise _error(
      "prompt.sections",
      f"combined text must contain at most {MAX_PROMPT_TEXT_CHARACTERS} characters",
    )
  return PromptDocument(version=PROMPT_STATE_VERSION, sections=sections)


def compile_prompt(document: PromptDocument, references: ReferenceState) -> str:
  """Resolve stable mentions while preserving the user's title-tag section order."""

  return "\n\n".join(
    f"{title}:\n{content}" if content else f"{title}:"
    for title, content in compile_prompt_sections(document, references)
  )


def rebind_prompt_mentions_by_order(
  document: PromptDocument, references: ReferenceState
) -> PromptDocument:
  """Bind imageN/videoN/audioN labels to the current active output positions."""

  plan = build_reference_output_plan(references)
  ids_by_kind = {
    "image": plan.image_ids,
    "video": plan.video_ids,
    "audio": plan.audio_ids,
  }

  def rebind(part: PromptPart) -> PromptPart:
    if part.type != "mention" or part.media_kind is None:
      return part
    match = re.fullmatch(rf"{part.media_kind}([1-9]\d*)", part.label)
    if match is None:
      return part
    ordinal = int(match.group(1))
    ids = ids_by_kind[part.media_kind]
    if ordinal > len(ids):
      return part
    return PromptPart(
      type="mention",
      reference_id=ids[ordinal - 1],
      media_kind=part.media_kind,
      label=f"{part.media_kind}{ordinal}",
    )

  return PromptDocument(
    version=document.version,
    sections=tuple(
      PromptSection(
        title=section.title,
        parts=tuple(rebind(part) for part in section.parts),
      )
      for section in document.sections
    ),
  )


def compile_prompt_sections(
  document: PromptDocument, references: ReferenceState
) -> tuple[tuple[str, str], ...]:
  """Resolve stable mentions into ordered title/content pairs."""

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

  def compile_part(part: PromptPart) -> str:
    if part.type == "text":
      return part.text
    if part.type == "dialogue":
      return f"<d>{part.text}</d>"
    kind = part.media_kind or "image"
    ordinal = ordinals[kind].get(part.reference_id)
    if ordinal is None:
      return f"@{part.label or part.reference_id}"
    return f"<{tag_names[kind]} {ordinal}>"

  compiled_sections: list[tuple[str, str]] = []
  for section in document.sections:
    content = "".join(compile_part(part) for part in section.parts).strip()
    compiled_sections.append((section.title, content))
  return tuple(compiled_sections)


def serialize_prompt_document(document: PromptDocument) -> str:
  """Serialize execution-relevant prompt state without frontend-only view state."""

  def serialize_part(part: PromptPart) -> dict[str, Any]:
    if part.type in {"text", "dialogue"}:
      return {"type": part.type, "text": part.text}
    return {
      "type": "mention",
      "referenceId": part.reference_id,
      "mediaKind": part.media_kind,
      "label": part.label,
    }

  value = {
    "version": document.version,
    "sections": [
      {
        "title": section.title,
        "parts": [serialize_part(part) for part in section.parts],
      }
      for section in document.sections
    ],
  }
  return json.dumps(
    value,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
  )


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
  "PromptSection",
  "compile_prompt",
  "compile_prompt_sections",
  "compile_prompt_state",
  "empty_prompt_state",
  "parse_prompt_state",
  "rebind_prompt_mentions_by_order",
  "serialize_prompt_document",
]
