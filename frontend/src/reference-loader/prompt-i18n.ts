import { localized, localeStore } from "./i18n.ts"
import type { LocalizedText, PromptLocale } from "./prompt-presets.ts"

const promptMessageKeys = {
  prompt: "prompt",
  subtitle: "promptSubtitle",
  subtitleWithSubjects: "promptSubtitleWithSubjects",
  preset: "preset",
  editorAria: "promptEditorAria",
  toggleAria: "toggleRawPrompt",
  clear: "clear",
  copy: "copy",
  copyAria: "copyCompiledAria",
  copyTitle: "copyTitle",
  copied: "copied",
  copyFailed: "copyFailed",
  clearAria: "clearPromptAria",
  clearTitle: "clearPromptTitle",
  cleared: "promptCleared",
  rawPlaceholder: "rawPlaceholder",
  addSectionPlaceholder: "addSectionPlaceholder",
  addSectionAria: "addPromptSection",
  bodyPlaceholder: "bodyPlaceholder",
  bodyPlaceholderWithSubjects: "bodyPlaceholderWithSubjects",
  structured: "structured",
  raw: "raw",
  backToStructured: "backToStructured",
  showRaw: "showRaw",
  invalidTitle: "invalidTitle",
  noAliases: "noAliases",
  noReferences: "noReferences",
  noSubjects: "noSubjects",
  createSubject: "createSubject",
  createSubjectDetail: "createSubjectDetail",
  legacyRecovered: "legacyRecovered",
} as const

export const PROMPT_MESSAGES = Object.fromEntries(
  Object.entries(promptMessageKeys).map(([name, key]) => [name, localized(key)]),
) as Record<keyof typeof promptMessageKeys, LocalizedText>

export function detectPromptLocale(): PromptLocale {
  return localeStore.getSnapshot() as PromptLocale
}

export function localize(text: LocalizedText, locale: PromptLocale): string {
  return text[locale]
}
