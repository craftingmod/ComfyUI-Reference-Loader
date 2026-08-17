from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from comfy_api.latest import io

from ..core.prompt_contract import (
  EMPTY_PROMPT_STATE_JSON,
  compile_prompt,
  parse_prompt_state,
  rebind_prompt_mentions_by_order,
  serialize_prompt_document,
)
from ..core.reference_contract import (
  ReferenceContractError,
  execution_fingerprint,
  image_output_settings,
  parse_reference_state,
)
from ..core.reference_manifest import (
  build_reference_manifest,
  build_reference_output_plan,
)
from ..core.reference_media import load_reference_media, validate_reference_sources
from .reference_bundle import REFERENCE_LOADER_BUNDLE_TYPE, ReferenceLoaderBundle
from .reference_image_inputs import (
  reference_image_output_inputs,
  reference_preview_pixels_input,
)

EMPTY_LOADER_STATE_JSON = json.dumps(
  {
    "version": 1,
    "items": {},
    "imageOrder": [],
    "videoOrder": [],
    "audioOrder": [],
    "videoAudioPolicy": "preserve",
    "ui": {
      "cardAspectRatio": "4 / 3",
      "gridColumns": 3,
      "previewMaxPixels": 1_000_000,
      "previewFit": "contain",
      "waveformPeaks": 300,
    },
  },
  separators=(",", ":"),
)

PROMPT_PRESET_DIRECTORY = Path(__file__).resolve().parents[2] / "presets" / "prompt"
_PROMPT_IDENTIFIER_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
_PROMPT_ALIAS_PATTERN = re.compile(r"^[a-z]+$")


def _is_localized_text(value: object) -> bool:
  return (
    isinstance(value, dict)
    and isinstance(value.get("en"), str)
    and isinstance(value.get("ko"), str)
  )


def load_prompt_preset_catalog(
  directory: Path = PROMPT_PRESET_DIRECTORY,
) -> dict[str, object]:
  try:
    paths = sorted(
      path for path in directory.iterdir() if path.is_file() and path.suffix == ".json"
    )
  except OSError as error:
    raise ValueError(f"Unable to read prompt preset directory: {directory}") from error
  if not paths:
    raise ValueError(f"Prompt preset directory contains no JSON files: {directory}")
  entries: list[tuple[int, str, bool, dict[str, object]]] = []
  preset_ids: list[str] = []
  orders: list[int] = []
  for path in paths:
    try:
      preset = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
      raise ValueError(f"Unable to load prompt preset: {path}") from error
    if not isinstance(preset, dict) or preset.get("version") != 1:
      raise ValueError(f"Prompt preset must be a version 1 JSON object: {path}")
    preset_id = preset.get("id")
    order = preset.get("order")
    is_default = preset.get("default")
    default_title = preset.get("defaultSectionTitle")
    subject_mode = preset.get("subjectMode")
    aliases = preset.get("aliases")
    if (
      not isinstance(preset_id, str)
      or _PROMPT_IDENTIFIER_PATTERN.fullmatch(preset_id) is None
      or not isinstance(order, int)
      or isinstance(order, bool)
      or not isinstance(is_default, bool)
      or not isinstance(default_title, str)
      or _PROMPT_IDENTIFIER_PATTERN.fullmatch(default_title) is None
      or subject_mode not in {"anywhere", "definitions", "disabled"}
      or not _is_localized_text(preset.get("label"))
      or not _is_localized_text(preset.get("description"))
      or not isinstance(aliases, list)
    ):
      raise ValueError(f"Prompt preset is invalid: {path}")
    if path.stem != preset_id:
      raise ValueError(f"Prompt preset filename must match its ID: {path}")
    alias_commands: list[str] = []
    for alias in aliases:
      if (
        not isinstance(alias, dict)
        or not isinstance(alias.get("command"), str)
        or _PROMPT_ALIAS_PATTERN.fullmatch(alias["command"]) is None
        or not isinstance(alias.get("title"), str)
        or _PROMPT_IDENTIFIER_PATTERN.fullmatch(alias["title"]) is None
        or not _is_localized_text(alias.get("label"))
        or not _is_localized_text(alias.get("description"))
        or not isinstance(alias.get("icon"), str)
      ):
        raise ValueError(f"Prompt preset {preset_id!r} contains an invalid alias.")
      alias_commands.append(alias["command"])
    if len(alias_commands) != len(set(alias_commands)):
      raise ValueError(
        f"Prompt preset {preset_id!r} contains duplicate alias commands."
      )
    preset_ids.append(preset_id)
    orders.append(order)
    entries.append((order, path.name, is_default, preset))
  if len(preset_ids) != len(set(preset_ids)):
    raise ValueError("Prompt preset catalog contains duplicate preset IDs.")
  if len(orders) != len(set(orders)):
    raise ValueError("Prompt preset files contain duplicate order values.")
  defaults = [preset["id"] for _, _, is_default, preset in entries if is_default]
  if len(defaults) != 1:
    raise ValueError("Exactly one prompt preset file must set default to true.")
  entries.sort(key=lambda entry: (entry[0], entry[1]))
  return {
    "version": 1,
    "defaultPresetId": defaults[0],
    "presets": [
      {
        key: value
        for key, value in preset.items()
        if key not in {"version", "order", "default"}
      }
      for _, _, _, preset in entries
    ],
  }


PROMPT_PRESET_CATALOG = load_prompt_preset_catalog()
PROMPT_SCHEMA_PRESETS = [preset["id"] for preset in PROMPT_PRESET_CATALOG["presets"]]
DEFAULT_PROMPT_SCHEMA_PRESET = str(PROMPT_PRESET_CATALOG["defaultPresetId"])


class ReferenceLoaderNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id="Alyac_ReferenceLoader",
      display_name="Reference Loader",
      category="reference/loader",
      description=(
        "Orders image, audio, and video references without batching, with optional "
        "downscale-only IMAGE output limiting, "
        "and emits a compact bundle plus a structured reference-aware prompt."
      ),
      search_aliases=["reference", "media loader", "multi image selector"],
      inputs=[
        io.String.Input(
          "loader_state",
          display_name="loader state",
          default=EMPTY_LOADER_STATE_JSON,
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          extra_dict={"widgetType": "REFERENCE_LOADER"},
        ),
        io.String.Input(
          "prompt",
          display_name="prompt",
          default=EMPTY_PROMPT_STATE_JSON,
          multiline=True,
          dynamic_prompts=False,
          socketless=True,
          extra_dict={
            "widgetType": "REFERENCE_PROMPT",
            "promptPresets": PROMPT_PRESET_CATALOG,
          },
          tooltip=(
            "Structured prompt with stable media mentions. The prompt output resolves "
            "them to <Picture N>, <Video N>, and <Audio N> tags."
          ),
        ),
        *reference_image_output_inputs(),
        io.Combo.Input(
          "prompt_schema_preset",
          display_name="prompt_schema_preset",
          options=PROMPT_SCHEMA_PRESETS,
          default=DEFAULT_PROMPT_SCHEMA_PRESET,
          advanced=True,
          socketless=True,
          tooltip=(
            "UI-only preset for the Prompt default section and slash aliases; "
            "existing sections and compiled output remain unchanged."
          ),
        ),
        io.Int.Input(
          "grid_columns",
          display_name="grid_columns",
          default=3,
          min=1,
          max=8,
          step=1,
          advanced=True,
          socketless=True,
          tooltip="Number of card columns used by each Loader channel.",
        ),
        reference_preview_pixels_input(),
        io.Boolean.Input(
          "show_captions",
          display_name="show_captions",
          default=True,
          label_on="Shown",
          label_off="Hidden",
          advanced=True,
          socketless=True,
          tooltip="Show caption fields on Loader cards; captions remain available in Edit when hidden.",
        ),
        io.Boolean.Input(
          "two_image_mode",
          display_name="two_image_mode",
          default=False,
          label_on="Up to 2",
          label_off="Unlimited",
          advanced=True,
          socketless=True,
          tooltip=(
            "Frontend-only guard that permits at most two enabled IMAGE outputs "
            "for I2V and FLF2V workflows."
          ),
        ),
        io.Boolean.Input(
          "prompt_by_order",
          display_name="prompt_by_order",
          default=False,
          label_on="By order",
          label_off="By media",
          advanced=True,
          socketless=True,
          tooltip=(
            "Keep imageN, videoN, and audioN prompt mentions attached to their "
            "current output positions when references are replaced or reordered."
          ),
        ),
        io.Combo.Input(
          "card_aspect",
          display_name="card_aspect",
          options=["1 / 1", "4 / 3", "3 / 4", "16 / 9", "9 / 16"],
          default="4 / 3",
          advanced=True,
          socketless=True,
          tooltip="Aspect ratio used by image and video cards in the Loader grid.",
        ),
        io.Combo.Input(
          "preview_fit",
          display_name="preview_fit",
          options=["contain", "cover"],
          default="contain",
          advanced=True,
          socketless=True,
          tooltip="Fit mode used by image and video previews; execution media is unchanged.",
        ),
        io.Int.Input(
          "waveform_pairs",
          display_name="waveform_pairs",
          default=300,
          min=100,
          max=1000,
          step=50,
          advanced=True,
          socketless=True,
          tooltip="Number of min/max amplitude pairs requested for audio waveforms.",
        ),
      ],
      outputs=[
        REFERENCE_LOADER_BUNDLE_TYPE.Output(
          "references",
          tooltip=(
            "Bundled media, aligned captions, manifest, and structured prompt "
            "snapshot for Reference Loader output and integration nodes."
          ),
        ),
      ],
    )

  @classmethod
  def fingerprint_inputs(
    cls,
    loader_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    grid_columns: int = 3,
    preview_pixels: float = 1.0,
    show_captions: bool = True,
    two_image_mode: bool = False,
    prompt_by_order: bool = False,
    card_aspect: str = "4 / 3",
    preview_fit: str = "contain",
    waveform_pairs: int = 300,
    prompt: str = EMPTY_PROMPT_STATE_JSON,
    prompt_schema_preset: str = DEFAULT_PROMPT_SCHEMA_PRESET,
  ) -> str:
    _ = (
      grid_columns,
      preview_pixels,
      show_captions,
      two_image_mode,
      card_aspect,
      preview_fit,
      waveform_pairs,
      prompt_schema_preset,
    )
    state = parse_reference_state(loader_state)
    validate_reference_sources(state)
    output_settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    media_fingerprint = execution_fingerprint(state, image_output=output_settings)
    prompt_document = parse_prompt_state(prompt)
    if prompt_by_order:
      prompt_document = rebind_prompt_mentions_by_order(prompt_document, state)
    prompt_state_json = serialize_prompt_document(prompt_document)
    compiled_prompt = compile_prompt(prompt_document, state)
    return hashlib.sha256(
      f"{media_fingerprint}\0{prompt_state_json}\0{compiled_prompt}".encode()
    ).hexdigest()

  @classmethod
  def execute(
    cls,
    loader_state: str,
    limit_image_pixels: bool = False,
    max_image_pixels: float = 2.0,
    composite_alpha: bool = False,
    alpha_background: str = "#000000",
    grid_columns: int = 3,
    preview_pixels: float = 1.0,
    show_captions: bool = True,
    two_image_mode: bool = False,
    prompt_by_order: bool = False,
    card_aspect: str = "4 / 3",
    preview_fit: str = "contain",
    waveform_pairs: int = 300,
    prompt: str = EMPTY_PROMPT_STATE_JSON,
    prompt_schema_preset: str = DEFAULT_PROMPT_SCHEMA_PRESET,
  ) -> io.NodeOutput:
    _ = (
      grid_columns,
      preview_pixels,
      show_captions,
      two_image_mode,
      card_aspect,
      preview_fit,
      waveform_pairs,
      prompt_schema_preset,
    )
    state = parse_reference_state(loader_state)
    output_settings = image_output_settings(
      limit_image_pixels,
      max_image_pixels,
      composite_alpha,
      alpha_background,
    )
    plan = build_reference_output_plan(state)
    prompt_document = parse_prompt_state(prompt)
    if prompt_by_order:
      prompt_document = rebind_prompt_mentions_by_order(prompt_document, state)
    compiled_prompt = compile_prompt(prompt_document, state)
    loaded = load_reference_media(state, image_output=output_settings)
    if len(loaded.images) != len(plan.image_ids):
      raise ReferenceContractError(
        "Loaded IMAGE count does not match the active image output contract."
      )
    if len(loaded.audios) != len(plan.audio_ids):
      raise ReferenceContractError(
        "Loaded AUDIO count does not match the active audio output contract."
      )
    if len(loaded.videos) != len(plan.video_ids):
      raise ReferenceContractError(
        "Loaded VIDEO count does not match the active video output contract."
      )
    manifest_json = json.dumps(
      build_reference_manifest(state, image_output=output_settings),
      ensure_ascii=False,
      sort_keys=True,
      separators=(",", ":"),
    )
    return io.NodeOutput(
      ReferenceLoaderBundle(
        images=loaded.images,
        image_captions=plan.image_captions,
        audios=loaded.audios,
        audio_captions=plan.audio_captions,
        videos=loaded.videos,
        video_captions=plan.video_captions,
        manifest_json=manifest_json,
        prompt_state_json=serialize_prompt_document(prompt_document),
        compiled_prompt=compiled_prompt,
      ),
    )


__all__ = [
  "DEFAULT_PROMPT_SCHEMA_PRESET",
  "EMPTY_LOADER_STATE_JSON",
  "EMPTY_PROMPT_STATE_JSON",
  "PROMPT_PRESET_CATALOG",
  "PROMPT_PRESET_DIRECTORY",
  "PROMPT_SCHEMA_PRESETS",
  "ReferenceLoaderNode",
  "load_prompt_preset_catalog",
]
