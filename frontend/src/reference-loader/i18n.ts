import { useSyncExternalStore } from "react"

import enMessages from "../../../locales/en/main.json"
import koMessages from "../../../locales/ko/main.json"
import type { ComfyLocaleAppLike } from "../comfyui.ts"

export type Locale = "en" | "ko"
export type MessageKey = keyof typeof enMessages.referenceLoader
export type MessageParams = Readonly<Record<string, string | number>>
export type UiMessage =
  | { kind: "localized"; key: MessageKey; params?: MessageParams }
  | { kind: "raw"; value: string }

const resources = {
  en: enMessages,
  ko: koMessages,
} as const

export function resolveLocale(input: unknown): Locale {
  if (typeof input !== "string") return "en"
  return input.trim().toLocaleLowerCase().startsWith("ko") ? "ko" : "en"
}

export function detectLocale(): Locale {
  const language =
    globalThis.document?.documentElement.lang || globalThis.navigator?.language || "en"
  return resolveLocale(language)
}

const COMFY_LOCALE_SETTING = "Comfy.Locale"
const COMFY_LOCALE_CHANGE_EVENT = `${COMFY_LOCALE_SETTING}.change`

function interpolate(value: string, params: MessageParams | undefined): string {
  if (!params) return value
  return value.replace(/\{([\w]+)\}/gu, (match, key: string) => {
    const replacement = params[key]
    return replacement === undefined ? match : String(replacement)
  })
}

export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const localized = resources[locale].referenceLoader[key]
  const fallback = resources.en.referenceLoader[key]
  const value = typeof localized === "string" ? localized : fallback
  return interpolate(value, params)
}

export function uiMessage(key: MessageKey, params?: MessageParams): UiMessage {
  return { kind: "localized", key, params }
}

export function formatUiMessage(message: UiMessage, locale: Locale): string {
  return message.kind === "localized" ? t(locale, message.key, message.params) : message.value
}

export function translateRaw(locale: Locale, value: string): string {
  const entry = Object.entries(enMessages.referenceLoader).find(([, message]) => message === value)
  return entry ? t(locale, entry[0] as MessageKey) : value
}

export function localized(key: MessageKey): { en: string; ko: string } {
  return { en: t("en", key), ko: t("ko", key) }
}

export class LocaleStore {
  #locale: Locale
  #listeners = new Set<() => void>()
  #observer: MutationObserver | undefined

  constructor(initialLocale: unknown = detectLocale()) {
    this.#locale = resolveLocale(initialLocale)
  }

  getSnapshot = (): Locale => this.#locale

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    this.#startObserver()
    return () => this.#listeners.delete(listener)
  }

  set(input: unknown): void {
    const next = resolveLocale(input)
    if (next === this.#locale) return
    this.#locale = next
    for (const listener of this.#listeners) listener()
  }

  dispose(): void {
    this.#observer?.disconnect()
    this.#observer = undefined
    this.#listeners.clear()
  }

  #startObserver(): void {
    if (this.#observer || typeof MutationObserver === "undefined") return
    const element = globalThis.document?.documentElement
    if (!element) return
    this.#observer = new MutationObserver(() => {
      this.set(element.lang)
    })
    this.#observer.observe(element, { attributes: true, attributeFilter: ["lang"] })
  }
}

export const localeStore = new LocaleStore()

export function bindComfyLocale(app: ComfyLocaleAppLike): () => void {
  const configuredLocale = app.extensionManager?.setting.get<unknown>(COMFY_LOCALE_SETTING)
  if (configuredLocale !== undefined) localeStore.set(configuredLocale)

  const settings = app.ui?.settings
  if (!settings) return () => undefined

  const handleLocaleChange = (event: Event): void => {
    const value = (event as CustomEvent<{ value?: unknown }>).detail?.value
    if (value !== undefined) localeStore.set(value)
  }
  settings.addEventListener(COMFY_LOCALE_CHANGE_EVENT, handleLocaleChange)

  return () => settings.removeEventListener(COMFY_LOCALE_CHANGE_EVENT, handleLocaleChange)
}

export function setLocale(input: unknown): void {
  localeStore.set(input)
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    localeStore.subscribe,
    localeStore.getSnapshot,
    localeStore.getSnapshot,
  )
}

export function useI18n(): {
  locale: Locale
  t(key: MessageKey, params?: MessageParams): string
} {
  const locale = useLocale()
  return { locale, t: (key, params) => t(locale, key, params) }
}

export function messageKeyParity(): { missingInKo: string[]; extraInKo: string[] } {
  const englishKeys = new Set(Object.keys(enMessages.referenceLoader))
  const koreanKeys = new Set(Object.keys(koMessages.referenceLoader))
  return {
    missingInKo: [...englishKeys].filter((key) => !koreanKeys.has(key)),
    extraInKo: [...koreanKeys].filter((key) => !englishKeys.has(key)),
  }
}
