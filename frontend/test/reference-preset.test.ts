import { describe, expect, test } from "bun:test"

import {
  DEFAULT_PROMPT_PRESET_ID,
  PROMPT_PRESETS,
  PROMPT_PRESET_IDS,
  resolvePromptPreset,
} from "../src/reference-loader/prompt-presets.ts"
import { isPromptSectionTitle } from "../src/reference-loader/prompt-state.ts"

describe("Reference Prompt presets", () => {
  test("exposes stable preset ids and falls back to generic", () => {
    expect(PROMPT_PRESET_IDS).toEqual([
      "generic",
      "minimax_h3_base",
      "minimax_h3_reference",
      "freeform",
    ])
    expect(DEFAULT_PROMPT_PRESET_ID).toBe("generic")
    expect(resolvePromptPreset("unknown").id).toBe("generic")
    expect(resolvePromptPreset(undefined).id).toBe("generic")
  })

  test("keeps H3 base and reference fields exact and ordered", () => {
    expect(resolvePromptPreset("minimax_h3_base").aliases.map((alias) => alias.title)).toEqual([
      "integrated_multimodal_description",
      "overall_soundscape",
      "non_diegetic_music",
    ])
    expect(resolvePromptPreset("minimax_h3_reference").aliases.map((alias) => alias.title)).toEqual(
      [
        "subject_definitions",
        "summary",
        "retention_analysis",
        "detailed_description",
        "overall_soundscape",
        "non_diegetic_music",
      ],
    )
  })

  test("enables Subject authoring only for Generic and H3 Reference", () => {
    expect(resolvePromptPreset("generic").subjectMode).toBe("anywhere")
    expect(resolvePromptPreset("minimax_h3_reference").subjectMode).toBe("definitions")
    expect(resolvePromptPreset("minimax_h3_base").subjectMode).toBe("disabled")
    expect(resolvePromptPreset("freeform").subjectMode).toBe("disabled")
  })

  test("provides valid unique aliases and complete Korean and English copy", () => {
    for (const preset of PROMPT_PRESETS) {
      expect(isPromptSectionTitle(preset.defaultSectionTitle)).toBe(true)
      expect(preset.label.en).not.toBe("")
      expect(preset.label.ko).not.toBe("")
      expect(preset.description.en).not.toBe("")
      expect(preset.description.ko).not.toBe("")
      expect(new Set(preset.aliases.map((alias) => alias.command)).size).toBe(preset.aliases.length)
      for (const alias of preset.aliases) {
        expect(alias.command).toMatch(/^[a-z]+$/)
        expect(isPromptSectionTitle(alias.title)).toBe(true)
        expect(alias.label.en).not.toBe("")
        expect(alias.label.ko).not.toBe("")
        expect(alias.description.en).not.toBe("")
        expect(alias.description.ko).not.toBe("")
      }
    }
  })
})
