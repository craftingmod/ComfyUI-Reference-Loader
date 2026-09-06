import type { H3GuideEntry, H3TimelineState, LoaderState, MediaItem } from "./types.ts"

export type H3GuideChannel = "visual" | "audio"
export type H3MediaUsage = "reference" | "guide" | "both" | "unused"

export interface H3TimelinePlacement {
  kind: "start" | "guide" | "end"
  frameIndex: number | null
  guideId?: string
  visualId?: string | null
  audioId?: string | null
}

export interface H3TimelineCounts {
  mediaCount: number
  referenceCount: number
  placementCount: number
  incompleteCount: number
}

export function cloneH3Timeline(timeline: H3TimelineState): H3TimelineState {
  return {
    ...timeline,
    guides: timeline.guides.map((guide) => ({ ...guide })),
  }
}

export function timelineMediaId(item: MediaItem, channel: H3GuideChannel): string {
  return channel === "audio" && item.kind === "video" ? `${item.id}:audio` : item.id
}

export function canUseAsH3Guide(item: MediaItem, channel: H3GuideChannel): boolean {
  return channel === "visual" ? item.kind === "image" : item.kind === "audio"
}

export function guideUsesMedia(
  guide: H3GuideEntry,
  mediaId: string,
  channel: H3GuideChannel,
): boolean {
  return channel === "visual" ? guide.visualId === mediaId : guide.audioId === mediaId
}

export function mediaHasGuide(
  timeline: H3TimelineState,
  mediaId: string,
  channel: H3GuideChannel,
): boolean {
  if (
    channel === "visual" &&
    (timeline.startImageId === mediaId || timeline.endImageId === mediaId)
  )
    return true
  return timeline.guides.some((guide) => guideUsesMedia(guide, mediaId, channel))
}

export function referenceEnabled(item: MediaItem, channel: H3GuideChannel): boolean {
  if (channel === "visual") {
    return item.kind === "image" ? item.imageEnabled : item.kind === "video" && item.videoEnabled
  }
  return (item.kind === "audio" || item.kind === "video") && item.audioEnabled
}

export function mediaUsage(
  state: LoaderState,
  item: MediaItem,
  channel: H3GuideChannel = "visual",
): H3MediaUsage {
  const mediaId = timelineMediaId(item, channel)
  const reference = referenceEnabled(item, channel)
  if (!canUseAsH3Guide(item, channel)) return reference ? "reference" : "unused"
  const guide = mediaHasGuide(state.h3Timeline, mediaId, channel)
  if (reference && guide) return "both"
  if (reference) return "reference"
  if (guide) return "guide"
  return "unused"
}

export function h3Placements(timeline: H3TimelineState): H3TimelinePlacement[] {
  const placements: H3TimelinePlacement[] = []
  if (timeline.startImageId !== null) {
    placements.push({ kind: "start", frameIndex: 0, visualId: timeline.startImageId })
  }
  for (const guide of timeline.guides) {
    placements.push({
      kind: "guide",
      frameIndex: guide.frameIndex,
      guideId: guide.id,
      visualId: guide.visualId,
      audioId: guide.audioId,
    })
  }
  if (timeline.endImageId !== null) {
    placements.push({ kind: "end", frameIndex: null, visualId: timeline.endImageId })
  }
  return placements.sort((left, right) => {
    if (left.kind === "start") return -1
    if (right.kind === "start") return 1
    if (left.kind === "end") return 1
    if (right.kind === "end") return -1
    return (left.frameIndex ?? 0) - (right.frameIndex ?? 0)
  })
}

export function h3TimelineCounts(state: LoaderState): H3TimelineCounts {
  const placements = h3Placements(state.h3Timeline)
  const referenceCount = Object.values(state.items).reduce((count, item) => {
    if (item.kind === "image") return count + (item.imageEnabled ? 1 : 0)
    if (item.kind === "video")
      return count + (item.videoEnabled ? 1 : 0) + (item.audioEnabled ? 1 : 0)
    return count + (item.audioEnabled ? 1 : 0)
  }, 0)
  const incompleteCount = state.h3Timeline.guides.filter(
    (guide) => guide.visualId === null && guide.audioId === null,
  ).length
  return {
    mediaCount: Object.keys(state.items).length,
    referenceCount,
    placementCount: placements.length,
    incompleteCount,
  }
}

function itemForTimelineId(state: LoaderState, mediaId: string): MediaItem | undefined {
  if (mediaId.endsWith(":audio")) return state.items[mediaId.slice(0, -6)]
  return state.items[mediaId]
}

export function validateH3Timeline(
  state: LoaderState,
  timeline: H3TimelineState,
  options: { allowIncomplete?: boolean } = {},
): string[] {
  const issues: string[] = []
  if (timeline.version !== 1) issues.push("Timeline version is not supported.")
  if (timeline.guides.length > 32) issues.push("Timeline supports at most 32 guides.")
  const seenIds = new Set<string>()
  const visualFrames = new Map<number, string>()
  const audioFrames = new Map<number, string>()
  const checkImage = (mediaId: string | null, label: string): void => {
    if (mediaId === null) return
    if (state.items[mediaId]?.kind !== "image") issues.push(`${label} must refer to an image.`)
  }
  checkImage(timeline.startImageId, "Start")
  checkImage(timeline.endImageId, "End")
  if (timeline.startImageId !== null) visualFrames.set(0, "Start")
  for (const [index, guide] of timeline.guides.entries()) {
    const label = `Guide ${index + 1}`
    if (!guide.id || seenIds.has(guide.id)) issues.push(`${label} has a duplicate or empty ID.`)
    seenIds.add(guide.id)
    if (!Number.isInteger(guide.frameIndex) || guide.frameIndex < 0)
      issues.push(`${label} frame must be a non-negative integer.`)
    if (guide.visualId === null && guide.audioId === null && !options.allowIncomplete)
      issues.push(`${label} needs a visual or audio source.`)
    if (guide.visualId !== null) {
      const item = itemForTimelineId(state, guide.visualId)
      if (item?.kind !== "image") issues.push(`${label} visual source must be an image.`)
      const previous = visualFrames.get(guide.frameIndex)
      if (previous) issues.push(`${label} overlaps visual placement ${previous}.`)
      else visualFrames.set(guide.frameIndex, label)
    }
    if (guide.audioId !== null) {
      const item = itemForTimelineId(state, guide.audioId)
      if (item?.kind !== "audio") issues.push(`${label} audio source must be standalone audio.`)
      const previous = audioFrames.get(guide.frameIndex)
      if (previous) issues.push(`${label} overlaps audio placement ${previous}.`)
      else audioFrames.set(guide.frameIndex, label)
    }
  }
  return issues
}
