import {
  pruneDisabledGuideMedia,
  validateH3Timeline,
  type H3GuideChannel,
} from "./h3-media-guides.ts"
import {
  isAudioItem,
  H3_OUTPUT_MAX_FPS,
  H3_OUTPUT_MAX_TOTAL_FRAMES,
  H3_OUTPUT_MIN_FPS,
  H3_OUTPUT_MIN_TOTAL_FRAMES,
  createEmptyH3Timeline,
  MAX_H3_GUIDES,
  type LoaderState,
  type LoaderUiPreferences,
  type H3OutputSettings,
  type ImageEditRecipe,
  type MediaItem,
  type TimeRange,
  type H3GuideEntry,
  type H3TimelineState,
} from "./types.ts"
import { validateLoaderState } from "./validation.ts"

export type LoaderChannel = "image" | "video" | "audio"

export type LoaderAction =
  | { type: "replace"; state: LoaderState }
  | { type: "add"; item: MediaItem }
  | { type: "replace-media"; id: string; item: MediaItem }
  | { type: "clear" }
  | { type: "remove"; id: string }
  | { type: "set-caption"; id: string; caption: string; channel?: LoaderChannel }
  | { type: "toggle"; id: string; channel: LoaderChannel }
  | { type: "toggle-video-audio"; id: string }
  | { type: "reorder"; channel: LoaderChannel; id: string; toIndex: number }
  | { type: "move"; channel: LoaderChannel; id: string; delta: -1 | 1 }
  | {
      type: "apply-image-edit"
      id: string
      edit: ImageEditRecipe
      source?: MediaItem["source"]
      caption?: string
    }
  | { type: "restore-image-original"; id: string; caption?: string }
  | {
      type: "apply-time-range"
      id: string
      crop?: TimeRange
      caption?: string
      channel?: LoaderChannel
    }
  | { type: "set-ui"; values: Partial<LoaderUiPreferences> }
  | { type: "set-h3-output"; values: Partial<H3OutputSettings> }
  | { type: "set-h3-timeline"; timeline: H3TimelineState }
  | { type: "toggle-h3-timeline"; enabled: boolean }
  | { type: "set-h3-start"; id: string | null }
  | { type: "set-h3-end"; id: string | null }
  | { type: "add-h3-guide"; guide: H3GuideEntry }
  | { type: "update-h3-guide"; id: string; values: Partial<H3GuideEntry> }
  | { type: "remove-h3-guide"; id: string }
  | {
      type: "apply-h3-media-edit"
      mediaId: string
      channel: H3GuideChannel
      referenceEnabled: boolean
      timeline: H3TimelineState
      twoImageMode?: boolean
    }

function replaceItem(state: LoaderState, item: MediaItem): LoaderState {
  return { ...state, items: { ...state.items, [item.id]: item } }
}

function preserveMediaSettings(current: MediaItem, replacement: MediaItem): MediaItem {
  if (current.kind === "image" && replacement.kind === "image")
    return { ...replacement, caption: current.caption, imageEnabled: current.imageEnabled }
  if (current.kind === "audio" && replacement.kind === "audio")
    return { ...replacement, caption: current.caption, audioEnabled: current.audioEnabled }
  if (current.kind === "video" && replacement.kind === "video")
    return {
      ...replacement,
      caption: current.caption,
      videoEnabled: current.videoEnabled,
      videoAudioEnabled: current.videoAudioEnabled,
      audioEnabled: current.audioEnabled,
      ...(current.audioCaptionOverride === undefined
        ? {}
        : { audioCaptionOverride: current.audioCaptionOverride }),
    }
  return replacement
}

function moveInOrder(order: string[], id: string, toIndex: number): string[] {
  const fromIndex = order.indexOf(id)
  if (fromIndex < 0) return order
  const next = order.filter((candidate) => candidate !== id)
  const bounded = Math.max(0, Math.min(next.length, toIndex))
  next.splice(bounded, 0, id)
  return next.every((candidate, index) => candidate === order[index]) ? order : next
}

function replaceTimeline(state: LoaderState, timeline: H3TimelineState): LoaderState {
  return {
    ...state,
    h3Timeline: {
      ...timeline,
      guides: timeline.guides.map((guide) => ({ ...guide })),
      ...(timeline.disabledVisualIds ? { disabledVisualIds: [...timeline.disabledVisualIds] } : {}),
      ...(timeline.disabledAudioIds ? { disabledAudioIds: [...timeline.disabledAudioIds] } : {}),
    },
  }
}

function clearTimelineReferences(timeline: H3TimelineState, mediaId: string): H3TimelineState {
  return pruneDisabledGuideMedia({
    ...timeline,
    startImageId: timeline.startImageId === mediaId ? null : timeline.startImageId,
    endImageId: timeline.endImageId === mediaId ? null : timeline.endImageId,
    guides: timeline.guides.map((guide) => ({
      ...guide,
      visualId: guide.visualId === mediaId ? null : guide.visualId,
      audioId:
        guide.audioId === mediaId || guide.audioId === `${mediaId}:audio` ? null : guide.audioId,
    })),
  })
}

function applyH3MediaEdit(
  state: LoaderState,
  action: Extract<LoaderAction, { type: "apply-h3-media-edit" }>,
): LoaderState {
  const itemId =
    action.channel === "audio" && action.mediaId.endsWith(":audio")
      ? action.mediaId.slice(0, -6)
      : action.mediaId
  const item = state.items[itemId]
  if (!item) return state
  if (action.channel === "visual" && item.kind !== "image") return state
  if (action.channel === "audio" && item.kind !== "audio") return state
  if (validateH3Timeline(state, action.timeline, { allowIncomplete: true }).length > 0) return state

  if (
    action.twoImageMode &&
    action.channel === "visual" &&
    item.kind === "image" &&
    action.referenceEnabled &&
    !item.imageEnabled &&
    state.imageOrder.reduce((count, id) => {
      const image = state.items[id]
      return count + (image?.kind === "image" && image.imageEnabled ? 1 : 0)
    }, 0) >= 2
  )
    return state

  let nextItem = item
  if (action.channel === "visual" && item.kind === "image")
    nextItem = { ...item, imageEnabled: action.referenceEnabled }
  else if (action.channel === "audio" && isAudioItem(item))
    nextItem = { ...item, audioEnabled: action.referenceEnabled }

  const nextTimeline = replaceTimeline(state, action.timeline).h3Timeline
  if (nextItem === item && JSON.stringify(nextTimeline) === JSON.stringify(state.h3Timeline))
    return state
  return {
    ...state,
    items: nextItem === item ? state.items : { ...state.items, [itemId]: nextItem },
    h3Timeline: nextTimeline,
  }
}

export function loaderReducer(state: LoaderState, action: LoaderAction): LoaderState {
  switch (action.type) {
    case "replace":
      return validateLoaderState(action.state).state
    case "add": {
      if (state.items[action.item.id]) return state
      return {
        ...state,
        items: { ...state.items, [action.item.id]: action.item },
        imageOrder:
          action.item.kind === "image" ? [...state.imageOrder, action.item.id] : state.imageOrder,
        videoOrder:
          action.item.kind === "video" ? [...state.videoOrder, action.item.id] : state.videoOrder,
        audioOrder: isAudioItem(action.item)
          ? [...state.audioOrder, action.item.id]
          : state.audioOrder,
      }
    }
    case "replace-media": {
      const current = state.items[action.id]
      if (!current || current.kind !== action.item.kind || action.item.id !== action.id)
        return state
      return replaceItem(state, preserveMediaSettings(current, action.item))
    }
    case "clear":
      return Object.keys(state.items).length === 0 &&
        !state.h3Timeline.enabled &&
        state.h3Timeline.startImageId === null &&
        state.h3Timeline.endImageId === null &&
        state.h3Timeline.guides.length === 0
        ? state
        : {
            ...state,
            items: {},
            imageOrder: [],
            videoOrder: [],
            audioOrder: [],
            h3Timeline: createEmptyH3Timeline(),
          }
    case "remove": {
      if (!state.items[action.id]) return state
      const items = { ...state.items }
      delete items[action.id]
      return {
        ...state,
        items,
        imageOrder: state.imageOrder.filter((id) => id !== action.id),
        videoOrder: state.videoOrder.filter((id) => id !== action.id),
        audioOrder: state.audioOrder.filter((id) => id !== action.id),
        h3Timeline: clearTimelineReferences(state.h3Timeline, action.id),
      }
    }
    case "set-caption": {
      const item = state.items[action.id]
      if (!item) return state
      const caption = action.caption.slice(0, 16_384)
      if (item.kind === "video" && action.channel === "audio") {
        if (item.audioCaptionOverride === caption) return state
        return replaceItem(state, { ...item, audioCaptionOverride: caption })
      }
      if (item.caption === caption) return state
      return replaceItem(state, { ...item, caption })
    }
    case "toggle": {
      const item = state.items[action.id]
      if (!item) return state
      if (action.channel === "image" && item.kind === "image") {
        return replaceItem(state, { ...item, imageEnabled: !item.imageEnabled })
      }
      if (action.channel === "video" && item.kind === "video") {
        return replaceItem(state, { ...item, videoEnabled: !item.videoEnabled })
      }
      if (action.channel === "audio" && isAudioItem(item)) {
        return replaceItem(state, { ...item, audioEnabled: !item.audioEnabled })
      }
      return state
    }
    case "toggle-video-audio": {
      const item = state.items[action.id]
      return item?.kind === "video"
        ? replaceItem(state, { ...item, videoAudioEnabled: !item.videoAudioEnabled })
        : state
    }
    case "reorder": {
      const key =
        action.channel === "image"
          ? "imageOrder"
          : action.channel === "video"
            ? "videoOrder"
            : "audioOrder"
      const next = moveInOrder(state[key], action.id, action.toIndex)
      return next === state[key] ? state : { ...state, [key]: next }
    }
    case "move": {
      const order =
        action.channel === "image"
          ? state.imageOrder
          : action.channel === "video"
            ? state.videoOrder
            : state.audioOrder
      const index = order.indexOf(action.id)
      if (index < 0) return state
      const target = Math.max(0, Math.min(order.length - 1, index + action.delta))
      if (target === index) return state
      return loaderReducer(state, {
        type: "reorder",
        channel: action.channel,
        id: action.id,
        toIndex: target,
      })
    }
    case "apply-image-edit": {
      const item = state.items[action.id]
      if (!item || item.kind !== "image") return state
      const edited = replaceItem(state, {
        ...item,
        ...(action.source ? { source: action.source } : {}),
        edit: action.edit,
      })
      return action.caption === undefined
        ? edited
        : loaderReducer(edited, { type: "set-caption", id: action.id, caption: action.caption })
    }
    case "restore-image-original": {
      const item = state.items[action.id]
      if (!item || item.kind !== "image") return state
      const { edit: _discarded, ...withoutEdit } = item
      return replaceItem(state, {
        ...withoutEdit,
        source: item.originalSource,
        caption: action.caption === undefined ? item.caption : action.caption.slice(0, 16_384),
      })
    }
    case "apply-time-range": {
      const item = state.items[action.id]
      if (!item || item.kind === "image") return state
      if (action.crop) {
        const trimmed = replaceItem(state, { ...item, crop: action.crop })
        return action.caption === undefined
          ? trimmed
          : loaderReducer(trimmed, {
              type: "set-caption",
              id: action.id,
              caption: action.caption,
              ...(action.channel ? { channel: action.channel } : {}),
            })
      }
      const { crop: _discarded, ...withoutCrop } = item
      return replaceItem(state, withoutCrop)
    }
    case "set-ui":
      return { ...state, ui: { ...state.ui, ...action.values } }
    case "set-h3-output": {
      const fps =
        action.values.fps === undefined
          ? state.h3Output.fps
          : Math.min(H3_OUTPUT_MAX_FPS, Math.max(H3_OUTPUT_MIN_FPS, Math.round(action.values.fps)))
      const totalFrames =
        action.values.totalFrames === undefined
          ? state.h3Output.totalFrames
          : Math.min(
              H3_OUTPUT_MAX_TOTAL_FRAMES,
              Math.max(H3_OUTPUT_MIN_TOTAL_FRAMES, Math.round(action.values.totalFrames)),
            )
      if (fps === state.h3Output.fps && totalFrames === state.h3Output.totalFrames) return state
      return { ...state, h3Output: { fps, totalFrames } }
    }
    case "set-h3-timeline":
      return replaceTimeline(state, action.timeline)
    case "toggle-h3-timeline":
      return replaceTimeline(state, { ...state.h3Timeline, enabled: action.enabled })
    case "set-h3-start":
      return replaceTimeline(state, { ...state.h3Timeline, startImageId: action.id })
    case "set-h3-end":
      return replaceTimeline(state, { ...state.h3Timeline, endImageId: action.id })
    case "add-h3-guide":
      return state.h3Timeline.guides.length >= MAX_H3_GUIDES
        ? state
        : replaceTimeline(state, {
            ...state.h3Timeline,
            guides: [...state.h3Timeline.guides, { ...action.guide }],
          })
    case "update-h3-guide": {
      const index = state.h3Timeline.guides.findIndex((guide) => guide.id === action.id)
      if (index < 0) return state
      const guides = state.h3Timeline.guides.map((guide, guideIndex) =>
        guideIndex === index ? { ...guide, ...action.values, id: guide.id } : guide,
      )
      return replaceTimeline(state, { ...state.h3Timeline, guides })
    }
    case "remove-h3-guide": {
      const guides = state.h3Timeline.guides.filter((guide) => guide.id !== action.id)
      return guides.length === state.h3Timeline.guides.length
        ? state
        : replaceTimeline(state, { ...state.h3Timeline, guides })
    }
    case "apply-h3-media-edit":
      return applyH3MediaEdit(state, action)
  }
}
