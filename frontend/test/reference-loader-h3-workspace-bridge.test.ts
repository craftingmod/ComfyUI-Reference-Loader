import { afterEach, describe, expect, test } from "bun:test"

import {
  H3WorkspaceBridge,
  type H3WorkspaceHost,
} from "../src/reference-loader/h3-workspace-bridge.ts"

const roots: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.remove()
})

function mountedRoot(): { root: HTMLElement; surface: HTMLElement } {
  const root = document.createElement("div")
  const surface = document.createElement("div")
  root.append(surface)
  document.body.append(root)
  roots.push(root)
  return { root, surface }
}

function hostFor(
  root: HTMLElement,
  surface: HTMLElement | undefined,
  onRender: () => void = () => undefined,
): H3WorkspaceHost {
  return {
    getRoot: () => root,
    getInteractionRoot: () => surface,
    isDestroyed: () => false,
    render: onRender,
  }
}

describe("H3WorkspaceBridge", () => {
  test("preserves H3 focus targets and the source-control audio fallback", () => {
    const { root, surface } = mountedRoot()
    const bridge = new H3WorkspaceBridge(hostFor(root, surface))

    const workspace = document.createElement("section")
    workspace.dataset.h3Workspace = ""
    const collapse = document.createElement("button")
    collapse.dataset.h3Action = "collapse"
    workspace.append(collapse)
    surface.append(workspace)

    const editor = document.createElement("div")
    editor.dataset.h3Editor = ""
    const row = document.createElement("div")
    row.dataset.h3GuideId = "guide"
    const frame = document.createElement("input")
    frame.dataset.h3DraftField = "frame"
    frame.dataset.h3GuideId = "guide"
    row.append(frame)
    editor.append(row)
    surface.append(editor)

    const marker = document.createElement("button")
    marker.dataset.timelineGuide = "guide"
    surface.append(marker)

    const shot = document.createElement("button")
    shot.dataset.timelineShot = "opening"
    let shotScrolls = 0
    Object.defineProperty(shot, "scrollIntoView", { value: () => shotScrolls++ })
    surface.append(shot)

    const placement = document.createElement("button")
    placement.dataset.h3Action = "select-placement"
    placement.dataset.h3GuideId = "missing-marker"
    surface.append(placement)

    const sourceControl = document.createElement("button")
    sourceControl.dataset.action = "edit-h3-guide"
    sourceControl.dataset.id = "clip"
    sourceControl.dataset.h3Channel = "audio"
    root.append(sourceControl)

    bridge.requestRender(true, { kind: "editor-guide", guideId: "guide" })
    expect(document.activeElement).toBe(frame)

    bridge.requestRender(true, { kind: "workspace" })
    expect(document.activeElement).toBe(collapse)

    bridge.requestRender(true, { kind: "timeline-guide", guideId: "guide" })
    expect(document.activeElement).toBe(marker)

    bridge.requestRender(true, { kind: "timeline-guide", guideId: "missing-marker" })
    expect(document.activeElement).toBe(placement)

    bridge.requestRender(true, { kind: "timeline-shot", tag: "opening" })
    expect(document.activeElement).toBe(shot)
    expect(shotScrolls).toBe(0)
    bridge.requestRender(true, { kind: "timeline-shot", tag: "opening", scroll: true })
    expect(shotScrolls).toBe(1)

    bridge.requestRender(true, {
      kind: "source-control",
      mediaId: "clip:audio",
      channel: "audio",
      control: "edit",
    })
    expect(document.activeElement).toBe(sourceControl)
  })

  test("falls back to the host root when the interaction root is unavailable", () => {
    const { root } = mountedRoot()
    const bridge = new H3WorkspaceBridge(hostFor(root, undefined))
    const workspace = document.createElement("section")
    workspace.dataset.h3Workspace = ""
    const collapse = document.createElement("button")
    collapse.dataset.h3Action = "collapse"
    workspace.append(collapse)
    root.append(workspace)

    bridge.requestRender(true, { kind: "workspace" })

    expect(document.activeElement).toBe(collapse)
  })

  test("restores the active draft field after a render replaces the DOM", () => {
    const { root, surface } = mountedRoot()
    let replacement: HTMLInputElement | undefined
    const host = hostFor(root, surface, () => {
      surface.replaceChildren()
      replacement = document.createElement("input")
      replacement.dataset.h3DraftField = "frame"
      replacement.dataset.h3GuideId = "guide"
      surface.append(replacement)
    })
    const bridge = new H3WorkspaceBridge(host)
    const current = document.createElement("input")
    current.dataset.h3DraftField = "frame"
    current.dataset.h3GuideId = "guide"
    surface.append(current)
    current.focus()

    bridge.requestRender(false, { kind: "preserve-editor-focus", guideId: "guide" })

    expect(replacement).toBeDefined()
    expect(document.activeElement).toBe(replacement!)
  })

  test("keeps two bridge instances scoped to their own roots", () => {
    const first = mountedRoot()
    const second = mountedRoot()
    const firstControl = document.createElement("button")
    firstControl.dataset.action = "toggle-h3-guide"
    firstControl.dataset.id = "clip"
    firstControl.dataset.h3Channel = "visual"
    first.root.append(firstControl)
    const secondControl = document.createElement("button")
    secondControl.dataset.action = "toggle-h3-guide"
    secondControl.dataset.id = "clip"
    secondControl.dataset.h3Channel = "visual"
    second.root.append(secondControl)
    const firstBridge = new H3WorkspaceBridge(hostFor(first.root, first.surface))
    const secondBridge = new H3WorkspaceBridge(hostFor(second.root, second.surface))

    firstBridge.requestRender(true, {
      kind: "source-control",
      mediaId: "clip",
      channel: "visual",
      control: "toggle",
    })
    expect(document.activeElement).toBe(firstControl)
    secondBridge.requestRender(true, {
      kind: "source-control",
      mediaId: "clip",
      channel: "visual",
      control: "toggle",
    })
    expect(document.activeElement).toBe(secondControl)
  })

  test("makes render requests inert after destroy", () => {
    const { root, surface } = mountedRoot()
    let renders = 0
    let hostDestroyed = false
    const host = hostFor(root, surface, () => renders++)
    host.isDestroyed = () => hostDestroyed
    const bridge = new H3WorkspaceBridge(host)

    hostDestroyed = true
    bridge.requestRender(true, { kind: "workspace" })
    expect(renders).toBe(0)

    hostDestroyed = false
    bridge.destroy()
    bridge.destroy()
    bridge.requestRender(true, { kind: "workspace" })
    expect(renders).toBe(0)
  })
})
