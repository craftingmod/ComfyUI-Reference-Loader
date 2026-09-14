import { describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import {
  bindComfyLocale,
  formatUiMessage,
  LocaleStore,
  messageKeyParity,
  resolveLocale,
  localeStore,
  t,
  translateGuideBadge,
  translateRaw,
  uiMessage,
} from "../src/reference-loader/i18n.ts"
import { detectPromptLocale } from "../src/reference-loader/prompt-i18n.ts"
import {
  serializePromptDocumentV6,
  createEmptyPromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

const node: ComfyNode = {
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

describe("Reference Loader i18n", () => {
  test("resolves supported and unsupported locale values", () => {
    expect(resolveLocale("ko")).toBe("ko")
    expect(resolveLocale("ko-KR")).toBe("ko")
    expect(resolveLocale("fr-FR")).toBe("en")
    expect(resolveLocale("")).toBe("en")
    expect(resolveLocale(undefined)).toBe("en")
  })

  test("translates namespaced messages and interpolates parameters", () => {
    expect(t("en", "referenceCountMany", { count: 3 })).toBe("3 references")
    expect(t("ko", "referenceCountMany", { count: 3 })).toBe("참조 3개")
    expect(messageKeyParity()).toEqual({ missingInKo: [], extraInKo: [] })
    expect(formatUiMessage(uiMessage("clear"), "ko")).toBe("지우기")
    expect(formatUiMessage({ kind: "raw", value: "server detail" }, "ko")).toBe("server detail")
    expect(translateRaw("ko", "Snapshot saved.")).toBe("스냅샷을 저장했습니다.")
    expect(translateRaw("ko", "file.png: server detail")).toBe("file.png: server detail")
    expect(translateGuideBadge("en", { kind: "reference", index: 1 })).toBe("Ref #1")
    expect(translateGuideBadge("ko", { kind: "reference", index: 1 })).toBe("참조 #1")
    expect(translateGuideBadge("en", { kind: "guide", index: 1 })).toBe("Guide #1")
    expect(translateGuideBadge("ko", { kind: "guide", index: 1 })).toBe("가이드 #1")
    expect(translateGuideBadge("ko", { kind: "off" })).toBe("가이드 꺼짐")
    expect(translateGuideBadge("ko", { kind: "paused" })).toBe("일시정지")
  })

  test("notifies only when LocaleStore changes and supports disposal", () => {
    const store = new LocaleStore("en")
    let notifications = 0
    const release = store.subscribe(() => {
      notifications += 1
    })

    store.set("en")
    expect(notifications).toBe(0)
    store.set("ko-KR")
    expect(store.getSnapshot()).toBe("ko")
    expect(notifications).toBe(1)
    release()
    store.set("en")
    expect(notifications).toBe(1)
    store.dispose()
  })

  test("binds the Comfy.Locale setting and change event", () => {
    const settings = new EventTarget()
    const app = {
      registerExtension: () => undefined,
      extensionManager: {
        setting: {
          get: <T>() => "ko" as T,
        },
      },
      ui: { settings },
    }

    localeStore.set("en")
    const release = bindComfyLocale(app)
    expect(localeStore.getSnapshot()).toBe("ko")
    expect(detectPromptLocale()).toBe("ko")

    settings.dispatchEvent(new CustomEvent("Comfy.Locale.change", { detail: { value: "en" } }))
    expect(localeStore.getSnapshot()).toBe("en")

    release()
    settings.dispatchEvent(new CustomEvent("Comfy.Locale.change", { detail: { value: "ko" } }))
    expect(localeStore.getSnapshot()).toBe("en")
  })

  test("updates prompt view labels without changing prompt state or compiled output", () => {
    const serialized = serializePromptDocumentV6(createEmptyPromptDocumentV6())
    const controller = new ReferencePromptController(node, () => [], serialized, { locale: "en" })
    const before = controller.getViewSnapshot()
    const compiledBefore = controller.compiledPrompt
    let notifications = 0
    const release = controller.subscribeView(() => {
      notifications += 1
    })

    controller.setLocale("ko")
    const after = controller.getViewSnapshot()

    expect(before.clearLabel).toBe("Clear")
    expect(after.clearLabel).toBe("지우기")
    expect(notifications).toBe(2)
    expect(controller.serialize()).toBe(serialized)
    expect(controller.compiledPrompt).toBe(compiledBefore)

    release()
    controller.destroy()
  })
})
