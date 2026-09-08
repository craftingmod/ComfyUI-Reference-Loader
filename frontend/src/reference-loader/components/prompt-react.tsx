import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type Ref,
  type ReactNode,
  type RefCallback,
} from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import type {
  PromptSectionSnapshot,
  PromptSectionsSnapshot,
  PromptViewSnapshot,
  ReferencePromptController,
} from "./prompt-editor.ts"

export interface PromptReactActions {
  clear(): void
  toggleView(): void
  copySource(): Promise<void>
  copyCompiled(): Promise<void>
  setPreset(value: unknown): void
  removeSection(title: string): void
}

export interface PromptReactOptions {
  container: HTMLElement
  controller: ReferencePromptController
}

export interface PromptReactMount {
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

function PromptSectionCard({
  section,
  actions,
  getBodyHost,
}: {
  section: PromptSectionSnapshot
  actions: PromptReactActions
  getBodyHost: (title: string) => RefCallback<HTMLDivElement>
}): ReactNode {
  return (
    <section
      className="rl-prompt-section"
      data-prompt-section={section.title}
      data-prompt-section-color-index={section.colorIndex}
      data-prompt-section-virtual={String(section.isVirtual)}
      style={{ "--rl-prompt-section-color": section.color } as CSSProperties}
    >
      <header className="rl-prompt-section__header">
        <button
          type="button"
          className="rl-prompt-section__drag"
          data-prompt-section-drag-handle={section.title}
          draggable
          title={section.dragTitle}
          aria-label={section.dragAria}
        >
          ⠿
        </button>
        <code>{section.title}:</code>
        <button
          type="button"
          data-prompt-action="remove-section"
          data-prompt-section-title={section.title}
          title={section.removeTitle}
          aria-label={section.removeAria}
          onClick={() => actions.removeSection(section.title)}
        >
          ×
        </button>
      </header>
      <div
        className="rl-prompt-section__body-host"
        data-prompt-section-body-host=""
        ref={getBodyHost(section.title)}
      />
    </section>
  )
}

function PromptWorkspaceHost({
  controller,
  snapshot,
  actions,
  workspaceRef,
}: {
  controller: ReferencePromptController
  snapshot: PromptViewSnapshot
  actions: PromptReactActions
  workspaceRef: Ref<HTMLDivElement>
}): ReactNode {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => controller.subscribeSections(listener),
    [controller],
  )
  const getSnapshot = useCallback(
    (): PromptSectionsSnapshot => controller.getSectionsSnapshot(),
    [controller],
  )
  const sections = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const bodyHosts = useRef(new Map<string, HTMLElement>())
  const bodyCallbacks = useRef(new Map<string, RefCallback<HTMLDivElement>>())
  const entryHost = useRef<HTMLElement | undefined>(undefined)
  const rawEditorHost = useRef<HTMLElement | undefined>(undefined)
  const getBodyHost = useCallback((title: string): RefCallback<HTMLDivElement> => {
    const existing = bodyCallbacks.current.get(title)
    if (existing) return existing
    const callback: RefCallback<HTMLDivElement> = (host) => {
      if (host) bodyHosts.current.set(title, host)
      else bodyHosts.current.delete(title)
    }
    bodyCallbacks.current.set(title, callback)
    return callback
  }, [])
  const setEntryHost = useCallback<RefCallback<HTMLDivElement>>((host) => {
    entryHost.current = host ?? undefined
  }, [])
  const setRawEditorHost = useCallback<RefCallback<HTMLDivElement>>((host) => {
    rawEditorHost.current = host ?? undefined
  }, [])

  useLayoutEffect(() => {
    controller.mountSectionHosts(bodyHosts.current, entryHost.current)
    controller.mountRawEditorHost(rawEditorHost.current)
  })

  useLayoutEffect(
    () => () => {
      controller.unmountSectionHosts()
      controller.unmountRawEditorHost()
      bodyHosts.current.clear()
      bodyCallbacks.current.clear()
      entryHost.current = undefined
      rawEditorHost.current = undefined
    },
    [controller],
  )

  return (
    <div data-prompt-workspace="" ref={workspaceRef}>
      {snapshot.view === "raw" ? (
        <div key="raw" data-prompt-editor-host="" ref={setRawEditorHost} />
      ) : (
        <div key="structured" className="rl-prompt-stack" data-prompt-stack="">
          {sections.sections.map((section) => (
            <PromptSectionCard
              key={section.title}
              section={section}
              actions={actions}
              getBodyHost={getBodyHost}
            />
          ))}
          <div data-prompt-section-entry-host="" ref={setEntryHost} />
        </div>
      )}
    </div>
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
      <PromptWorkspaceHost
        controller={controller}
        snapshot={snapshot}
        actions={actions}
        workspaceRef={workspaceRef}
      />
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
    removeSection: (title) => controller.removeSection(title),
  }
  const root: Root = createRoot(options.container)
  let destroyed = false
  const update = (): void => {
    if (destroyed) return
    flushSync(() =>
      root.render(<ReferencePromptReactRoot controller={controller} actions={actions} />),
    )
  }
  update()
  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      root.unmount()
      options.container.replaceChildren()
    },
  }
}

export { PromptToolbar }
