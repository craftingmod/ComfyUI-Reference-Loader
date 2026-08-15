import { createEmptyLoaderState, type LoaderState, type MediaItem } from "./types.ts"
import { validateLoaderState, type LoaderValidationResult } from "./validation.ts"

const MAX_LOADER_STATE_CHARACTERS = 1_000_000

function stableItems(items: Record<string, MediaItem>): Record<string, MediaItem> {
  return Object.fromEntries(
    Object.keys(items)
      .sort()
      .map((id) => [id, items[id] as MediaItem]),
  )
}

export function serializeLoaderState(state: LoaderState): string {
  const validated = validateLoaderState(state).state
  return JSON.stringify({ ...validated, items: stableItems(validated.items) })
}

export function deserializeLoaderState(value: unknown): LoaderValidationResult {
  if (typeof value === "string" && value.length > MAX_LOADER_STATE_CHARACTERS) {
    return {
      state: createEmptyLoaderState(),
      issues: ["State JSON exceeded the 1,000,000-character limit."],
    }
  }
  if (typeof value !== "string" || value.trim() === "") {
    return validateLoaderState(value ?? createEmptyLoaderState())
  }
  try {
    return validateLoaderState(JSON.parse(value) as unknown)
  } catch (error) {
    return {
      state: createEmptyLoaderState(),
      issues: [
        `State JSON could not be parsed: ${error instanceof Error ? error.message : "unknown error"}.`,
      ],
    }
  }
}
