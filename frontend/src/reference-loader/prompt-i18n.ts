import type { LocalizedText, PromptLocale } from "./prompt-presets.ts"

export const PROMPT_MESSAGES = {
  prompt: { en: "Prompt", ko: "프롬프트" },
  subtitle: {
    en: "Stack sections by title · @ media · / alias",
    ko: "제목별 섹션 · @ 미디어 · / alias",
  },
  subtitleWithSubjects: {
    en: "Stack sections by title · @ media · # subjects · / alias",
    ko: "제목별 섹션 · @ 미디어 · # 피사체 · / alias",
  },
  preset: { en: "Preset", ko: "프리셋" },
  editorAria: { en: "Reference Prompt editor", ko: "참조 프롬프트 편집기" },
  toggleAria: { en: "Toggle raw prompt view", ko: "Raw 프롬프트 보기 전환" },
  clear: { en: "Clear", ko: "지우기" },
  copy: { en: "Copy", ko: "복사" },
  copyAria: { en: "Copy compiled Prompt", ko: "컴파일된 프롬프트 복사" },
  copyTitle: {
    en: "Copy the current compiled pseudo-YAML Prompt",
    ko: "현재 컴파일된 pseudo-YAML 프롬프트를 복사합니다.",
  },
  copied: { en: "Prompt copied.", ko: "프롬프트를 복사했습니다." },
  copyFailed: {
    en: "Could not access the clipboard.",
    ko: "클립보드에 접근할 수 없습니다.",
  },
  clearAria: { en: "Clear Prompt", ko: "프롬프트 지우기" },
  clearTitle: {
    en: "Clear all Prompt sections. Media is preserved.",
    ko: "모든 프롬프트 섹션을 지웁니다. 미디어는 유지됩니다.",
  },
  cleared: {
    en: "Prompt cleared. Media preserved.",
    ko: "프롬프트를 지웠습니다. 미디어는 유지됩니다.",
  },
  rawPlaceholder: {
    en: "Pseudo-YAML prompt. Every title: line becomes a section.",
    ko: "Pseudo-YAML 프롬프트입니다. 각 title: 줄이 섹션이 됩니다.",
  },
  addSectionPlaceholder: {
    en: "Add section: title_tag: or /alias",
    ko: "섹션 추가: title_tag: 또는 /alias",
  },
  addSectionAria: { en: "Add prompt section", ko: "프롬프트 섹션 추가" },
  bodyPlaceholder: {
    en: "Write this section. Type @ for media.",
    ko: "섹션 내용을 입력하세요. 미디어는 @을 사용합니다.",
  },
  bodyPlaceholderWithSubjects: {
    en: "Write this section. Type @ for media or # for subjects.",
    ko: "섹션 내용을 입력하세요. 미디어는 @, 피사체는 #을 사용합니다.",
  },
  structured: { en: "@ Structured", ko: "@ 구조화" },
  raw: { en: "</> Raw", ko: "</> Raw" },
  backToStructured: { en: "Back to section stack", ko: "섹션 Stack으로 돌아가기" },
  showRaw: { en: "Show literal pseudo-YAML prompt", ko: "원본 pseudo-YAML 프롬프트 보기" },
  invalidTitle: {
    en: "Use a lowercase title_tag: or choose a /alias.",
    ko: "소문자 title_tag:를 입력하거나 /alias를 선택하세요.",
  },
  noAliases: { en: "No aliases match.", ko: "일치하는 alias가 없습니다." },
  noReferences: { en: "No references match.", ko: "일치하는 참조가 없습니다." },
  noSubjects: {
    en: "No subjects match. Type a name where subject creation is allowed.",
    ko: "일치하는 피사체가 없습니다. 피사체를 만들 수 있는 섹션에서 이름을 입력하세요.",
  },
  createSubject: { en: "Create #{label}", ko: "#{label} 만들기" },
  createSubjectDetail: {
    en: "Adds a stable subject reference",
    ko: "안정적인 피사체 참조를 추가합니다.",
  },
  legacyRecovered: {
    en: "Legacy Prompt v{version} was recovered as Raw. Review it before switching to Structured.",
    ko: "이전 Prompt v{version}을 Raw로 복구했습니다. Structured로 전환하기 전에 내용을 확인하세요.",
  },
} satisfies Record<string, LocalizedText>

export function detectPromptLocale(): PromptLocale {
  const language =
    globalThis.document?.documentElement.lang || globalThis.navigator?.language || "en"
  return language.toLocaleLowerCase().startsWith("ko") ? "ko" : "en"
}

export function localize(text: LocalizedText, locale: PromptLocale): string {
  return text[locale]
}
