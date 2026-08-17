import type { ComfyNode } from "../comfyui.ts"
import { deserializePromptDocument, validatePromptDocument } from "./prompt-state.ts"
import { deserializeLoaderState, serializeLoaderState } from "./serialization.ts"

export const REFERENCE_LOADER_SNAPSHOT_FORMAT = "reference-loader-snapshot" as const
export const REFERENCE_LOADER_SNAPSHOT_VERSION = 1 as const
export const REFERENCE_LOADER_SNAPSHOT_FILENAME = "reference-loader-snapshot.json"
export const MAX_REFERENCE_LOADER_SNAPSHOT_CHARACTERS = 1_500_000
export const MAX_REFERENCE_LOADER_SNAPSHOT_BYTES = 6_000_000

export interface ReferenceLoaderSnapshotSettings {
  limitImagePixels: boolean
  maxImagePixels: number
  compositeAlpha: boolean
  alphaBackground: string
  promptSchemaPreset: string
  showCaptions: boolean
  twoImageMode: boolean
  promptByOrder: boolean
}

export interface ParsedReferenceLoaderSnapshot {
  loaderState: string
  promptState: string
  settings: ReferenceLoaderSnapshotSettings
}

interface SnapshotSource {
  loaderState: string
  promptState: string
  settings: ReferenceLoaderSnapshotSettings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`)
  return value
}

function requiredNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number.`)
  if (value < minimum || value > maximum)
    throw new Error(`${path} must be between ${minimum} and ${maximum}.`)
  return value
}

function requiredString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${path} must be a non-empty string of at most ${maximum} characters.`)
  return value
}

function parseSettings(value: unknown): ReferenceLoaderSnapshotSettings {
  if (!isRecord(value)) throw new Error("Snapshot node_settings must be an object.")
  const alphaBackground = requiredString(value.alpha_background, "alpha_background", 9)
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(alphaBackground))
    throw new Error("alpha_background must be a #RRGGBB or #RRGGBBAA color.")
  return {
    limitImagePixels: requiredBoolean(value.limit_image_pixels, "limit_image_pixels"),
    maxImagePixels: requiredNumber(value.max_image_pixels, "max_image_pixels", 0.25, 40),
    compositeAlpha: requiredBoolean(value.composite_alpha, "composite_alpha"),
    alphaBackground,
    promptSchemaPreset: requiredString(value.prompt_schema_preset, "prompt_schema_preset", 128),
    showCaptions: requiredBoolean(value.show_captions, "show_captions"),
    twoImageMode: requiredBoolean(value.two_image_mode, "two_image_mode"),
    promptByOrder: requiredBoolean(value.prompt_by_order, "prompt_by_order"),
  }
}

function serializedSettings(settings: ReferenceLoaderSnapshotSettings): Record<string, unknown> {
  return {
    limit_image_pixels: settings.limitImagePixels,
    max_image_pixels: settings.maxImagePixels,
    composite_alpha: settings.compositeAlpha,
    alpha_background: settings.alphaBackground,
    prompt_schema_preset: settings.promptSchemaPreset,
    show_captions: settings.showCaptions,
    two_image_mode: settings.twoImageMode,
    prompt_by_order: settings.promptByOrder,
  }
}

function activeImageCount(loaderState: string): number {
  const state = JSON.parse(loaderState) as {
    items: Record<string, { kind?: unknown; imageEnabled?: unknown }>
  }
  return Object.values(state.items).filter(
    (item) => item.kind === "image" && item.imageEnabled === true,
  ).length
}

export function serializeReferenceLoaderSnapshot(source: SnapshotSource): string {
  const loader = deserializeLoaderState(source.loaderState)
  if (loader.issues.length > 0)
    throw new Error(`Loader state is invalid: ${loader.issues.join(" ")}`)
  const promptInput = JSON.parse(source.promptState) as unknown
  const prompt = validatePromptDocument(promptInput)
  if (prompt.issues.length > 0)
    throw new Error(`Prompt state is invalid: ${prompt.issues.join(" ")}`)
  const loaderState = serializeLoaderState(loader.state)
  const settings = parseSettings(serializedSettings(source.settings))
  if (settings.twoImageMode && activeImageCount(loaderState) > 2)
    throw new Error("Two-image mode cannot be saved with more than two enabled Images.")
  const serialized = JSON.stringify(
    {
      format: REFERENCE_LOADER_SNAPSHOT_FORMAT,
      version: REFERENCE_LOADER_SNAPSHOT_VERSION,
      loader_state: JSON.parse(loaderState) as unknown,
      prompt_state: prompt.document,
      node_settings: serializedSettings(settings),
    },
    null,
    2,
  )
  if (serialized.length > MAX_REFERENCE_LOADER_SNAPSHOT_CHARACTERS)
    throw new Error("Snapshot exceeds the 1,500,000-character limit.")
  return serialized
}

export function parseReferenceLoaderSnapshot(value: string): ParsedReferenceLoaderSnapshot {
  if (value.length > MAX_REFERENCE_LOADER_SNAPSHOT_CHARACTERS)
    throw new Error("Snapshot exceeds the 1,500,000-character limit.")
  let raw: unknown
  try {
    raw = JSON.parse(value) as unknown
  } catch {
    throw new Error("Snapshot must contain valid JSON.")
  }
  if (!isRecord(raw)) throw new Error("Snapshot must contain an object.")
  if (raw.format !== REFERENCE_LOADER_SNAPSHOT_FORMAT)
    throw new Error(`Snapshot format must be ${REFERENCE_LOADER_SNAPSHOT_FORMAT}.`)
  if (raw.version !== REFERENCE_LOADER_SNAPSHOT_VERSION)
    throw new Error(`Snapshot version must be ${REFERENCE_LOADER_SNAPSHOT_VERSION}.`)

  const loader = deserializeLoaderState(raw.loader_state)
  if (loader.issues.length > 0)
    throw new Error(`Snapshot Loader state is invalid: ${loader.issues.join(" ")}`)
  const prompt = deserializePromptDocument(JSON.stringify(raw.prompt_state))
  if (prompt.issues.length > 0)
    throw new Error(`Snapshot Prompt state is invalid: ${prompt.issues.join(" ")}`)
  const settings = parseSettings(raw.node_settings)
  const loaderState = serializeLoaderState(loader.state)
  if (settings.twoImageMode && activeImageCount(loaderState) > 2)
    throw new Error("Snapshot enables two-image mode with more than two enabled Images.")
  return {
    loaderState,
    promptState: prompt.recoveredFromVersion
      ? JSON.stringify(raw.prompt_state)
      : JSON.stringify(prompt.document),
    settings,
  }
}

function widgetValue(node: ComfyNode, name: string, fallback: unknown): unknown {
  return node.widgets?.find((widget) => widget.name === name)?.value ?? fallback
}

export function captureReferenceLoaderSnapshotSettings(
  node: ComfyNode,
  display: Pick<ReferenceLoaderSnapshotSettings, "showCaptions" | "twoImageMode" | "promptByOrder">,
  promptSchemaPreset: string,
): ReferenceLoaderSnapshotSettings {
  return {
    limitImagePixels: widgetValue(node, "limit_image_pixels", false) === true,
    maxImagePixels: Number(widgetValue(node, "max_image_pixels", 2)),
    compositeAlpha: widgetValue(node, "composite_alpha", false) === true,
    alphaBackground: String(widgetValue(node, "alpha_background", "#000000")),
    promptSchemaPreset,
    ...display,
  }
}

export function applyReferenceLoaderSnapshotSettings(
  node: ComfyNode,
  settings: ReferenceLoaderSnapshotSettings,
): void {
  const values: Record<string, unknown> = {
    limit_image_pixels: settings.limitImagePixels,
    max_image_pixels: settings.maxImagePixels,
    composite_alpha: settings.compositeAlpha,
    alpha_background: settings.alphaBackground,
    prompt_schema_preset: settings.promptSchemaPreset,
  }
  for (const [name, value] of Object.entries(values)) {
    const widget = node.widgets?.find((candidate) => candidate.name === name)
    if (widget) widget.value = value as typeof widget.value
  }
}
