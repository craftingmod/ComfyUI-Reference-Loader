import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import {
  projectLoaderChannels,
  type LoaderCardView,
  type LoaderChannelView,
  type LoaderViewChannel,
  type LoaderViewSnapshot,
} from "../view-model.ts"

const DRAG_MIME = "application/x-reference-loader-item"
const MEDIA_EXTENSIONS = {
  image: new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff"]),
  audio: new Set(["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "mka"]),
  video: new Set(["mp4", "mkv", "webm", "mov", "avi"]),
} as const

export interface LoaderReactActions {
  addFiles(files: readonly File[], replaceId?: string): Promise<boolean>
  saveSnapshot(): void
  loadSnapshot(file: File): Promise<void>
  undo(): void
  redo(): void
  clear(): void
  select(id: string): void
  remove(id: string): void
  setCaption(id: string, channel: LoaderViewChannel, caption: string, composing?: boolean): void
  toggleOutput(id: string, channel: LoaderViewChannel): void
  toggleVideoAudio(id: string): void
  previewAudio(id: string): void
  previewVideo(id: string): void
  move(id: string, channel: LoaderViewChannel, delta: -1 | 1): void
  reorder(id: string, channel: LoaderViewChannel, toIndex: number): void
  edit(id: string, channel: LoaderViewChannel): void
  acceptsFileDrop(dataTransfer: DataTransfer | null): boolean
  flushDeferredPreviews(): void
}

export interface LoaderReactMount {
  update(): void
  destroy(): void
}

export interface LoaderReactOptions {
  container: HTMLElement
  surface: HTMLElement
  mode?: "references" | "single-image"
  dragScope: string
  subscribe(listener: () => void): () => void
  getSnapshot(): LoaderViewSnapshot
  actions: LoaderReactActions
  onCommit?(): void
}

interface DragInfo {
  id: string
  channel: LoaderViewChannel
}

interface DragHandlers {
  drag: DragInfo | undefined
  dropTarget: DragInfo | undefined
  onPointerDown(info: DragInfo, event: PointerEvent<HTMLElement>): void
  onDragStart(info: DragInfo, event: DragEvent<HTMLElement>): void
  onDragOver(info: DragInfo, event: DragEvent<HTMLElement>): void
  onDragEnd(event: DragEvent<HTMLElement>): void
  onDrop(info: DragInfo | undefined, event: DragEvent<HTMLElement>): void
  onChannelDragOver(channel: LoaderViewChannel, event: DragEvent<HTMLElement>): void
  onChannelDrop(channel: LoaderChannelView, event: DragEvent<HTMLElement>): void
}

function mediaKind(file: File): LoaderViewChannel | undefined {
  const mimeMatch = /^(image|audio|video)\//.exec(file.type)
  if (mimeMatch) return mimeMatch[1] as LoaderViewChannel
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (!extension) return undefined
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if (extensions.has(extension)) return kind as LoaderViewChannel
  }
  return undefined
}

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  return Boolean(
    dataTransfer && (dataTransfer.files.length > 0 || [...dataTransfer.types].includes("Files")),
  )
}

function transferFiles(dataTransfer: DataTransfer | null): File[] {
  return dataTransfer ? [...dataTransfer.files] : []
}

function mediaDropKinds(dataTransfer: DataTransfer | null): LoaderViewChannel[] {
  if (!dataTransfer) return []
  const kinds = new Set<LoaderViewChannel>()
  for (const file of dataTransfer.files) {
    const kind = mediaKind(file)
    if (kind) kinds.add(kind)
  }
  if (kinds.size === 0) {
    for (const item of dataTransfer.items) {
      const match = /^(image|audio|video)\//.exec(item.type)
      if (match) kinds.add(match[1] as LoaderViewChannel)
    }
  }
  return [...kinds]
}

function setFileDropFeedback(
  surface: HTMLElement,
  target: HTMLElement | undefined,
  kinds: readonly LoaderViewChannel[],
): void {
  surface.classList.remove("is-file-dragging")
  for (const element of surface.querySelectorAll<HTMLElement>(".is-file-drop-target"))
    element.classList.remove("is-file-drop-target")
  delete surface.dataset.fileDropKinds
  delete surface.dataset.fileDropTarget
  if (kinds.length === 0) return
  surface.classList.add("is-file-dragging")
  surface.dataset.fileDropKinds = kinds.join(" ")
  if (!target) return
  target.classList.add("is-file-drop-target")
  surface.dataset.fileDropTarget = target.classList.contains("rl-card") ? "replace" : "add"
}

function clearFileDropFeedback(surface: HTMLElement): void {
  setFileDropFeedback(surface, undefined, [])
}

function stop(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

function dragBelongsToScope(dataTransfer: DataTransfer | null, scope: string): boolean {
  let raw: string | undefined
  try {
    raw = dataTransfer?.getData(DRAG_MIME) || undefined
  } catch {
    return false
  }
  if (!raw) return true
  try {
    const payload = JSON.parse(raw) as { scope?: unknown }
    return payload.scope === scope
  } catch {
    return false
  }
}

function fileInputHandler(
  actions: LoaderReactActions,
  expectedKind?: LoaderViewChannel,
): (event: ChangeEvent<HTMLInputElement>) => void {
  return (event) => {
    stop(event)
    const input = event.currentTarget
    const files = [...(input.files ?? [])].filter((file) => {
      const kind = mediaKind(file)
      return expectedKind === undefined || kind === expectedKind || kind === undefined
    })
    input.value = ""
    if (files.length > 0) void actions.addFiles(files)
  }
}

function SnapshotMenu({ actions }: { actions: LoaderReactActions }): ReactNode {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLSpanElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target))
        flushSync(() => setOpen(false))
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open])

  const focusFirst = (): void => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    stop(event)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      flushSync(() => setOpen(true))
      focusFirst()
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      flushSync(() => setOpen(false))
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    stop(event)
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    const index = items.indexOf(event.target as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      flushSync(() => setOpen(false))
      const focusTarget =
        trigger.current ??
        wrapper.current?.querySelector<HTMLButtonElement>(".rl-snapshot__trigger")
      focusTarget?.focus()
      return
    }
    if (index >= 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      items[(index + delta + items.length) % items.length]?.focus()
    }
  }

  const save = (): void => {
    flushSync(() => setOpen(false))
    actions.saveSnapshot()
  }

  const load = (): void => {
    flushSync(() => setOpen(false))
    input.current?.click()
  }

  return (
    <span className="rl-snapshot" ref={wrapper}>
      <button
        type="button"
        className="rl-snapshot__trigger"
        data-action="snapshot-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          stop(event)
          const next = !open
          flushSync(() => setOpen(next))
          if (next) focusFirst()
        }}
        onKeyDown={onTriggerKeyDown}
      >
        Snapshot <span aria-hidden="true">▾</span>
      </button>
      <span
        className="rl-snapshot__menu"
        ref={menu}
        role="menu"
        hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        <button
          type="button"
          role="menuitem"
          data-action="snapshot-save"
          title="Save Loader and Prompt settings to JSON"
          onClick={(event) => {
            stop(event)
            save()
          }}
        >
          Save
        </button>
        <button
          type="button"
          role="menuitem"
          data-action="snapshot-load"
          title="Load Loader and Prompt settings from JSON"
          onClick={(event) => {
            stop(event)
            load()
          }}
        >
          Load
        </button>
      </span>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        data-snapshot-input=""
        aria-label="Load snapshot"
        hidden
        onChange={(event) => {
          stop(event)
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file) void actions.loadSnapshot(file)
        }}
      />
    </span>
  )
}

function LoaderToolbar({
  snapshot,
  actions,
}: {
  snapshot: LoaderViewSnapshot
  actions: LoaderReactActions
}): ReactNode {
  const hasClearableState =
    Object.keys(snapshot.state.items).length > 0 || snapshot.pending.length > 0
  const count = Object.keys(snapshot.state.items).length
  return (
    <div className="rl-media-topbar">
      <header className="rl-media-header">
        <div>
          <strong data-media-title>Media</strong>
          <small>Add, edit, and order image, video, and audio references.</small>
        </div>
        <span className="rl-toolbar__count">
          {count} reference{count === 1 ? "" : "s"}
        </span>
      </header>
      <section className="rl-toolbar" aria-label="Reference Loader toolbar">
        <label className="rl-primary rl-file-button" aria-label="Add media" title="Add media">
          Add
          <input
            type="file"
            accept="image/*,audio/*,video/*"
            multiple
            onChange={fileInputHandler(actions)}
          />
        </label>
        <button
          type="button"
          data-action="undo"
          disabled={!snapshot.canUndo}
          title="Undo (Ctrl+Z)"
          onClick={(event) => {
            stop(event)
            actions.undo()
          }}
        >
          ↶ Undo
        </button>
        <button
          type="button"
          data-action="redo"
          disabled={!snapshot.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          onClick={(event) => {
            stop(event)
            actions.redo()
          }}
        >
          ↷ Redo
        </button>
        <button
          type="button"
          className="rl-clear"
          data-action="clear"
          disabled={!hasClearableState}
          title="Clear all references and Timeline Guides (Undo available)"
          onClick={(event) => {
            stop(event)
            actions.clear()
          }}
        >
          Clear
        </button>
        <SnapshotMenu actions={actions} />
      </section>
    </div>
  )
}

function CardMedia({
  card,
  deferPreview,
}: {
  card: LoaderCardView
  deferPreview: boolean
}): ReactNode {
  if ((card.channel === "image" || card.channel === "video") && card.previewUrl && !deferPreview) {
    return <img src={card.previewUrl} alt="" draggable={false} />
  }
  if (card.channel === "audio") {
    return (
      <>
        <canvas
          data-waveform-id={card.id}
          aria-label={card.waveformStatus ? `${card.waveformStatus} waveform` : "Waveform"}
        />
        {card.waveformStatus ? (
          <span className="rl-waveform-status" aria-hidden="true">
            {card.waveformStatus}
          </span>
        ) : null}
      </>
    )
  }
  return (
    <div className="rl-placeholder" aria-hidden="true">
      ▧
    </div>
  )
}

function LoadingState({ card }: { card: LoaderCardView }): ReactNode {
  if (card.applyingEdit)
    return (
      <span className="rl-card__loading-overlay" role="status" aria-label="Applying image edit">
        <span className="rl-spinner" aria-hidden="true" />
      </span>
    )
  if (card.loading) return <span className="rl-spinner" title="Loading" />
  return null
}

function MediaCard({
  card,
  showCaptions,
  deferPreview,
  actions,
  dragHandlers,
}: {
  card: LoaderCardView
  showCaptions: boolean
  deferPreview: boolean
  actions: LoaderReactActions
  dragHandlers: DragHandlers
}): ReactNode {
  const mediaClass = `rl-card__media${card.channel === "image" && card.kind === "image" ? " is-transparent-preview" : ""}`
  const audioPlaybackDisabled =
    card.silentVideo || card.loading || card.playbackDuration === undefined
  const videoPlaybackDisabled = card.loading || card.playbackDuration === undefined
  const cardClass = [
    "rl-card",
    showCaptions ? "rl-card--has-caption" : "",
    card.selected ? "is-selected" : "",
    dragHandlers.dropTarget?.id === card.id && dragHandlers.dropTarget.channel === card.channel
      ? "is-drop-target"
      : "",
    card.error ? "has-error" : "",
    card.outputEnabled ? "" : "is-output-disabled",
  ]
    .filter(Boolean)
    .join(" ")
  const cardClick = (event: MouseEvent<HTMLElement>): void => {
    stop(event)
    const target = event.target
    if (target instanceof Element && target.closest("button, textarea, input, select, a")) return
    actions.select(card.id)
  }
  const cardPointerDown = (event: PointerEvent<HTMLElement>): void => {
    dragHandlers.onPointerDown({ id: card.id, channel: card.channel }, event)
  }
  const cardKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    stop(event)
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      return
    if (
      event.target instanceof Element &&
      event.target.closest("button, textarea, input, select, a")
    )
      return
    event.preventDefault()
    actions.move(
      card.id,
      card.channel,
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1,
    )
  }
  const remove = (event: MouseEvent<HTMLButtonElement>): void => {
    stop(event)
    actions.remove(card.id)
  }
  const captionInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    stop(event)
    actions.setCaption(
      card.id,
      card.channel,
      event.currentTarget.value,
      (event.nativeEvent as InputEvent).isComposing === true,
    )
  }
  const edit = (event: MouseEvent<HTMLButtonElement>): void => {
    stop(event)
    actions.edit(card.id, card.channel)
  }
  const doubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    stop(event)
    if (
      event.target instanceof Element &&
      event.target.closest("button, textarea, input, select, a")
    )
      return
    actions.edit(card.id, card.channel)
  }
  const toggle =
    (channel: LoaderViewChannel) =>
    (event: MouseEvent<HTMLButtonElement>): void => {
      stop(event)
      actions.toggleOutput(card.id, channel)
    }
  const preview =
    (kind: "audio" | "video") =>
    (event: MouseEvent<HTMLButtonElement>): void => {
      stop(event)
      if (kind === "audio") actions.previewAudio(card.id)
      else actions.previewVideo(card.id)
    }

  return (
    <article
      className={cardClass}
      data-id={card.id}
      data-channel={card.channel}
      data-media-kind={card.kind}
      data-replace-index={card.replaceIndex}
      data-output-enabled={String(card.outputEnabled)}
      data-guide-enabled="false"
      tabIndex={0}
      draggable
      aria-selected={card.selected}
      onPointerDown={cardPointerDown}
      onClick={cardClick}
      onKeyDown={cardKeyDown}
      onDragStart={(event) =>
        dragHandlers.onDragStart({ id: card.id, channel: card.channel }, event)
      }
      onDragOver={(event) => dragHandlers.onDragOver({ id: card.id, channel: card.channel }, event)}
      onDragEnd={dragHandlers.onDragEnd}
      onDrop={(event) => dragHandlers.onDrop({ id: card.id, channel: card.channel }, event)}
    >
      <div className={mediaClass} title="Double-click to edit" onDoubleClick={doubleClick}>
        {card.channel === "video" && card.kind === "video" ? (
          <span data-video-preview-host="" aria-hidden="true" />
        ) : null}
        <CardMedia card={card} deferPreview={deferPreview} />
        <div className="rl-media-badges">
          <span className={`rl-kind rl-kind--${card.kind}`}>{card.kind}</span>
          {card.outputIndex === undefined ? null : (
            <span className="rl-output-index" title={`${card.channel} output #${card.outputIndex}`}>
              #{card.outputIndex}
            </span>
          )}
          {card.megapixelLabel ? (
            <span
              className="rl-megapixels"
              title={`Current source resolution: ${card.megapixelLabel}`}
            >
              {card.megapixelLabel}
            </span>
          ) : null}
          {card.durationLabel ? <span className="rl-duration">{card.durationLabel}</span> : null}
        </div>
        <span className="rl-media-filename" title={card.filename}>
          {card.filename}
        </span>
        <button
          type="button"
          className="rl-remove"
          data-action="remove"
          aria-label="Remove reference"
          title="Delete reference"
          onClick={remove}
        >
          ×
        </button>
        <LoadingState card={card} />
      </div>
      <div className="rl-card__body">
        {showCaptions ? (
          <textarea
            data-field="caption"
            rows={2}
            maxLength={16_384}
            placeholder="Caption"
            aria-label={`${card.channel === "image" ? "Image" : card.channel === "video" ? "Video" : "Audio"} caption`}
            value={card.caption}
            onInput={captionInput}
          />
        ) : null}
        <div className="rl-card__actions">
          {card.channel === "image" && card.kind === "image" ? (
            <button
              type="button"
              data-action="toggle-image"
              className={`rl-output-button${card.imageEnabled ? " is-on" : ""}`}
              aria-label="Toggle image output"
              aria-pressed={card.imageEnabled}
              onClick={toggle("image")}
            >
              I
            </button>
          ) : null}
          {card.channel === "video" && card.kind === "video" ? (
            <>
              <button
                type="button"
                data-action="toggle-video"
                className={`rl-output-button${card.videoEnabled ? " is-on" : ""}`}
                aria-label="Toggle video output"
                aria-pressed={card.videoEnabled}
                onClick={toggle("video")}
              >
                V
              </button>
              <button
                type="button"
                data-action="toggle-video-audio"
                className={`rl-output-button${card.videoAudioEnabled ? " is-on" : ""}`}
                aria-label="Include embedded audio in video output"
                aria-pressed={card.videoAudioEnabled}
                title={
                  card.silentVideo
                    ? "No embedded audio track"
                    : card.videoAudioEnabled
                      ? "VIDEO output includes embedded audio"
                      : "VIDEO output is muted"
                }
                disabled={card.silentVideo}
                onClick={(event) => {
                  stop(event)
                  actions.toggleVideoAudio(card.id)
                }}
              >
                VA
              </button>
            </>
          ) : null}
          {card.channel === "audio" && (card.kind === "audio" || card.kind === "video") ? (
            <button
              type="button"
              data-action="toggle-audio"
              className={`rl-output-button${card.audioEnabled ? " is-on" : ""}`}
              aria-label="Toggle audio output"
              aria-pressed={card.audioEnabled}
              disabled={card.silentVideo}
              title={card.silentVideo ? "No embedded audio track" : undefined}
              onClick={toggle("audio")}
            >
              A
            </button>
          ) : null}
          {card.channel === "video" && card.kind === "video" ? (
            <button
              type="button"
              data-action="preview-video"
              data-playback-owner={`grid:${card.id}`}
              className="rl-preview-media"
              aria-label={`Play video preview ${card.videoAudioEnabled ? "with audio" : "muted"}`}
              title={
                card.loading || card.playbackDuration === undefined
                  ? "Loading video preview"
                  : card.videoAudioEnabled
                    ? "Play trimmed video preview with audio"
                    : "Play trimmed muted video preview"
              }
              disabled={videoPlaybackDisabled}
              onClick={preview("video")}
            >
              ▶
            </button>
          ) : null}
          {card.channel === "audio" && (card.kind === "audio" || card.kind === "video") ? (
            <button
              type="button"
              data-action="preview-audio"
              data-playback-owner={`grid:${card.id}`}
              className="rl-preview-media"
              aria-label="Play audio preview"
              title={
                card.silentVideo || card.loading || card.playbackDuration === undefined
                  ? card.silentVideo
                    ? "No embedded audio track"
                    : "Loading audio preview"
                  : "Play trimmed audio preview"
              }
              disabled={audioPlaybackDisabled}
              onClick={preview("audio")}
            >
              ▶
            </button>
          ) : null}
          <button
            type="button"
            data-action="move-back"
            aria-label="Move earlier"
            title="Move earlier (Alt+ArrowLeft)"
            onClick={(event) => {
              stop(event)
              actions.move(card.id, card.channel, -1)
            }}
          >
            ←
          </button>
          <button
            type="button"
            data-action="move-forward"
            aria-label="Move later"
            title="Move later (Alt+ArrowRight)"
            onClick={(event) => {
              stop(event)
              actions.move(card.id, card.channel, 1)
            }}
          >
            →
          </button>
          <span className="rl-edit-actions">
            <button
              type="button"
              className="rl-edit-button"
              data-action="edit"
              aria-label="Edit reference"
              title="Edit reference"
              disabled={card.applyingEdit}
              onClick={edit}
            >
              <span aria-hidden="true">R</span>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                <path d="m13.5 6.5 4 4" />
              </svg>
            </button>
          </span>
        </div>
        {card.error ? (
          <p className="rl-card__error" role="alert">
            {card.error}
          </p>
        ) : null}
      </div>
    </article>
  )
}

function MediaChannel({
  channel,
  actions,
  dragHandlers,
  showCaptions,
  deferPreview,
}: {
  channel: LoaderChannelView
  actions: LoaderReactActions
  dragHandlers: DragHandlers
  showCaptions: boolean
  deferPreview: boolean
}): ReactNode {
  const accepts = `${channel.channel}/*`
  return (
    <section
      className="rl-channel"
      data-channel={channel.channel}
      aria-label={`${channel.label} references`}
    >
      <header>
        <div>
          <strong>{channel.label}</strong>
          <span>{channel.count}</span>
        </div>
        <small>{channel.description}</small>
      </header>
      <div
        className={`rl-card-grid${channel.cards.length === 0 ? " is-empty" : ""}`}
        data-drop-zone={channel.channel}
        onDragOver={(event) => dragHandlers.onChannelDragOver(channel.channel, event)}
        onDrop={(event) => dragHandlers.onChannelDrop(channel, event)}
      >
        {channel.cards.map((card) => (
          <MediaCard
            key={`${card.channel}:${card.id}:${card.sourceRevision ?? "original"}`}
            card={card}
            showCaptions={showCaptions}
            deferPreview={deferPreview}
            actions={actions}
            dragHandlers={dragHandlers}
          />
        ))}
        <label
          className={`rl-grid-add${channel.hasOpenCell ? " is-tile" : " is-wide"}`}
          data-media-kind={channel.channel}
          title={`Add ${channel.label.toLowerCase()}`}
        >
          <span className="rl-grid-add__icon" aria-hidden="true">
            +
          </span>
          {channel.hasOpenCell ? null : <span>Add {channel.label.toLowerCase()}</span>}
          <input
            type="file"
            accept={accepts}
            multiple
            data-upload-kind={channel.channel}
            aria-label={`Add ${channel.label.toLowerCase()}`}
            onChange={fileInputHandler(actions, channel.channel)}
          />
        </label>
      </div>
    </section>
  )
}

function PendingUploads({ snapshot }: { snapshot: LoaderViewSnapshot }): ReactNode {
  if (snapshot.pending.length === 0) return null
  return (
    <div className="rl-pending" aria-label="Pending uploads">
      {snapshot.pending.map((pending) => (
        <div key={pending.id}>
          <span className="rl-spinner" aria-hidden="true" />
          <span>{pending.filename}</span>
          <small>Uploading…</small>
        </div>
      ))}
    </div>
  )
}

function SingleImagePanel({
  snapshot,
  actions,
  surface,
}: {
  snapshot: LoaderViewSnapshot
  actions: LoaderReactActions
  surface: HTMLElement
}): ReactNode {
  const imageChannel = projectLoaderChannels(snapshot).find(
    (channel) => channel.channel === "image",
  )
  const card = imageChannel?.cards[0]
  const pending = snapshot.pending[0]
  const filename = card?.filename ?? pending?.filename
  const previewUrl = card?.previewUrl && !snapshot.deferPreviews ? card.previewUrl : undefined
  const loading = Boolean(pending || card?.loading || card?.applyingEdit)
  const hasImage = card !== undefined
  const error = card?.error
  const chooseFile = (event: ChangeEvent<HTMLInputElement>): void => {
    stop(event)
    const input = event.currentTarget
    const files = [...(input.files ?? [])]
    input.value = ""
    if (files.length > 0) void actions.addFiles(files, card?.id)
  }
  const dropFiles = (event: DragEvent<HTMLElement>): void => {
    if (!hasFilePayload(event.dataTransfer)) return
    if (!actions.acceptsFileDrop(event.dataTransfer)) return
    event.preventDefault()
    stop(event)
    clearFileDropFeedback(surface)
    const files = transferFiles(event.dataTransfer)
    if (files.length > 0) void actions.addFiles(files, card?.id)
  }
  const preview = (
    <>
      {previewUrl ? (
        <img src={previewUrl} alt="" draggable={false} />
      ) : (
        <span className="rl-single-image-placeholder">
          {loading ? "Uploading…" : "No image selected"}
        </span>
      )}
      {loading ? (
        <span className="rl-card__loading-overlay" role="status" aria-label="Loading image">
          <span className="rl-spinner" aria-hidden="true" />
        </span>
      ) : null}
    </>
  )
  const edit = (event: MouseEvent<HTMLButtonElement>): void => {
    stop(event)
    if (card) actions.edit(card.id, "image")
  }
  const doubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    stop(event)
    if (
      event.target instanceof Element &&
      event.target.closest("button, textarea, input, select, a")
    )
      return
    if (card) actions.edit(card.id, "image")
    else
      event.currentTarget
        .closest<HTMLElement>(".rl-single-image-panel")
        ?.querySelector<HTMLInputElement>("input[data-upload-kind='image']")
        ?.click()
  }

  return (
    <section
      className="rl-single-image-panel"
      aria-label="Reference image"
      onDragOver={(event) => {
        const kinds = mediaDropKinds(event.dataTransfer)
        if (!hasFilePayload(event.dataTransfer) || !actions.acceptsFileDrop(event.dataTransfer)) {
          clearFileDropFeedback(surface)
          return
        }
        event.preventDefault()
        const candidate =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".rl-card, .rl-single-image-preview.is-empty")
            : undefined
        const target =
          candidate && kinds.length === 1 && kinds[0] === "image" ? candidate : undefined
        setFileDropFeedback(surface, target, kinds)
      }}
      onDrop={dropFiles}
    >
      <div className="rl-single-image-controls">
        <label className="rl-single-image-select" aria-label="Choose image" title="Choose image">
          <span className="rl-single-image-select__value" title={filename ?? "Choose image"}>
            {filename ?? "Choose image"}
          </span>
          <span className="rl-single-image-select__arrow" aria-hidden="true">
            ▾
          </span>
          <input
            type="file"
            data-upload-kind="image"
            aria-label="Choose image"
            onChange={chooseFile}
          />
        </label>
        <button
          type="button"
          className="rl-single-image-edit"
          data-action="edit"
          data-id={card?.id ?? ""}
          data-channel="image"
          disabled={!hasImage || card?.applyingEdit}
          onClick={edit}
        >
          Edit
        </button>
      </div>
      {card ? (
        <article
          className={`rl-card rl-single-image-card${error ? " has-error" : ""}`}
          data-id={card.id}
          data-channel="image"
          data-media-kind="image"
          data-replace-index="1"
          tabIndex={0}
        >
          <div
            className="rl-card__media rl-single-image-preview is-transparent-preview"
            title="Double-click to edit"
            onDoubleClick={doubleClick}
          >
            {preview}
          </div>
          {error ? (
            <p className="rl-card__error" role="alert">
              {error}
            </p>
          ) : null}
        </article>
      ) : (
        <div
          className={`rl-single-image-preview${loading ? " is-loading" : " is-empty"}`}
          data-drop-zone="image"
          title="Double-click to choose an image"
          onDoubleClick={doubleClick}
        >
          {preview}
        </div>
      )}
      {snapshot.status ? (
        <p className="rl-status rl-single-image-status" role="status">
          {snapshot.status}
        </p>
      ) : null}
    </section>
  )
}

function ReferenceLoaderReactRoot({
  surface,
  mode = "references",
  dragScope,
  subscribe,
  getSnapshot,
  actions,
  onCommit,
}: LoaderReactOptions): ReactNode {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [drag, setDrag] = useState<DragInfo>()
  const [dropTarget, setDropTargetState] = useState<DragInfo>()
  const dragRef = useRef<DragInfo | undefined>(undefined)
  const armedDrag = useRef<DragInfo | undefined>(undefined)
  const channels = projectLoaderChannels(snapshot)

  useLayoutEffect(() => onCommit?.(), [onCommit, snapshot])

  const clearDropTarget = (): void => {
    for (const card of surface.querySelectorAll<HTMLElement>(".rl-card.is-drop-target"))
      card.classList.remove("is-drop-target")
    setDropTargetState(undefined)
  }

  const setDropTarget = (next: DragInfo | undefined): void => {
    for (const card of surface.querySelectorAll<HTMLElement>(".rl-card.is-drop-target"))
      card.classList.remove("is-drop-target")
    if (next) {
      const card = [...surface.querySelectorAll<HTMLElement>(".rl-card")].find(
        (candidate) =>
          candidate.dataset.id === next.id && candidate.dataset.channel === next.channel,
      )
      card?.classList.add("is-drop-target")
    }
    setDropTargetState(next)
  }

  const clearFileDrop = (): void => {
    surface.classList.remove("is-file-dragging")
    delete surface.dataset.fileDropKinds
    delete surface.dataset.fileDropTarget
    for (const element of surface.querySelectorAll<HTMLElement>(".is-file-drop-target"))
      element.classList.remove("is-file-drop-target")
  }

  const clearDrag = (): void => {
    surface.classList.remove("is-dragging")
    dragRef.current = undefined
    setDrag(undefined)
    clearDropTarget()
  }

  const onDragStart = (info: DragInfo, event: DragEvent<HTMLElement>): void => {
    if (
      !armedDrag.current ||
      armedDrag.current.id !== info.id ||
      armedDrag.current.channel !== info.channel
    ) {
      event.preventDefault()
      stop(event)
      return
    }
    stop(event)
    try {
      event.dataTransfer?.setData(DRAG_MIME, JSON.stringify({ scope: dragScope, ...info }))
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove"
    } catch {
      // A browser may expose a read-only DataTransfer in synthetic events.
    }
    setDrag(info)
    dragRef.current = info
    surface.classList.add("is-dragging")
  }

  const onDragOver = (info: DragInfo, event: DragEvent<HTMLElement>): void => {
    if (hasFilePayload(event.dataTransfer)) {
      const kinds = mediaDropKinds(event.dataTransfer)
      if (!actions.acceptsFileDrop(event.dataTransfer)) {
        clearFileDrop()
        return
      }
      event.preventDefault()
      stop(event)
      const item = snapshot.state.items[info.id]
      const target =
        kinds.length === 1 && kinds[0] === item?.kind
          ? (event.currentTarget.closest<HTMLElement>(".rl-card") ?? undefined)
          : undefined
      setFileDropFeedback(surface, target, kinds)
      return
    }
    if (!dragBelongsToScope(event.dataTransfer, dragScope)) {
      clearDropTarget()
      return
    }
    const activeDrag = dragRef.current
    if (!activeDrag || activeDrag.channel !== info.channel || activeDrag.id === info.id) {
      clearDropTarget()
      return
    }
    event.preventDefault()
    stop(event)
    setDropTarget(info)
  }

  const onDragEnd = (event: DragEvent<HTMLElement>): void => {
    stop(event)
    armedDrag.current = undefined
    clearDrag()
  }

  const onPointerDown = (info: DragInfo, event: PointerEvent<HTMLElement>): void => {
    const target = event.target
    armedDrag.current =
      target instanceof Element && target.closest("button, textarea, input, select, a")
        ? undefined
        : info
  }

  const onDrop = (info: DragInfo | undefined, event: DragEvent<HTMLElement>): void => {
    const files = transferFiles(event.dataTransfer)
    if (files.length > 0 || hasFilePayload(event.dataTransfer)) {
      event.preventDefault()
      stop(event)
      clearFileDrop()
      clearDrag()
      const replaceId =
        info &&
        files.length === 1 &&
        mediaKind(files[0] as File) === snapshot.state.items[info.id]?.kind
          ? info.id
          : undefined
      if (files.length > 0) void actions.addFiles(files, replaceId)
      return
    }
    if (!dragBelongsToScope(event.dataTransfer, dragScope)) {
      clearDrag()
      return
    }
    const activeDrag = dragRef.current
    if (!info || !activeDrag || info.channel !== activeDrag.channel || info.id === activeDrag.id)
      return
    event.preventDefault()
    stop(event)
    const order = channels.find((candidate) => candidate.channel === info.channel)?.cards ?? []
    actions.reorder(
      activeDrag.id,
      activeDrag.channel,
      order.findIndex((card) => card.id === info.id),
    )
    clearDrag()
  }

  const onChannelDragOver = (channel: LoaderViewChannel, event: DragEvent<HTMLElement>): void => {
    if (hasFilePayload(event.dataTransfer)) {
      const kinds = mediaDropKinds(event.dataTransfer)
      if (!actions.acceptsFileDrop(event.dataTransfer)) {
        clearFileDrop()
        return
      }
      event.preventDefault()
      stop(event)
      const target =
        kinds.length === 1 && kinds[0] === channel
          ? (event.currentTarget.querySelector<HTMLElement>(
              `.rl-grid-add[data-media-kind="${channel}"]`,
            ) ?? undefined)
          : undefined
      setFileDropFeedback(surface, target, kinds)
      return
    }
    if (!dragBelongsToScope(event.dataTransfer, dragScope)) return
    const activeDrag = dragRef.current
    if (!activeDrag || activeDrag.channel !== channel) return
    event.preventDefault()
    stop(event)
    clearDropTarget()
  }

  const onChannelDrop = (channel: LoaderChannelView, event: DragEvent<HTMLElement>): void => {
    const files = transferFiles(event.dataTransfer)
    if (files.length > 0 || hasFilePayload(event.dataTransfer)) {
      event.preventDefault()
      stop(event)
      clearFileDrop()
      clearDrag()
      if (files.length > 0) void actions.addFiles(files)
      return
    }
    if (!dragBelongsToScope(event.dataTransfer, dragScope)) {
      clearDrag()
      return
    }
    const activeDrag = dragRef.current
    if (!activeDrag || activeDrag.channel !== channel.channel) return
    event.preventDefault()
    stop(event)
    actions.reorder(activeDrag.id, activeDrag.channel, channel.cards.length)
    clearDrag()
  }

  const dragHandlers: DragHandlers = {
    drag,
    dropTarget,
    onPointerDown,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
    onChannelDragOver,
    onChannelDrop,
  }

  const onSurfaceDragOver = (event: DragEvent<HTMLDivElement>): void => {
    const kinds = mediaDropKinds(event.dataTransfer)
    if (!hasFilePayload(event.dataTransfer) || !actions.acceptsFileDrop(event.dataTransfer)) {
      clearFileDrop()
      return
    }
    event.preventDefault()
    setFileDropFeedback(surface, undefined, kinds)
  }

  const onSurfaceDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget
    if (!(related instanceof Node) || !surface.contains(related)) clearFileDrop()
  }

  const onSurfaceDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    const files = transferFiles(event.dataTransfer)
    if (!hasFilePayload(event.dataTransfer)) return
    event.preventDefault()
    stop(event)
    clearFileDrop()
    clearDrag()
    if (files.length > 0) void actions.addFiles(files)
  }

  return (
    <div
      data-loader-react-surface=""
      onDragOver={onSurfaceDragOver}
      onDragLeave={onSurfaceDragLeave}
      onDrop={onSurfaceDrop}
      onBlurCapture={() => {
        globalThis.queueMicrotask(() => actions.flushDeferredPreviews())
      }}
    >
      {mode === "single-image" ? (
        <SingleImagePanel snapshot={snapshot} actions={actions} surface={surface} />
      ) : (
        <>
          <LoaderToolbar snapshot={snapshot} actions={actions} />
          <p className="rl-status" role="status">
            {snapshot.status}
          </p>
          <PendingUploads snapshot={snapshot} />
          <div className="rl-channels">
            {channels.map((channel) => (
              <MediaChannel
                key={channel.channel}
                channel={channel}
                showCaptions={snapshot.display.showCaptions}
                deferPreview={snapshot.deferPreviews}
                actions={actions}
                dragHandlers={dragHandlers}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function createLoaderReact(options: LoaderReactOptions): LoaderReactMount {
  const root: Root = createRoot(options.container)
  const update = (): void => {
    flushSync(() => root.render(<ReferenceLoaderReactRoot {...options} />))
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

export const mountLoaderReact = createLoaderReact

export { LoaderToolbar, MediaChannel, MediaCard, ReferenceLoaderReactRoot, SingleImagePanel }
