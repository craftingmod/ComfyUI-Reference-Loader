import {
  canUseAsH3Guide,
  cloneH3Timeline,
  guideUsesMedia,
  mediaGuideEnabled,
  mediaHasGuide,
  pruneDisabledGuideMedia,
  referenceEnabled,
  setMediaGuideEnabled,
  timelineMediaId,
  validateH3Timeline,
  type H3GuideChannel,
  type H3TimelinePlacement,
} from "./h3-media-guides.ts"
import type { PromptShot } from "./prompt-v6.ts"
import type { LoaderAction } from "./reducer.ts"
import type { H3TimelineState, LoaderState, MediaItem } from "./types.ts"
import type { H3EditorView, H3Selection, H3WorkspaceView } from "./view-model.ts"

export type H3GuidePosition = "start" | "guide" | "end"

export type H3TimelineFocus =
  | { kind: "editor-guide"; guideId: string }
  | { kind: "workspace" }
  | { kind: "timeline-guide"; guideId: string }
  | { kind: "timeline-shot"; id?: string; tag: string; scroll?: boolean }
  | { kind: "source-control"; mediaId: string; channel: H3GuideChannel; control: "toggle" | "edit" }
  | { kind: "preserve-editor-focus"; guideId?: string }

export interface H3GuideDropSource {
  id: string
  item: MediaItem
}

export interface H3PromptShotBridge {
  change?(identity: string, frameIndex: number): void
  select?(identity: string): void
  remove?(identity: string): void
  apply?(): void
  cancel?(): void
}

export interface H3TimelineHost {
  getState(): LoaderState
  dispatch(action: LoaderAction): boolean
  setStatus(message: string): void
  requestRender(force?: boolean, focus?: H3TimelineFocus): void
  publishView(): void
  selectMedia(id: string | undefined): void
  resolveGuideDrop(
    channel: H3GuideChannel,
    dataTransfer: DataTransfer | null,
  ): H3GuideDropSource | undefined
}

interface H3EditorState {
  mediaId: string | undefined
  channel: H3GuideChannel
  timeline: H3TimelineState
  initialTimeline: H3TimelineState
  ownedGuideIds: Set<string>
  originalGuideFrames: Map<string, number>
  draftError?: string
  selectedGuideId?: string
  removedGuideIds: Set<string>
  allowTimelineOnly?: boolean
  timelineEdit?: boolean
  requireGuide?: boolean
  returnFocus?: {
    mediaId?: string
    channel?: H3GuideChannel
    guideId?: string
    control?: "toggle" | "edit"
  }
}

export interface H3TimelineSessionOptions {
  host: H3TimelineHost
}

export class H3TimelineSession {
  #host: H3TimelineHost
  #collapsed = true
  #editor: H3EditorState | undefined
  #shots: readonly Pick<PromptShot, "id" | "tag" | "frameIndex">[] = []
  #shotBridge: H3PromptShotBridge = {}
  #shotDirty = false
  #selectedShot: string | undefined
  #selectedRole: "start" | "end" | undefined
  #sessionId = 0
  #destroyed = false

  constructor(options: H3TimelineSessionOptions) {
    this.#host = options.host
  }

  setPromptShots(
    shots: readonly (Pick<PromptShot, "tag" | "frameIndex"> & { id?: string })[],
    bridge: H3PromptShotBridge = {},
    dirty = false,
  ): void {
    if (this.#destroyed) return
    this.#shots = shots.map((shot) => ({
      id: shot.id ?? shot.tag,
      tag: shot.tag,
      frameIndex: shot.frameIndex,
    }))
    this.#shotBridge = bridge
    this.#shotDirty = dirty
    if (this.#selectedShot && !this.#shots.some((shot) => shot.id === this.#selectedShot))
      this.#selectedShot = undefined
  }

  get view(): H3WorkspaceView {
    const editor = this.#editor
    const state = this.#host.getState()
    const timeline = editor ? this.#editorTimeline(editor) : cloneH3Timeline(state.h3Timeline)
    const selectedGuide = editor?.selectedGuideId
      ? timeline.guides.find((guide) => guide.id === editor.selectedGuideId)
      : undefined
    const parentId = (id: string): string => (id.endsWith(":audio") ? id.slice(0, -6) : id)
    const recovery = Boolean(
      editor &&
      !editor.mediaId &&
      !editor.timelineEdit &&
      selectedGuide &&
      ((!selectedGuide.visualId && !selectedGuide.audioId) ||
        (selectedGuide.visualId !== null &&
          selectedGuide.visualId !== undefined &&
          !state.items[parentId(selectedGuide.visualId)]) ||
        (selectedGuide.audioId !== null &&
          selectedGuide.audioId !== undefined &&
          !state.items[parentId(selectedGuide.audioId)])),
    )
    const selection: H3Selection = this.#selectedRole
      ? { kind: this.#selectedRole }
      : this.#selectedShot
        ? (() => {
            const shot = this.#shots.find((candidate) => candidate.id === this.#selectedShot)
            return shot ? { kind: "shot" as const, id: shot.id, tag: shot.tag } : undefined
          })()
        : editor?.selectedGuideId
          ? { kind: "guide", guideId: editor.selectedGuideId, channel: editor.channel }
          : editor?.mediaId
            ? { kind: "source", mediaId: editor.mediaId, channel: editor.channel }
            : undefined
    const issue = editor ? this.#draftIssue(editor) : undefined
    const guideDirty = this.isDirty
    const editorView: H3EditorView | undefined = editor
      ? {
          mediaId: editor.mediaId,
          channel: editor.channel,
          selectedGuideId: editor.selectedGuideId,
          timelineEdit: Boolean(editor.timelineEdit),
          recovery,
          ownedGuideIds: [...editor.ownedGuideIds],
        }
      : undefined
    return {
      collapsed: this.#collapsed,
      selection,
      editScope: editor ? (editor.mediaId ? "source" : "guide") : this.#shotDirty ? "shot" : "none",
      sessionId: this.#sessionId,
      dirty: guideDirty || this.#shotDirty,
      canApply: editor ? guideDirty && !issue : this.#shotDirty,
      shotDirty: this.#shotDirty,
      shotCanApply: this.#shotDirty,
      issue,
      draftError: editor?.draftError,
      timeline,
      editor: editorView,
      shots: this.#shots,
    }
  }

  get isDirty(): boolean {
    const editor = this.#editor
    return Boolean(
      editor && JSON.stringify(editor.timeline) !== JSON.stringify(editor.initialTimeline),
    )
  }

  get hasEditor(): boolean {
    return this.#editor !== undefined
  }

  get promptShotDirty(): boolean {
    return this.#shotDirty
  }

  collapse(): void {
    if (this.#destroyed) return
    this.#collapsed = !this.#collapsed
    this.#host.requestRender(true)
  }

  toggle(): void {
    if (this.#destroyed) return
    if (this.isDirty) {
      this.#host.setStatus("Apply or cancel Guide changes before changing Timeline Guides.")
      this.#host.requestRender(true)
      return
    }
    if (this.#shotDirty) {
      this.#host.setStatus("Apply or cancel Shot changes before changing Timeline Guides.")
      this.#host.requestRender(true)
      return
    }
    const state = this.#host.getState()
    this.#host.dispatch({ type: "toggle-h3-timeline", enabled: !state.h3Timeline.enabled })
  }

  canDrop(channel: H3GuideChannel, dataTransfer: DataTransfer | null): boolean {
    return (
      !this.#destroyed &&
      !this.#shotDirty &&
      Boolean(this.#host.resolveGuideDrop(channel, dataTransfer))
    )
  }

  dropGuide(channel: H3GuideChannel, frameIndex: number, dataTransfer: DataTransfer | null): void {
    if (this.#destroyed || this.#shotDirty) return
    const source = this.#host.resolveGuideDrop(channel, dataTransfer)
    if (!source || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    const editor = this.#ensureTimelineEditor()
    if (!editor) return
    if (editor.timeline.guides.length >= 32) {
      this.#host.setStatus("Timeline supports at most 32 specific frame guides.")
      this.#host.requestRender(true)
      return
    }
    const id = this.#newGuideId()
    const guide =
      channel === "visual"
        ? { id, frameIndex, visualId: source.id, audioId: null }
        : { id, frameIndex, visualId: null, audioId: source.id }
    const candidate = { ...editor.timeline, guides: [...editor.timeline.guides, guide] }
    const issue = validateH3Timeline(this.#host.getState(), candidate, { allowIncomplete: true })[0]
    if (issue) {
      this.#host.setStatus(issue)
      this.#host.requestRender(true)
      return
    }
    editor.timeline = candidate
    editor.ownedGuideIds.add(id)
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    this.#host.setStatus(
      `${this.#itemFilename(source.item)} added as a ${channel === "visual" ? "visual" : "audio"} Guide at ${frameIndex}f. Apply to save.`,
    )
    this.#host.requestRender(true)
  }

  movePlacement(id: string, frameIndex: number): void {
    if (this.#destroyed || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    let editor = this.#editor
    if (!editor?.ownedGuideIds.has(id)) {
      if (editor) {
        const guide = editor.timeline.guides.find((candidate) => candidate.id === id)
        if (!guide) return
        editor.ownedGuideIds.add(id)
        if (!editor.originalGuideFrames.has(id))
          editor.originalGuideFrames.set(id, guide.frameIndex)
      } else {
        const timeline = cloneH3Timeline(this.#host.getState().h3Timeline)
        if (!timeline.guides.some((guide) => guide.id === id)) return
        editor = {
          mediaId: undefined,
          channel: "visual",
          timeline,
          initialTimeline: cloneH3Timeline(timeline),
          ownedGuideIds: new Set(timeline.guides.map((guide) => guide.id)),
          originalGuideFrames: new Map(
            timeline.guides.map((guide) => [guide.id, guide.frameIndex]),
          ),
          removedGuideIds: new Set(),
          allowTimelineOnly: true,
          timelineEdit: true,
          returnFocus: { guideId: id },
        }
        this.#editor = editor
        this.#sessionId += 1
      }
    }
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === id ? { ...guide, frameIndex } : guide,
      ),
    }
    // A timeline move carries both channels. Later card edits may detach from this new frame.
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    editor.draftError = undefined
    this.#host.requestRender(true, { kind: "timeline-guide", guideId: id })
  }

  removePlacement(id: string): void {
    if (this.#destroyed) return
    if (this.#shotDirty) {
      this.#host.setStatus("Apply or cancel Shot changes before editing a Guide.")
      this.#host.requestRender(true)
      return
    }
    const editor = this.#editor
    const state = this.#host.getState()
    if (
      !state.h3Timeline.guides.some((guide) => guide.id === id) &&
      !editor?.timeline.guides.some((guide) => guide.id === id)
    )
      return
    const timelineEditor = this.#ensureTimelineEditor()
    if (!timelineEditor) return
    timelineEditor.timeline = {
      ...timelineEditor.timeline,
      guides: timelineEditor.timeline.guides.filter((guide) => guide.id !== id),
    }
    timelineEditor.removedGuideIds.add(id)
    if (timelineEditor.selectedGuideId === id) timelineEditor.selectedGuideId = undefined
    this.#host.setStatus("Guide removed from the Timeline draft. Apply to save.")
    this.#host.requestRender(true)
  }

  selectPlacement(
    placement: H3TimelinePlacement,
    channel: H3GuideChannel,
    focusGuide = true,
  ): boolean {
    const sessionBefore = this.#sessionId
    if (placement.kind === "start" || placement.kind === "end") {
      if (placement.visualId) {
        this.#openForMedia(
          placement.visualId,
          "visual",
          undefined,
          "edit",
          false,
          focusGuide,
          true,
          placement.kind,
          false,
        )
        return this.#sessionId !== sessionBefore
      }
      if (this.#editor) {
        this.#editor = undefined
        this.#sessionId += 1
      }
      this.#selectedShot = undefined
      this.#selectedRole = placement.kind
      this.#host.selectMedia(undefined)
      this.#host.requestRender(true)
      return this.#sessionId !== sessionBefore
    }
    this.#selectedShot = undefined
    this.#selectedRole = undefined
    if (placement.kind === "guide" && placement.guideId) {
      const id = channel === "visual" ? placement.visualId : placement.audioId
      if (id)
        this.#openForMedia(
          id,
          channel,
          placement.guideId,
          "edit",
          false,
          focusGuide,
          true,
          undefined,
          false,
        )
      else {
        this.#openForGuide(placement.guideId, focusGuide)
        this.#host.selectMedia(undefined)
      }
      return this.#sessionId !== sessionBefore
    }
    const id = channel === "visual" ? placement.visualId : placement.audioId
    if (id)
      this.#openForMedia(
        id,
        channel,
        placement.guideId,
        "edit",
        false,
        false,
        true,
        undefined,
        false,
      )
    else if (placement.guideId) {
      this.#openForGuide(placement.guideId, focusGuide)
      this.#host.selectMedia(undefined)
    }
    return this.#sessionId !== sessionBefore
  }

  selectShot(identity: string, scroll = false): boolean {
    const shot = this.#shots.find(
      (candidate) => candidate.id === identity || candidate.tag === identity,
    )
    if (!shot) return false
    const sessionBefore = this.#sessionId
    const editor = this.#editor
    if (editor && this.isDirty) {
      editor.mediaId = undefined
      editor.selectedGuideId = undefined
      editor.allowTimelineOnly = true
      editor.timelineEdit = true
      editor.ownedGuideIds = new Set(editor.timeline.guides.map((guide) => guide.id))
      this.#sessionId += 1
    } else if (editor) {
      this.#editor = undefined
      this.#sessionId += 1
    }
    this.#selectedShot = shot.id
    this.#selectedRole = undefined
    this.#host.selectMedia(undefined)
    this.#shotBridge.select?.(shot.id)
    this.#host.requestRender(true, {
      kind: "timeline-shot",
      id: shot.id,
      tag: shot.tag,
      ...(scroll ? { scroll: true } : {}),
    })
    return this.#sessionId !== sessionBefore
  }

  changeShot(identity: string, frameIndex: number): void {
    if (!this.#destroyed) this.#shotBridge.change?.(identity, frameIndex)
  }

  removeShot(identity: string): void {
    if (!this.#destroyed) this.#shotBridge.remove?.(identity)
  }

  editGuidesForShot(identity: string): void {
    if (this.#destroyed) return
    if (this.#shotDirty) {
      this.#host.setStatus("Apply or cancel Shot changes before editing a Guide.")
      this.#host.requestRender(true)
      return
    }
    const shot = this.#shots.find(
      (candidate) => candidate.id === identity || candidate.tag === identity,
    )
    if (!shot) return
    const guide = this.#host
      .getState()
      .h3Timeline.guides.find((candidate) => candidate.frameIndex === shot.frameIndex)
    if (guide) {
      const channel: H3GuideChannel = guide.visualId !== null ? "visual" : "audio"
      const mediaId = channel === "visual" ? guide.visualId : guide.audioId
      if (mediaId) this.#openForMedia(mediaId, channel, guide.id)
      else this.#openForGuide(guide.id)
      return
    }
    this.#collapsed = false
    this.selectShot(shot.id, true)
  }

  openForMedia(mediaId: string, channel: H3GuideChannel, guideId?: string): void {
    this.#openForMedia(mediaId, channel, guideId)
  }

  toggleGuide(id: string, channel: H3GuideChannel): void {
    if (this.#destroyed) return
    if (this.#shotDirty) {
      this.#host.setStatus("Apply or cancel Shot changes before changing Guide usage.")
      this.#host.requestRender(true)
      return
    }
    if (this.isDirty) {
      this.#host.setStatus("Apply or cancel Guide changes before changing Guide usage.")
      this.#host.requestRender(true)
      return
    }
    const item = this.#host.getState().items[id]
    if (!item || !canUseAsH3Guide(item, channel)) return
    const mediaId = timelineMediaId(item, channel)
    if (!this.#canSwitchEditor(mediaId, channel)) return
    const state = this.#host.getState()
    const configured = mediaHasGuide(state.h3Timeline, mediaId, channel)
    if (!configured) {
      this.#openForMedia(mediaId, channel, undefined, "toggle", true)
      return
    }
    const active = mediaGuideEnabled(state.h3Timeline, mediaId, channel)
    const timeline = setMediaGuideEnabled(
      cloneH3Timeline(state.h3Timeline),
      mediaId,
      channel,
      !active,
    )
    this.#host.setStatus(
      `${this.#itemFilename(item)} Guide usage ${active ? "disabled" : "enabled"}.`,
    )
    this.#host.dispatch({
      type: "apply-h3-media-edit",
      mediaId,
      channel,
      referenceEnabled: referenceEnabled(item, channel),
      timeline,
    })
  }

  inputFrame(guideId: string, value: string): void {
    const editor = this.#editor
    if (!editor) return
    editor.selectedGuideId = guideId
    const frameIndex = value === "" ? Number.NaN : Number(value)
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === guideId ? { ...guide, frameIndex } : guide,
      ),
    }
    this.#publishView()
  }

  commitFrame(guideId: string, value: string): void {
    const editor = this.#editor
    if (!editor) return
    editor.selectedGuideId = guideId
    const rawFrame = value.trim()
    const frameIndex = rawFrame === "" ? Number.NaN : Number(rawFrame)
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      editor.draftError = "Output frame must be a non-negative integer."
      this.#preserveRender()
      return
    }
    const guide = editor.timeline.guides.find((candidate) => candidate.id === guideId)
    if (!guide) return
    if (!editor.mediaId) {
      editor.timeline = {
        ...editor.timeline,
        guides: editor.timeline.guides.map((candidate) =>
          candidate.id === guideId ? { ...candidate, frameIndex } : candidate,
        ),
      }
      editor.draftError = undefined
      this.#preserveRender()
      return
    }
    const pairedId = editor.channel === "visual" ? guide.audioId : guide.visualId
    const originalFrame = editor.originalGuideFrames.get(guideId)
    if (
      pairedId !== null &&
      pairedId !== undefined &&
      originalFrame !== undefined &&
      frameIndex !== originalFrame
    ) {
      if (editor.timeline.guides.length >= 32) {
        editor.timeline = {
          ...editor.timeline,
          guides: editor.timeline.guides.map((candidate) =>
            candidate.id === guideId ? { ...candidate, frameIndex: originalFrame } : candidate,
          ),
        }
        editor.draftError = "Cannot move a paired Guide: the 32-guide limit has been reached."
        this.#preserveRender()
        return
      }
      const newId = this.#newGuideId()
      const detached =
        editor.channel === "visual"
          ? { ...guide, frameIndex: originalFrame, visualId: null }
          : { ...guide, frameIndex: originalFrame, audioId: null }
      const moved =
        editor.channel === "visual"
          ? { id: newId, frameIndex, visualId: editor.mediaId, audioId: null }
          : { id: newId, frameIndex, visualId: null, audioId: editor.mediaId }
      editor.timeline = {
        ...editor.timeline,
        guides: [
          ...editor.timeline.guides.map((candidate) =>
            candidate.id === guideId ? detached : candidate,
          ),
          moved,
        ],
      }
      editor.ownedGuideIds.add(newId)
      editor.originalGuideFrames.set(newId, frameIndex)
      editor.selectedGuideId = newId
      editor.draftError = undefined
      this.#preserveRender(newId)
      return
    }
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((candidate) =>
        candidate.id === guideId ? { ...candidate, frameIndex } : candidate,
      ),
    }
    editor.draftError = undefined
    this.#preserveRender()
  }

  changeGuideSource(id: string, channel: H3GuideChannel, mediaId: string | null): void {
    const editor = this.#editor
    if (!editor) return
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === id
          ? channel === "visual"
            ? { ...guide, visualId: mediaId }
            : { ...guide, audioId: mediaId }
          : guide,
      ),
    }
    const changedGuide = editor.timeline.guides.find((guide) => guide.id === id)
    if (changedGuide && changedGuide.visualId === null && changedGuide.audioId === null)
      editor.removedGuideIds.add(id)
    else editor.removedGuideIds.delete(id)
    editor.draftError = undefined
    this.#preserveRender()
  }

  addPlacement(position: H3GuidePosition, frame: string): void {
    const editor = this.#editor
    if (!editor?.mediaId) return
    editor.draftError = undefined
    if (position === "start" || position === "end") {
      if (editor.channel !== "visual")
        editor.draftError = "Only an Image can be used for Start or End."
      else {
        const role = position === "start" ? "startImageId" : "endImageId"
        const label = position === "start" ? "Start" : "End"
        const current = editor.timeline[role]
        if (current === editor.mediaId) editor.draftError = `${label} is already connected.`
        else if (current !== null)
          editor.draftError = `${label} is already assigned to ${this.#mediaLabel(current, "visual")}.`
        else editor.timeline = { ...editor.timeline, [role]: editor.mediaId }
      }
      this.#host.requestRender(true)
      return
    }
    if (position !== "guide") return
    if (editor.timeline.guides.length >= 32) {
      editor.draftError = "Timeline supports at most 32 specific frame guides."
      this.#host.requestRender(true)
      return
    }
    const rawFrame = frame.trim()
    const frameIndex = rawFrame === "" ? Number.NaN : Number(rawFrame)
    if (rawFrame === "") editor.draftError = "Enter a non-negative integer output frame."
    else if (!Number.isSafeInteger(frameIndex) || frameIndex < 0)
      editor.draftError = "Output frame must be a non-negative integer."
    if (editor.draftError) {
      this.#host.requestRender(true)
      return
    }
    const id = this.#newGuideId()
    const guide =
      editor.channel === "visual"
        ? { id, frameIndex, visualId: editor.mediaId, audioId: null }
        : { id, frameIndex, visualId: null, audioId: editor.mediaId }
    const candidate = { ...editor.timeline, guides: [...editor.timeline.guides, guide] }
    const issue = validateH3Timeline(this.#host.getState(), candidate, { allowIncomplete: true })[0]
    if (issue) {
      editor.draftError = issue
      this.#host.requestRender(true)
      return
    }
    editor.timeline = candidate
    editor.ownedGuideIds.add(id)
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    this.#host.requestRender(true)
  }

  deletePlacement(id: string): void {
    const editor = this.#editor
    if (!editor) return
    if (!editor.mediaId) {
      editor.timeline = {
        ...editor.timeline,
        guides: editor.timeline.guides.filter((guide) => guide.id !== id),
      }
      editor.removedGuideIds.add(id)
      if (editor.selectedGuideId === id) editor.selectedGuideId = undefined
      this.#host.requestRender(true)
      return
    }
    const guide = editor.timeline.guides.find((candidate) => candidate.id === id)
    if (!guide || !guideUsesMedia(guide, editor.mediaId, editor.channel)) return
    const detached =
      editor.channel === "visual" ? { ...guide, visualId: null } : { ...guide, audioId: null }
    editor.timeline = {
      ...editor.timeline,
      guides:
        detached.visualId === null && detached.audioId === null
          ? editor.timeline.guides.filter((candidate) => candidate.id !== id)
          : editor.timeline.guides.map((candidate) => (candidate.id === id ? detached : candidate)),
    }
    if (detached.visualId === null && detached.audioId === null) editor.removedGuideIds.add(id)
    else editor.removedGuideIds.delete(id)
    if (editor.selectedGuideId === id) editor.selectedGuideId = undefined
    this.#host.requestRender(true)
  }

  removeRole(role: "start" | "end"): void {
    if (this.#destroyed) return
    if (this.#shotDirty) {
      this.#host.setStatus("Apply or cancel Shot changes before editing a Guide.")
      this.#host.requestRender(true)
      return
    }
    const key = role === "start" ? "startImageId" : "endImageId"
    const current = this.#editor
      ? this.#editor.timeline[key]
      : this.#host.getState().h3Timeline[key]
    if (current === null) return
    const editor = this.#ensureTimelineEditor()
    if (!editor) return
    editor.timeline = { ...editor.timeline, [key]: null }
    this.#selectedRole = role
    this.#host.setStatus(
      `${role === "start" ? "Start" : "End"} removed from the Timeline draft. Apply to save.`,
    )
    this.#host.requestRender(true)
  }

  apply(): void {
    if (this.#destroyed) return
    if (this.#editor) {
      this.#applyEditor()
      if (this.#editor) return
    }
    if (this.#shotDirty) this.#shotBridge.apply?.()
  }

  cancel(): void {
    if (this.#destroyed) return
    if (this.#editor) this.#closeEditor()
    if (this.#shotDirty) this.#shotBridge.cancel?.()
  }

  reset(): void {
    if (this.#destroyed) return
    this.#editor = undefined
    this.#selectedShot = undefined
    this.#selectedRole = undefined
    this.#sessionId += 1
  }

  clearMediaSelection(): void {
    if (this.#destroyed) return
    this.#selectedShot = undefined
    this.#selectedRole = undefined
    if (this.#editor) this.#editor.selectedGuideId = undefined
  }

  reconcile(): void {
    if (this.#destroyed) return
    const editor = this.#editor
    if (!editor?.mediaId) return
    const itemId = editor.mediaId.endsWith(":audio") ? editor.mediaId.slice(0, -6) : editor.mediaId
    const item = this.#host.getState().items[itemId]
    if (!item || !canUseAsH3Guide(item, editor.channel)) this.reset()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#editor = undefined
    this.#shots = []
    this.#shotBridge = {}
    this.#selectedShot = undefined
    this.#selectedRole = undefined
  }

  #openForMedia(
    mediaId: string,
    channel: H3GuideChannel,
    guideId?: string,
    control: "toggle" | "edit" = "edit",
    requireGuide = false,
    focusGuide = true,
    preserveDraft = false,
    selectedRole?: "start" | "end",
    selectCard = true,
  ): void {
    const state = this.#host.getState()
    const wasCollapsed = this.#collapsed
    this.#selectedShot = undefined
    this.#selectedRole = selectedRole
    if (this.#shotDirty && !preserveDraft) {
      this.#host.setStatus("Apply or cancel Shot changes before editing a Guide.")
      this.#host.requestRender(true)
      return
    }
    const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = state.items[itemId]
    if (!item || !canUseAsH3Guide(item, channel)) {
      this.#host.setStatus("The selected Timeline source is unavailable.")
      this.#host.requestRender(true)
      return
    }
    const editor = this.#editor
    if (editor?.mediaId === mediaId && editor.channel === channel) {
      editor.selectedGuideId = guideId
      if (!selectCard) this.#host.selectMedia(undefined)
      this.#collapsed = false
      this.#host.requestRender(
        true,
        guideId && focusGuide
          ? { kind: "editor-guide", guideId }
          : !guideId && wasCollapsed
            ? { kind: "workspace" }
            : undefined,
      )
      return
    }
    if (preserveDraft && editor && this.isDirty) {
      for (const guide of editor.timeline.guides)
        if (guideUsesMedia(guide, mediaId, channel)) editor.ownedGuideIds.add(guide.id)
      if (guideId) editor.ownedGuideIds.add(guideId)
      editor.mediaId = mediaId
      editor.channel = channel
      editor.timelineEdit = true
      editor.allowTimelineOnly = true
      editor.selectedGuideId = guideId
      editor.returnFocus = { mediaId, channel, control }
      this.#sessionId += 1
      this.#host.selectMedia(selectCard ? item.id : undefined)
      this.#collapsed = false
      this.#host.requestRender(
        true,
        guideId && focusGuide
          ? { kind: "editor-guide", guideId }
          : !guideId && wasCollapsed
            ? { kind: "workspace" }
            : undefined,
      )
      return
    }
    if (!this.#canSwitchEditor(mediaId, channel)) return
    const timeline = cloneH3Timeline(state.h3Timeline)
    const ownedGuideIds = new Set(
      timeline.guides
        .filter((guide) => guideUsesMedia(guide, mediaId, channel))
        .map((guide) => guide.id),
    )
    if (guideId) ownedGuideIds.add(guideId)
    this.#editor = {
      mediaId,
      channel,
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds,
      originalGuideFrames: new Map(timeline.guides.map((guide) => [guide.id, guide.frameIndex])),
      removedGuideIds: new Set(),
      ...(requireGuide ? { requireGuide: true } : {}),
      ...(guideId ? { selectedGuideId: guideId } : {}),
      returnFocus: { mediaId, channel, control },
    }
    this.#sessionId += 1
    this.#host.selectMedia(selectCard ? item.id : undefined)
    this.#collapsed = false
    this.#host.requestRender(
      true,
      guideId && focusGuide
        ? { kind: "editor-guide", guideId }
        : wasCollapsed
          ? { kind: "workspace" }
          : undefined,
    )
  }

  #openForGuide(guideId: string, focusGuide = true): void {
    const state = this.#host.getState()
    this.#selectedShot = undefined
    this.#selectedRole = undefined
    const guide = state.h3Timeline.guides.find((candidate) => candidate.id === guideId)
    if (!guide) return
    const editor = this.#editor
    if (editor && editor.mediaId === undefined && editor.selectedGuideId === guideId) {
      this.#collapsed = false
      this.#host.requestRender(true, focusGuide ? { kind: "editor-guide", guideId } : undefined)
      return
    }
    if (editor && this.isDirty) {
      editor.mediaId = undefined
      editor.channel = guide.visualId !== null ? "visual" : "audio"
      editor.allowTimelineOnly = true
      editor.timelineEdit = true
      editor.ownedGuideIds.add(guideId)
      editor.selectedGuideId = guideId
      editor.returnFocus = { guideId }
      this.#sessionId += 1
      this.#collapsed = false
      this.#host.requestRender(true, focusGuide ? { kind: "editor-guide", guideId } : undefined)
      return
    }
    const timeline = cloneH3Timeline(state.h3Timeline)
    this.#editor = {
      mediaId: undefined,
      channel: guide.visualId !== null ? "visual" : "audio",
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds: new Set([guideId]),
      originalGuideFrames: new Map([[guide.id, guide.frameIndex]]),
      selectedGuideId: guideId,
      removedGuideIds: new Set(),
      allowTimelineOnly: true,
      returnFocus: { guideId },
    }
    this.#sessionId += 1
    this.#collapsed = false
    this.#host.requestRender(true, focusGuide ? { kind: "editor-guide", guideId } : undefined)
  }

  #ensureTimelineEditor(): H3EditorState | undefined {
    if (this.#editor) {
      if (this.#editor.timelineEdit) return this.#editor
      if (this.isDirty) {
        this.#host.setStatus(
          "Apply or cancel the current Guide edit before changing Timeline Guides.",
        )
        this.#host.requestRender(true)
        return undefined
      }
    }
    const timeline = cloneH3Timeline(this.#host.getState().h3Timeline)
    this.#editor = {
      mediaId: undefined,
      channel: "visual",
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds: new Set(timeline.guides.map((guide) => guide.id)),
      originalGuideFrames: new Map(timeline.guides.map((guide) => [guide.id, guide.frameIndex])),
      removedGuideIds: new Set(),
      allowTimelineOnly: true,
      timelineEdit: true,
    }
    this.#sessionId += 1
    this.#collapsed = false
    return this.#editor
  }

  #canSwitchEditor(mediaId: string | undefined, channel: H3GuideChannel): boolean {
    const editor = this.#editor
    if (!editor || (editor.mediaId === mediaId && editor.channel === channel)) return true
    if (!this.isDirty) return true
    this.#host.setStatus("Apply or cancel the current Guide edit before opening another Guide.")
    this.#host.requestRender(true)
    return false
  }

  #draftIssue(editor: H3EditorState): string | undefined {
    if (!editor.mediaId && !editor.allowTimelineOnly)
      return "Choose a Media source before applying."
    if (!editor.mediaId)
      return validateH3Timeline(this.#host.getState(), editor.timeline, {
        allowIncomplete: true,
      })[0]
    const parentId = editor.mediaId.endsWith(":audio")
      ? editor.mediaId.slice(0, -6)
      : editor.mediaId
    const item = this.#host.getState().items[parentId]
    if (!item) return "The selected Media source is no longer available."
    if (!canUseAsH3Guide(item, editor.channel)) return "Video cannot be used as an H3 Guide source."
    const candidate = this.#editorTimeline(editor)
    if (editor.requireGuide && !mediaHasGuide(candidate, editor.mediaId, editor.channel))
      return "Add a frame placement or select Start/End."
    return validateH3Timeline(this.#host.getState(), candidate, { allowIncomplete: true })[0]
  }

  #editorTimeline(editor: H3EditorState): H3TimelineState {
    const current = cloneH3Timeline(this.#host.getState().h3Timeline)
    const draftById = new Map(
      editor.timeline.guides
        .filter((guide) => editor.ownedGuideIds.has(guide.id))
        .map((guide) => [guide.id, { ...guide }]),
    )
    const guides: H3TimelineState["guides"] = []
    for (const guide of current.guides) {
      if (!editor.ownedGuideIds.has(guide.id)) {
        guides.push({ ...guide })
        continue
      }
      const draft = draftById.get(guide.id)
      if (
        draft &&
        (draft.visualId !== null || draft.audioId !== null || !editor.removedGuideIds.has(guide.id))
      )
        guides.push(draft)
    }
    for (const guide of editor.timeline.guides) {
      if (
        editor.ownedGuideIds.has(guide.id) &&
        !current.guides.some((candidate) => candidate.id === guide.id)
      ) {
        if (
          guide.visualId !== null ||
          guide.audioId !== null ||
          !editor.removedGuideIds.has(guide.id)
        )
          guides.push({ ...guide })
      }
    }
    return pruneDisabledGuideMedia({
      ...current,
      startImageId: editor.timeline.startImageId,
      endImageId: editor.timeline.endImageId,
      guides,
    })
  }

  #applyEditor(): void {
    const editor = this.#editor
    if (!editor) return
    const issue = this.#draftIssue(editor)
    if (issue) {
      this.#host.setStatus(issue)
      this.#host.requestRender(
        true,
        editor.selectedGuideId
          ? { kind: "editor-guide", guideId: editor.selectedGuideId }
          : undefined,
      )
      return
    }
    const timeline = this.#editorTimeline(editor)
    const mediaId = editor.mediaId
    if (!mediaId) {
      if (!editor.allowTimelineOnly) return
      this.#editor = undefined
      this.#sessionId += 1
      this.#host.dispatch({ type: "set-h3-timeline", timeline })
      this.#host.setStatus("Timeline Guide settings applied.")
      this.#host.requestRender(true)
      return
    }
    const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.#host.getState().items[itemId]
    if (!item || !canUseAsH3Guide(item, editor.channel)) return
    this.#editor = undefined
    this.#sessionId += 1
    this.#host.dispatch({
      type: "apply-h3-media-edit",
      mediaId,
      channel: editor.channel,
      referenceEnabled: referenceEnabled(item, editor.channel),
      timeline,
    })
    this.#host.setStatus(`${this.#itemFilename(item)} Guide settings applied.`)
    this.#host.requestRender(true)
  }

  #closeEditor(): void {
    const focus = this.#editor?.returnFocus
    this.#editor = undefined
    this.#selectedShot = undefined
    this.#selectedRole = undefined
    this.#sessionId += 1
    const target =
      focus?.mediaId && focus.channel
        ? ({
            kind: "source-control",
            mediaId: focus.mediaId,
            channel: focus.channel,
            control: focus.control ?? "edit",
          } as const)
        : focus?.guideId
          ? ({ kind: "timeline-guide", guideId: focus.guideId } as const)
          : undefined
    this.#host.requestRender(true, target)
  }

  #preserveRender(focusGuideId?: string): void {
    this.#host.requestRender(true, {
      kind: "preserve-editor-focus",
      ...(focusGuideId ? { guideId: focusGuideId } : {}),
    })
  }

  #publishView(): void {
    this.#host.publishView()
  }

  #mediaLabel(mediaId: string, channel: H3GuideChannel): string {
    const parentId =
      channel === "audio" && mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.#host.getState().items[parentId]
    if (!item) return "Media needed"
    return `${channel === "audio" ? "Audio" : item.kind === "video" ? "Video" : "Image"} · ${this.#itemFilename(item)}`
  }

  #itemFilename(item: MediaItem): string {
    return item.sourceFilename || item.source.path.split("/").pop() || item.source.path
  }

  #newGuideId(): string {
    return `guide-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`
  }
}
