import freeformPreset from "../../../presets/prompt/freeform.json"
import genericPreset from "../../../presets/prompt/generic.json"
import minimaxH3BasePreset from "../../../presets/prompt/minimax_h3_base.json"
import minimaxH3ReferencePreset from "../../../presets/prompt/minimax_h3_reference.json"

export type PromptLocale = "en" | "ko"
export type PromptSubjectMode = "anywhere" | "definitions" | "disabled"

export interface LocalizedText {
  en: string
  ko: string
}

export interface PromptAlias {
  command: string
  title: string
  label: LocalizedText
  description: LocalizedText
  icon: string
}

export interface PromptPreset {
  id: string
  label: LocalizedText
  description: LocalizedText
  defaultSectionTitle: string
  subjectMode: PromptSubjectMode
  aliases: readonly PromptAlias[]
}

export interface PromptPresetCatalog {
  version: 1
  defaultPresetId: string
  presets: readonly PromptPreset[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLocalizedText(value: unknown): value is LocalizedText {
  return isRecord(value) && typeof value.en === "string" && typeof value.ko === "string"
}

function parseAlias(value: unknown): PromptAlias | undefined {
  if (
    !isRecord(value) ||
    typeof value.command !== "string" ||
    !/^[a-z]+$/u.test(value.command) ||
    typeof value.title !== "string" ||
    !/^[a-z][a-z0-9_]*$/u.test(value.title) ||
    !isLocalizedText(value.label) ||
    !isLocalizedText(value.description) ||
    typeof value.icon !== "string"
  )
    return undefined
  return {
    command: value.command,
    title: value.title,
    label: value.label,
    description: value.description,
    icon: value.icon,
  }
}

function parsePreset(value: unknown): PromptPreset | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9_]*$/u.test(value.id) ||
    !isLocalizedText(value.label) ||
    !isLocalizedText(value.description) ||
    typeof value.defaultSectionTitle !== "string" ||
    !/^[a-z][a-z0-9_]*$/u.test(value.defaultSectionTitle) ||
    (value.subjectMode !== "anywhere" &&
      value.subjectMode !== "definitions" &&
      value.subjectMode !== "disabled") ||
    !Array.isArray(value.aliases)
  )
    return undefined
  const aliases = value.aliases.map(parseAlias)
  if (aliases.some((alias) => alias === undefined)) return undefined
  const parsedAliases = aliases as PromptAlias[]
  if (new Set(parsedAliases.map((alias) => alias.command)).size !== parsedAliases.length)
    return undefined
  return {
    id: value.id,
    label: value.label,
    description: value.description,
    defaultSectionTitle: value.defaultSectionTitle,
    subjectMode: value.subjectMode,
    aliases: parsedAliases,
  }
}

function parseCatalog(value: unknown): PromptPresetCatalog | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.defaultPresetId !== "string" ||
    !Array.isArray(value.presets)
  )
    return undefined
  const presets = value.presets.map(parsePreset)
  if (presets.length === 0 || presets.some((preset) => preset === undefined)) return undefined
  const parsedPresets = presets as PromptPreset[]
  if (new Set(parsedPresets.map((preset) => preset.id)).size !== parsedPresets.length)
    return undefined
  if (!parsedPresets.some((preset) => preset.id === value.defaultPresetId)) return undefined
  return {
    version: 1,
    defaultPresetId: value.defaultPresetId,
    presets: parsedPresets,
  }
}

function catalogFromPresetFiles(values: readonly unknown[]): PromptPresetCatalog | undefined {
  const entries = values.map((value) => {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.order !== "number" ||
      !Number.isInteger(value.order) ||
      typeof value.default !== "boolean"
    )
      return undefined
    const preset = parsePreset(value)
    return preset ? { order: value.order, default: value.default, preset } : undefined
  })
  if (entries.length === 0 || entries.some((entry) => entry === undefined)) return undefined
  const parsedEntries = entries as Array<{
    order: number
    default: boolean
    preset: PromptPreset
  }>
  if (new Set(parsedEntries.map((entry) => entry.order)).size !== parsedEntries.length)
    return undefined
  const defaults = parsedEntries.filter((entry) => entry.default)
  if (defaults.length !== 1) return undefined
  parsedEntries.sort(
    (left, right) => left.order - right.order || left.preset.id.localeCompare(right.preset.id),
  )
  return parseCatalog({
    version: 1,
    defaultPresetId: defaults[0]!.preset.id,
    presets: parsedEntries.map((entry) => entry.preset),
  })
}

const bundledCatalog = catalogFromPresetFiles([
  genericPreset,
  minimaxH3BasePreset,
  minimaxH3ReferencePreset,
  freeformPreset,
])
if (!bundledCatalog) throw new Error("Bundled prompt preset catalog is invalid.")

export const PROMPT_PRESET_CATALOG = bundledCatalog
export const DEFAULT_PROMPT_PRESET_ID = PROMPT_PRESET_CATALOG.defaultPresetId
export const PROMPT_PRESETS = PROMPT_PRESET_CATALOG.presets
export const PROMPT_PRESET_IDS = PROMPT_PRESETS.map((preset) => preset.id)

export function normalizePromptPresetCatalog(value: unknown): PromptPresetCatalog {
  return parseCatalog(value) ?? PROMPT_PRESET_CATALOG
}

export function normalizePromptPresetId(
  value: unknown,
  catalog: PromptPresetCatalog = PROMPT_PRESET_CATALOG,
): string {
  return typeof value === "string" && catalog.presets.some((preset) => preset.id === value)
    ? value
    : catalog.defaultPresetId
}

export function resolvePromptPreset(
  value: unknown,
  catalog: PromptPresetCatalog = PROMPT_PRESET_CATALOG,
): PromptPreset {
  const id = normalizePromptPresetId(value, catalog)
  return catalog.presets.find((preset) => preset.id === id) ?? catalog.presets[0]!
}
