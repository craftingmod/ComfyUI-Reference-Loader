from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .reference_contract import ReferenceState
from .reference_manifest import build_reference_output_plan

PROMPT_STATE_VERSION = 5
PROMPT_DOCUMENT_VERSION = 6
MAX_PROMPT_STATE_CHARACTERS = 250_000
MAX_PROMPT_TEXT_CHARACTERS = 100_000
MAX_PROMPT_SECTION_TITLE_CHARACTERS = 64
MAX_PROMPT_TAG_CHARACTERS = 64
MAX_PROMPT_FRAME_INDEX = 2**53 - 1
PromptMediaKind = Literal["image", "video", "audio"]
PromptPartKind = Literal["text", "mention", "definition-ref"]
SECTION_TITLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
TAG_PATTERN = re.compile(r"^[^\W_][\w-]{0,63}$", re.UNICODE)
TAG_CHAR_PATTERN = re.compile(r"[\w-]", re.UNICODE)


class PromptContractError(ValueError):
  """Raised when serialized Reference Prompt state violates its contract."""


@dataclass(frozen=True, slots=True)
class PromptPart:
  type: PromptPartKind
  text: str = ""
  reference_id: str = ""
  media_kind: PromptMediaKind | None = None
  label: str = ""
  definition_id: str = ""


@dataclass(frozen=True, slots=True)
class PromptSubject:
  tag: str
  parts: tuple[PromptPart, ...]
  id: str = ""


@dataclass(frozen=True, slots=True)
class PromptShot:
  tag: str
  frame_index: int
  parts: tuple[PromptPart, ...]
  id: str = ""


@dataclass(frozen=True, slots=True)
class PromptSection:
  title: str
  parts: tuple[PromptPart, ...]
  id: str = ""


@dataclass(frozen=True, slots=True)
class PromptDocument:
  version: int
  subjects: tuple[PromptSubject, ...]
  shots: tuple[PromptShot, ...]
  sections: tuple[PromptSection, ...]
  view: Literal["structured", "raw"] = "structured"


def empty_prompt_state() -> dict[str, Any]:
  return {
    "version": PROMPT_DOCUMENT_VERSION,
    "view": "structured",
    "subjects": [],
    "shots": [],
    "sections": [],
  }


EMPTY_PROMPT_STATE_JSON = json.dumps(
  empty_prompt_state(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
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


def _tag(value: Any, path: str) -> str:
  tag = _text(value, path, MAX_PROMPT_TAG_CHARACTERS).strip()
  if TAG_PATTERN.fullmatch(tag) is None:
    raise _error(
      path,
      "must start with a letter or number and contain only letters, numbers, underscores, or hyphens",
    )
  return tag


def _part(value: Any, path: str) -> PromptPart:
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  part_type = value.get("type")
  if part_type == "text":
    return PromptPart(
      type="text",
      text=_text(value.get("text"), f"{path}.text", MAX_PROMPT_TEXT_CHARACTERS),
    )
  if part_type == "mention":
    return _mention_part(value, path)
  raise _error(f"{path}.type", "must be text or mention")


def _parts(value: Any, path: str) -> tuple[PromptPart, ...]:
  if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
    raise _error(path, "must be an array")
  return tuple(_part(part, f"{path}[{index}]") for index, part in enumerate(value))


def _identity(value: Any, path: str) -> str:
  identity = _text(value, path, 160)
  if not identity or any(character.isspace() for character in identity):
    raise _error(path, "must be a non-empty stable identity")
  if any(character in identity for character in "\\\"'"):
    raise _error(path, "contains an invalid character")
  return identity


def _v6_parts(
  value: Any, path: str, definition_ids: set[str]
) -> tuple[PromptPart, ...]:
  if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
    raise _error(path, "must be an array")
  normalized: list[PromptPart] = []
  for index, raw in enumerate(value):
    part_path = f"{path}[{index}]"
    if not isinstance(raw, Mapping):
      raise _error(part_path, "must be an object")
    kind = raw.get("type")
    if kind == "text":
      text = _text(raw.get("text"), f"{part_path}.text", MAX_PROMPT_TEXT_CHARACTERS)
      if not text:
        continue
      if normalized and normalized[-1].type == "text":
        previous = normalized[-1]
        normalized[-1] = PromptPart(type="text", text=previous.text + text)
      else:
        normalized.append(PromptPart(type="text", text=text))
    elif kind == "mention":
      normalized.append(_mention_part(raw, part_path))
    elif kind == "definition-ref":
      definition_id = _identity(raw.get("definitionId"), f"{part_path}.definitionId")
      if definition_id not in definition_ids:
        raise _error(f"{part_path}.definitionId", "does not reference a definition")
      normalized.append(PromptPart(type="definition-ref", definition_id=definition_id))
    else:
      raise _error(f"{part_path}.type", "must be text, mention, or definition-ref")
  return tuple(normalized)


def _parse_v6(raw: Mapping[str, Any]) -> PromptDocument:
  if raw.get("version") != PROMPT_DOCUMENT_VERSION:
    raise _error("prompt.version", f"must equal {PROMPT_DOCUMENT_VERSION}")
  view = raw.get("view", "structured")
  if view not in {"structured", "raw"}:
    raise _error("prompt.view", "must be structured or raw")
  raw_subjects = raw.get("subjects")
  raw_shots = raw.get("shots")
  raw_sections = raw.get("sections")
  for name, value in (
    ("subjects", raw_subjects),
    ("shots", raw_shots),
    ("sections", raw_sections),
  ):
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
      raise _error(f"prompt.{name}", "must be an array")
  ids: set[str] = set()
  tags: set[str] = set()

  def add_id(value: Any, path: str) -> str:
    identity = _identity(value, path)
    if identity in ids:
      raise _error(path, "must be unique")
    ids.add(identity)
    return identity

  def add_tag(value: Any, path: str) -> str:
    tag = _tag(value, path)
    if tag in tags:
      raise _error(path, "must be unique")
    tags.add(tag)
    return tag

  subjects: list[tuple[str, str, Mapping[str, Any]]] = []
  for index, value in enumerate(raw_subjects):
    path = f"prompt.subjects[{index}]"
    if not isinstance(value, Mapping):
      raise _error(path, "must be an object")
    subjects.append(
      (
        add_id(value.get("id"), f"{path}.id"),
        add_tag(value.get("tag"), f"{path}.tag"),
        value,
      )
    )
  shots: list[tuple[str, str, int, Mapping[str, Any]]] = []
  for index, value in enumerate(raw_shots):
    path = f"prompt.shots[{index}]"
    if not isinstance(value, Mapping):
      raise _error(path, "must be an object")
    frame = value.get("frameIndex")
    if (
      isinstance(frame, bool)
      or not isinstance(frame, int)
      or frame < 0
      or frame > MAX_PROMPT_FRAME_INDEX
    ):
      raise _error(f"{path}.frameIndex", "must be a non-negative safe integer")
    shots.append(
      (
        add_id(value.get("id"), f"{path}.id"),
        add_tag(value.get("tag"), f"{path}.tag"),
        frame,
        value,
      )
    )
  sections: list[tuple[str, str, Mapping[str, Any]]] = []
  titles: set[str] = set()
  for index, value in enumerate(raw_sections):
    path = f"prompt.sections[{index}]"
    if not isinstance(value, Mapping):
      raise _error(path, "must be an object")
    section_id = add_id(value.get("id"), f"{path}.id")
    title = _text(
      value.get("title"), f"{path}.title", MAX_PROMPT_SECTION_TITLE_CHARACTERS
    )
    if SECTION_TITLE_PATTERN.fullmatch(title) is None:
      raise _error(f"{path}.title", "must be a lowercase snake_case title tag")
    if title in titles:
      raise _error(f"{path}.title", "must be unique")
    titles.add(title)
    sections.append((section_id, title, value))
  definition_ids = {identity for identity, *_ in subjects} | {
    identity for identity, *_ in shots
  }
  prompt_subjects = tuple(
    PromptSubject(
      tag=tag,
      parts=_v6_parts(
        value.get("parts"), f"prompt.subjects[{index}].parts", definition_ids
      ),
      id=identity,
    )
    for index, (identity, tag, value) in enumerate(subjects)
  )
  prompt_shots = tuple(
    PromptShot(
      tag=tag,
      frame_index=frame,
      parts=_v6_parts(
        value.get("parts"), f"prompt.shots[{index}].parts", definition_ids
      ),
      id=identity,
    )
    for index, (identity, tag, frame, value) in enumerate(shots)
  )
  prompt_sections = tuple(
    PromptSection(
      title=title,
      parts=_v6_parts(
        value.get("parts"), f"prompt.sections[{index}].parts", definition_ids
      ),
      id=identity,
    )
    for index, (identity, title, value) in enumerate(sections)
  )
  text_length = sum(
    len(part.text)
    for owner in (*prompt_subjects, *prompt_shots, *prompt_sections)
    for part in owner.parts
    if part.type == "text"
  )
  if text_length > MAX_PROMPT_TEXT_CHARACTERS:
    raise _error(
      "prompt",
      f"combined text must contain at most {MAX_PROMPT_TEXT_CHARACTERS} characters",
    )
  return PromptDocument(
    PROMPT_DOCUMENT_VERSION,
    prompt_subjects,
    prompt_shots,
    prompt_sections,
    view,
  )


def _section(value: Any, index: int) -> PromptSection:
  path = f"prompt.sections[{index}]"
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  title = _text(
    value.get("title"), f"{path}.title", MAX_PROMPT_SECTION_TITLE_CHARACTERS
  )
  if SECTION_TITLE_PATTERN.fullmatch(title) is None:
    raise _error(f"{path}.title", "must be a lowercase snake_case title tag")
  return PromptSection(title=title, parts=_parts(value.get("parts"), f"{path}.parts"))


def _subject(value: Any, index: int) -> PromptSubject:
  path = f"prompt.subjects[{index}]"
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  return PromptSubject(
    tag=_tag(value.get("tag"), f"{path}.tag"),
    parts=_parts(value.get("parts"), f"{path}.parts"),
  )


def _shot(value: Any, index: int) -> PromptShot:
  path = f"prompt.shots[{index}]"
  if not isinstance(value, Mapping):
    raise _error(path, "must be an object")
  frame = value.get("frameIndex")
  if (
    isinstance(frame, bool)
    or not isinstance(frame, int)
    or frame < 0
    or frame > MAX_PROMPT_FRAME_INDEX
  ):
    raise _error(f"{path}.frameIndex", "must be a non-negative safe integer")
  return PromptShot(
    tag=_tag(value.get("tag"), f"{path}.tag"),
    frame_index=frame,
    parts=_parts(value.get("parts"), f"{path}.parts"),
  )


def _legacy_part(
  value: Any, subjects: tuple[tuple[str, str], ...], path: str
) -> PromptPart:
  if not isinstance(value, Mapping):
    return PromptPart(type="text", text=json.dumps(value, ensure_ascii=False))
  kind = value.get("type")
  if kind == "text":
    return PromptPart(type="text", text=str(value.get("text", "")))
  if kind == "mention":
    return _mention_part(value, path)
  if kind == "subject":
    subject_id = value.get("subjectId")
    label = next(
      (label for sid, label in subjects if sid == subject_id),
      value.get("label", subject_id),
    )
    return PromptPart(type="text", text=f"#{label}")
  if kind == "directive" and value.get("kind") in {"audio", "style"}:
    nested = (
      value.get("parts")
      if isinstance(value.get("parts"), Sequence)
      and not isinstance(value.get("parts"), (str, bytes))
      else [{"type": "text", "text": value.get("text", "")}]
    )
    return PromptPart(
      type="text",
      text=f"<{value['kind']}>"
      + "".join(_legacy_part_text(part, subjects, path) for part in nested)
      + f"</{value['kind']}>",
    )
  raise _error(f"{path}.type", "must be text, mention, or subject")


def _legacy_part_text(
  value: Any, subjects: tuple[tuple[str, str], ...], path: str
) -> str:
  part = _legacy_part(value, subjects, path)
  if part.type == "text":
    return part.text
  ordinal = re.fullmatch(r"(?:image|video|audio)([1-9]\d*)", part.label)
  name = (
    "Picture"
    if part.media_kind == "image"
    else (part.media_kind or "audio").capitalize()
  )
  return (
    f"<{name} {ordinal.group(1)}>" if ordinal else f"@{part.label or part.reference_id}"
  )


def _replace_legacy_ordinals(text: str, tags: tuple[str, ...]) -> str:
  def replace(match: re.Match[str]) -> str:
    index = int(match.group(1)) - 1
    return f"#{tags[index]}" if 0 <= index < len(tags) else match.group(0)

  return re.sub(r"<\s*subject\s+(\d+)\s*>", replace, text, flags=re.IGNORECASE)


def _migrate_v4(raw: Mapping[str, Any]) -> PromptDocument:
  raw_subjects = (
    raw.get("subjects")
    if isinstance(raw.get("subjects"), Sequence)
    and not isinstance(raw.get("subjects"), (str, bytes))
    else []
  )
  legacy: list[tuple[str, str]] = []
  for index, value in enumerate(raw_subjects):
    if (
      isinstance(value, Mapping)
      and isinstance(value.get("subjectId"), str)
      and isinstance(value.get("label"), str)
    ):
      label = value["label"].strip()
      if TAG_PATTERN.fullmatch(label) is None:
        raise _error(
          f"prompt.subjects[{index}].label",
          "must contain only letters, numbers, underscores, or hyphens",
        )
      if label in {tag for _, tag in legacy}:
        raise _error(f"prompt.subjects[{index}].label", "must be unique")
      legacy.append((value["subjectId"], label))
    elif isinstance(value, Mapping):
      raise _error(f"prompt.subjects[{index}]", "must contain subjectId and label")
  tags = tuple(label for _, label in legacy)
  subjects = tuple(PromptSubject(tag=tag, parts=()) for tag in tags)
  sections: list[PromptSection] = []
  raw_sections = raw.get("sections")
  if raw_sections is not None and (
    not isinstance(raw_sections, Sequence) or isinstance(raw_sections, (str, bytes))
  ):
    raise _error("prompt.sections", "must be an array")
  titles: set[str] = set()
  if isinstance(raw_sections, Sequence) and not isinstance(raw_sections, (str, bytes)):
    for index, value in enumerate(raw_sections):
      if (
        isinstance(value, Mapping)
        and isinstance(value.get("title"), str)
        and SECTION_TITLE_PATTERN.fullmatch(value["title"])
      ):
        if value["title"] in titles:
          raise _error("prompt.sections", "section titles must be unique")
        titles.add(value["title"])
        raw_parts = value.get("parts")
        parts = (
          tuple(_legacy_part(part, tuple(legacy), "legacy.part") for part in raw_parts)
          if isinstance(raw_parts, Sequence) and not isinstance(raw_parts, (str, bytes))
          else (
            PromptPart(type="text", text=json.dumps(raw_parts, ensure_ascii=False)),
          )
        )
        sections.append(
          PromptSection(
            title=value["title"],
            parts=tuple(
              PromptPart(type="text", text=_replace_legacy_ordinals(part.text, tags))
              if part.type == "text"
              else part
              for part in parts
            ),
          )
        )
      elif isinstance(value, Mapping) and "title" in value:
        raise _error(
          f"prompt.sections[{index}].title",
          "must be a lowercase snake_case title tag",
        )
      else:
        sections.append(
          PromptSection(
            title="legacy_prompt",
            parts=(
              PromptPart(
                type="text",
                text=_replace_legacy_ordinals(
                  json.dumps(value, ensure_ascii=False), tags
                ),
              ),
            ),
          )
        )
  elif isinstance(raw.get("parts"), Sequence) and not isinstance(
    raw.get("parts"), (str, bytes)
  ):
    sections.append(
      PromptSection(
        title="scene",
        parts=tuple(
          _legacy_part(part, tuple(legacy), "legacy.part") for part in raw["parts"]
        ),
      )
    )
  else:
    sections.append(
      PromptSection(
        title="legacy_prompt",
        parts=(PromptPart(type="text", text=json.dumps(raw, ensure_ascii=False)),),
      )
    )
  return PromptDocument(
    version=PROMPT_STATE_VERSION, subjects=subjects, sections=tuple(sections), shots=()
  )


def parse_prompt_state(value: str | Mapping[str, Any]) -> PromptDocument:
  if isinstance(value, str):
    if len(value) > MAX_PROMPT_STATE_CHARACTERS:
      raise _error("prompt", "serialized state exceeds the size limit")
    try:
      raw: Any = json.loads(value)
    except (TypeError, ValueError):
      return PromptDocument(
        PROMPT_STATE_VERSION,
        (),
        (),
        (PromptSection("scene", (PromptPart(type="text", text=value),)),)
        if value
        else (),
      )
  else:
    raw = value
  if not isinstance(raw, Mapping):
    raise _error("prompt", "must be an object")
  version = raw.get("version")
  if version == PROMPT_DOCUMENT_VERSION:
    return _parse_v6(raw)
  if version == 4:
    return _migrate_v4(raw)
  if version != PROMPT_STATE_VERSION:
    raise _error("prompt.version", f"must equal {PROMPT_STATE_VERSION}")
  raw_subjects = raw.get("subjects")
  raw_shots = raw.get("shots")
  raw_sections = raw.get("sections")
  if not isinstance(raw_subjects, Sequence) or isinstance(raw_subjects, (str, bytes)):
    raise _error("prompt.subjects", "must be an array")
  if not isinstance(raw_shots, Sequence) or isinstance(raw_shots, (str, bytes)):
    raise _error("prompt.shots", "must be an array")
  subjects = tuple(
    _subject(subject, index) for index, subject in enumerate(raw_subjects)
  )
  shots = tuple(_shot(shot, index) for index, shot in enumerate(raw_shots))
  tags: set[str] = set()
  for index, definition in enumerate((*subjects, *shots)):
    if definition.tag in tags:
      raise _error(
        f"prompt.{'subjects' if index < len(subjects) else 'shots'}[{index if index < len(subjects) else index - len(subjects)}].tag",
        "must be unique",
      )
    tags.add(definition.tag)
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
  text_length = sum(
    len(part.text) for definition in (*subjects, *shots) for part in definition.parts
  ) + sum(len(part.text) for section in sections for part in section.parts)
  if text_length > MAX_PROMPT_TEXT_CHARACTERS:
    raise _error(
      "prompt",
      f"combined text must contain at most {MAX_PROMPT_TEXT_CHARACTERS} characters",
    )
  return PromptDocument(PROMPT_STATE_VERSION, subjects, shots, sections)


def _tag_tokens(text: str) -> list[tuple[int, int, str, bool]]:
  tokens: list[tuple[int, int, str, bool]] = []
  index = 0
  while index < len(text):
    if text[index] != "#" or (
      index > 0 and TAG_CHAR_PATTERN.fullmatch(text[index - 1])
    ):
      index += 1
      continue
    end = index + 1
    while end < len(text) and TAG_CHAR_PATTERN.fullmatch(text[end]):
      end += 1
    tag = text[index + 1 : end]
    if TAG_PATTERN.fullmatch(tag):
      escaped = index > 0 and text[index - 1] == "\\"
      tokens.append((index - 1 if escaped else index, end, tag, escaped))
      index = end
      continue
    index += 1
  return tokens


def _compile_text(text: str, tokens: Mapping[str, str]) -> str:
  result = ""
  cursor = 0
  for start, end, tag, escaped in _tag_tokens(text):
    result += text[cursor:start] + (
      f"#{tag}" if escaped else tokens.get(tag, f"#{tag}")
    )
    cursor = end
  return result + text[cursor:]


def _compile_part(
  part: PromptPart,
  references: ReferenceState,
  ordinals: Mapping[str, Mapping[str, int]],
  tokens: Mapping[str, str],
) -> str:
  if part.type == "text":
    return _compile_text(part.text, tokens)
  kind = part.media_kind or "image"
  ordinal = ordinals[kind].get(part.reference_id)
  return (
    f"<{ {'image': 'Picture', 'video': 'Video', 'audio': 'Audio'}[kind] } {ordinal}>"
    if ordinal is not None
    else f"@{part.label or part.reference_id}"
  )


def _token_map(document: PromptDocument) -> dict[str, str]:
  tokens = {
    subject.tag: f"<Subject {index}" + ">"
    for index, subject in enumerate(document.subjects, 1)
  }
  ordered = sorted(
    enumerate(document.shots), key=lambda pair: (pair[1].frame_index, pair[0])
  )
  tokens.update(
    {shot.tag: f"[Shot {index}]" for index, (_, shot) in enumerate(ordered, 1)}
  )
  return tokens


def _compiled_parts(
  parts: Sequence[PromptPart],
  references: ReferenceState,
  ordinals: Mapping[str, Mapping[str, int]],
  tokens: Mapping[str, str],
) -> str:
  return "".join(
    _compile_part(part, references, ordinals, tokens) for part in parts
  ).strip()


def _v6_token_map(document: PromptDocument) -> dict[str, str]:
  tokens = {
    subject.id: f"<Subject {index}>"
    for index, subject in enumerate(document.subjects, 1)
  }
  ordered = sorted(
    enumerate(document.shots), key=lambda pair: (pair[1].frame_index, pair[0])
  )
  tokens.update(
    {shot.id: f"[Shot {index}]" for index, (_, shot) in enumerate(ordered, 1)}
  )
  return tokens


def _v6_compile_part(
  part: PromptPart, references: ReferenceState, tokens: Mapping[str, str]
) -> str:
  if part.type == "text":
    # v6 semantic promotion happens at the input/import boundary, never while compiling.
    return part.text
  if part.type == "definition-ref":
    return tokens.get(part.definition_id, f"#{part.definition_id}")
  kind = part.media_kind or "image"
  plan = build_reference_output_plan(references)
  ids = {
    "image": plan.image_ids,
    "video": plan.video_ids,
    "audio": plan.audio_ids,
  }[kind]
  try:
    ordinal = ids.index(part.reference_id) + 1
  except ValueError:
    return f"@{part.label or part.reference_id}"
  name = {"image": "Picture", "video": "Video", "audio": "Audio"}[kind]
  return f"<{name} {ordinal}>"


def _v6_compiled_parts(
  parts: Sequence[PromptPart], references: ReferenceState, tokens: Mapping[str, str]
) -> str:
  return "".join(_v6_compile_part(part, references, tokens) for part in parts).strip()


def compile_prompt_sections(
  document: PromptDocument, references: ReferenceState
) -> tuple[tuple[str, str], ...]:
  plan = build_reference_output_plan(references)
  ids_by_kind = {
    "image": plan.image_ids,
    "video": plan.video_ids,
    "audio": plan.audio_ids,
  }
  ordinals = {
    kind: {reference_id: index for index, reference_id in enumerate(ids, 1)}
    for kind, ids in ids_by_kind.items()
  }
  tokens = (
    _v6_token_map(document)
    if document.version == PROMPT_DOCUMENT_VERSION
    else _token_map(document)
  )
  if document.version == PROMPT_DOCUMENT_VERSION:

    def render_parts(parts: Sequence[PromptPart]) -> str:
      return _v6_compiled_parts(parts, references, tokens)
  else:

    def render_parts(parts: Sequence[PromptPart]) -> str:
      return _compiled_parts(parts, references, ordinals, tokens)

  subjects = "\n\n".join(
    f"<Subject {index}>: {render_parts(subject.parts)}".rstrip()
    for index, subject in enumerate(document.subjects, 1)
  )
  ordered_shots = sorted(
    enumerate(document.shots), key=lambda pair: (pair[1].frame_index, pair[0])
  )
  shots = "\n\n".join(
    f"[Shot {index}]\nAt {(int(shot.frame_index * 1000 / 24 + 0.5) / 1000):.3f} seconds: {render_parts(shot.parts)}".rstrip()
    for index, (_, shot) in enumerate(ordered_shots, 1)
  )
  result: list[tuple[str, str]] = []
  for section in document.sections:
    content = render_parts(section.parts)
    if section.title == "subject_definitions" and subjects:
      content = "\n\n".join(filter(None, (content, subjects)))
    if section.title == "timeline_direction" and shots:
      content = "\n\n".join(filter(None, (content, shots)))
    result.append((section.title, content))
  if subjects and not any(title == "subject_definitions" for title, _ in result):
    result.insert(0, ("subject_definitions", subjects))
  if shots and not any(title == "timeline_direction" for title, _ in result):
    result.append(("timeline_direction", shots))
  return tuple(result)


def compile_prompt(document: PromptDocument, references: ReferenceState) -> str:
  return "\n\n".join(
    f"{title}:\n{content}" if content else f"{title}:"
    for title, content in compile_prompt_sections(document, references)
  )


def rebind_prompt_mentions_by_order(
  document: PromptDocument, references: ReferenceState
) -> PromptDocument:
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

  def parts(values: tuple[PromptPart, ...]) -> tuple[PromptPart, ...]:
    return tuple(rebind(part) for part in values)

  return PromptDocument(
    document.version,
    tuple(
      PromptSubject(subject.tag, parts(subject.parts), subject.id)
      for subject in document.subjects
    ),
    tuple(
      PromptShot(shot.tag, shot.frame_index, parts(shot.parts), shot.id)
      for shot in document.shots
    ),
    tuple(
      PromptSection(section.title, parts(section.parts), section.id)
      for section in document.sections
    ),
    document.view,
  )


def serialize_prompt_document(document: PromptDocument) -> str:
  def part(value: PromptPart) -> dict[str, Any]:
    if value.type == "text":
      return {"type": "text", "text": value.text}
    if value.type == "definition-ref":
      return {"type": "definition-ref", "definitionId": value.definition_id}
    return {
      "type": "mention",
      "referenceId": value.reference_id,
      "mediaKind": value.media_kind,
      "label": value.label,
    }

  value: dict[str, Any] = {
    "version": document.version,
    "subjects": [
      {
        **({"id": subject.id} if document.version == PROMPT_DOCUMENT_VERSION else {}),
        "tag": subject.tag,
        "parts": [part(item) for item in subject.parts],
      }
      for subject in document.subjects
    ],
    "shots": [
      {
        **({"id": shot.id} if document.version == PROMPT_DOCUMENT_VERSION else {}),
        "tag": shot.tag,
        "frameIndex": shot.frame_index,
        "parts": [part(item) for item in shot.parts],
      }
      for shot in document.shots
    ],
    "sections": [
      {
        **({"id": section.id} if document.version == PROMPT_DOCUMENT_VERSION else {}),
        "title": section.title,
        "parts": [part(item) for item in section.parts],
      }
      for section in document.sections
    ],
  }
  if document.version == PROMPT_DOCUMENT_VERSION:
    value["view"] = document.view
  return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compile_prompt_state(
  value: str | Mapping[str, Any], references: ReferenceState
) -> str:
  return compile_prompt(parse_prompt_state(value), references)


__all__ = [
  "EMPTY_PROMPT_STATE_JSON",
  "MAX_PROMPT_STATE_CHARACTERS",
  "MAX_PROMPT_TEXT_CHARACTERS",
  "PROMPT_DOCUMENT_VERSION",
  "PROMPT_STATE_VERSION",
  "PromptContractError",
  "PromptDocument",
  "PromptPart",
  "PromptSection",
  "PromptShot",
  "PromptSubject",
  "compile_prompt",
  "compile_prompt_sections",
  "compile_prompt_state",
  "empty_prompt_state",
  "parse_prompt_state",
  "rebind_prompt_mentions_by_order",
  "serialize_prompt_document",
]
