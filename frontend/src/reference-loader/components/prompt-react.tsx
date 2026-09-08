import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import type { PromptViewSnapshot, ReferencePromptController } from "./prompt-editor.ts"

export interface PromptReactActions {
  clear(): void
  toggleView(): void
  copySource(): Promise<void>
  copyCompiled(): Promise<void>
  setPreset(value: unknown): void
}

export interface PromptReactOptions {
  container: HTMLElement
  controller: ReferencePromptController
}

export interface PromptReactMount {
  update(): void
  destroy(): void
}

function PromptToolbar({
  snapshot,
  actions,
}: {
  snapshot: PromptViewSnapshot
  actions: PromptReactActions
}): ReactNode {
  const raw = snapshot.view === "raw"
  return (
    <header className="rl-prompt-toolbar">
      <div className="rl-prompt-toolbar__copy">
        <span className="rl-prompt-toolbar__title">
          <strong data-prompt-title="">{snapshot.title}</strong>
          <span
            className="rl-prompt-preset"
            data-prompt-preset=""
            title={`Preset: ${snapshot.presetLabel} · ${snapshot.presetDescription}`}
          >
            {snapshot.presetLabel}
          </span>
        </span>
        <small data-prompt-subtitle="">{snapshot.subtitle}</small>
      </div>
      <div className="rl-prompt-toolbar__actions">
        <button
          type="button"
          data-prompt-action="copy-source"
          title="Copy source with #tags"
          disabled={snapshot.sourceText.length === 0}
          onClick={() => void actions.copySource()}
        >
          Copy source
        </button>
        <button
          type="button"
          data-prompt-action="copy-compiled"
          title="Copy compiled model prompt"
          disabled={snapshot.compiledText.length === 0}
          onClick={() => void actions.copyCompiled()}
        >
          Copy compiled
        </button>
        <button
          type="button"
          className="rl-clear"
          data-prompt-action="clear"
          title={snapshot.clearTitle}
          aria-label={snapshot.clearAria}
          disabled={!snapshot.canClear}
          onClick={actions.clear}
        >
          {snapshot.clearLabel}
        </button>
        <button
          type="button"
          data-prompt-action="toggle-view"
          title={raw ? snapshot.backToStructuredTitle : snapshot.showRawTitle}
          aria-label={snapshot.toggleAria}
          aria-pressed={raw}
          onClick={actions.toggleView}
        >
          {raw ? snapshot.structuredLabel : snapshot.rawLabel}
        </button>
      </div>
    </header>
  )
}

export function ReferencePromptReactRoot({
  controller,
  actions,
}: {
  controller: ReferencePromptController
  actions: PromptReactActions
}): ReactNode {
  const workspaceRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const subscribe = (listener: () => void): (() => void) => controller.subscribeView(listener)
  const getSnapshot = (): PromptViewSnapshot => controller.getViewSnapshot()
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    controller.mountNativeHosts(workspaceRef.current ?? undefined, pickerRef.current ?? undefined)
    return () => controller.unmountNativeHosts()
  }, [controller])

  return (
    <section
      className="rl-prompt-panel"
      data-prompt-panel=""
      aria-label={snapshot.editorAria}
      data-prompt-workspace-mounted={String(snapshot.nativeHosts.workspace)}
      data-prompt-picker-mounted={String(snapshot.nativeHosts.picker)}
      data-prompt-definitions-mounted={String(snapshot.nativeHosts.definitions)}
    >
      <PromptToolbar snapshot={snapshot} actions={actions} />
      <div data-prompt-workspace="" ref={workspaceRef} />
      <div data-prompt-picker-host="" ref={pickerRef} />
      <p className="rl-prompt-hint" data-prompt-hint="" hidden={!snapshot.hint}>
        {snapshot.hint}
      </p>
    </section>
  )
}

export function createPromptReact(options: PromptReactOptions): PromptReactMount {
  const { controller } = options
  const actions: PromptReactActions = {
    clear: () => controller.clear(),
    toggleView: () => controller.toggleView(),
    copySource: () => controller.copySource(),
    copyCompiled: () => controller.copyCompiled(),
    setPreset: (value) => controller.setPreset(value),
  }
  const root: Root = createRoot(options.container)
  const update = (): void => {
    flushSync(() =>
      root.render(<ReferencePromptReactRoot controller={controller} actions={actions} />),
    )
  }
  update()
  return {
    update,
    destroy() {
      root.unmount()
      options.container.replaceChildren()
    },
  }
}

export const mountPromptReact = createPromptReact

export { PromptToolbar }
