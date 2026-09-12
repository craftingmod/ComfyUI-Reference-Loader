import { h3Placements, type H3TimelinePlacement } from "../h3-media-guides.ts"
import {
  H3_TIMELINE_DEFAULT_FRAME_COUNT,
  H3_TIMELINE_NATIVE_FPS,
  type ItemRuntime,
  type LoaderState,
} from "../types.ts"

const FPS = H3_TIMELINE_NATIVE_FPS

function safeFps(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : FPS
}

export function nativeToTimelineFrame(frame: number, fps = FPS): number {
  if (!Number.isSafeInteger(frame) || frame < 0) return frame
  return Math.max(0, Math.round((frame * safeFps(fps)) / FPS))
}

export function timelineToNativeFrame(frame: number, fps = FPS): number {
  if (!Number.isFinite(frame)) return frame
  return Math.max(0, Math.round((frame * FPS) / safeFps(fps)))
}

export function timelineFrameInputToNative(value: string, fps = FPS): string {
  const raw = value.trim()
  if (raw === "") return value
  const frame = Number(raw)
  if (!Number.isSafeInteger(frame) || frame < 0) return value
  return String(timelineToNativeFrame(frame, fps))
}

export function timelineSeconds(frame: number, fps = FPS): string {
  return (frame / safeFps(fps)).toFixed(3)
}

export interface TimelineMark {
  placement: H3TimelinePlacement
  channel: "visual" | "audio" | "shot"
  audioOrdinal?: number
  shotTag?: string
  label: string
  previewUrl?: string
  frame: number
  frames?: number
  nativeFrame: number
  nativeFrames?: number
  disabled: boolean
  incomplete: boolean
  warning?: string
}

export function timelineMarks(
  state: LoaderState,
  runtime: ReadonlyMap<string, ItemRuntime>,
  shots: readonly { tag: string; frameIndex: number }[] = [],
  fps = FPS,
): TimelineMark[] {
  const displayFps = safeFps(fps)
  const marks: TimelineMark[] = []
  let audioOrdinal = 0
  for (const placement of h3Placements(state.h3Timeline)) {
    for (const channel of ["visual", "audio"] as const) {
      const id = channel === "visual" ? placement.visualId : placement.audioId
      const empty = !placement.visualId && !placement.audioId
      if (!id && !(empty && channel === "visual")) continue
      const item = id ? state.items[id] : undefined
      const loaded = id ? runtime.get(id) : undefined
      const duration =
        item?.kind === "audio"
          ? item.crop
            ? item.crop.end - item.crop.start
            : loaded?.metadata?.duration
          : undefined
      const disabledIds =
        channel === "visual"
          ? state.h3Timeline.disabledVisualIds
          : state.h3Timeline.disabledAudioIds
      const nativeFrame = placement.frameIndex ?? 0
      marks.push({
        placement,
        channel,
        ...(channel === "audio" ? { audioOrdinal: ++audioOrdinal } : {}),
        label: item?.sourceFilename || item?.source.path.split("/").pop() || "Media needed",
        previewUrl: channel === "visual" ? loaded?.previewUrl : undefined,
        frame: nativeToTimelineFrame(nativeFrame, displayFps),
        frames:
          channel === "visual"
            ? 1
            : duration !== undefined && Number.isFinite(duration) && duration > 0
              ? Math.max(1, Math.ceil(duration * displayFps))
              : undefined,
        nativeFrame,
        ...(channel === "visual"
          ? { nativeFrames: 1 }
          : duration !== undefined && Number.isFinite(duration) && duration > 0
            ? { nativeFrames: Math.max(1, Math.ceil(duration * FPS)) }
            : {}),
        disabled: !state.h3Timeline.enabled || Boolean(id && disabledIds?.includes(id)),
        incomplete:
          !item ||
          !Number.isSafeInteger(placement.frameIndex ?? 0) ||
          (placement.frameIndex ?? 0) < 0,
      })
    }
  }
  for (const shot of shots) {
    marks.push({
      placement: { kind: "guide", guideId: `shot:${shot.tag}`, frameIndex: shot.frameIndex },
      channel: "shot",
      shotTag: shot.tag,
      label: `#${shot.tag}`,
      frame: nativeToTimelineFrame(shot.frameIndex, displayFps),
      frames: 1,
      nativeFrame: shot.frameIndex,
      nativeFrames: 1,
      disabled: false,
      incomplete: !Number.isSafeInteger(shot.frameIndex) || shot.frameIndex < 0,
    })
  }
  // At most 34 placements; pairwise checks also keep both sides of a conflict visible.
  for (const [index, mark] of marks.entries()) {
    if (
      mark.channel === "shot" ||
      mark.disabled ||
      mark.placement.kind === "end" ||
      mark.frames === undefined
    )
      continue
    for (const other of marks.slice(index + 1)) {
      if (
        other.channel === "shot" ||
        other.disabled ||
        other.placement.kind === "end" ||
        other.channel !== mark.channel ||
        other.frames === undefined
      )
        continue
      if (
        mark.nativeFrame < other.nativeFrame + (other.nativeFrames ?? 1) &&
        other.nativeFrame < mark.nativeFrame + (mark.nativeFrames ?? 1)
      ) {
        mark.warning =
          other.warning = `${mark.channel === "audio" ? "Audio ranges" : "Image placements"} overlap. Wrapper validates the final output.`
      }
    }
  }
  return marks
}

export function timelineExtent(
  marks: TimelineMark[],
  frameCount = H3_TIMELINE_DEFAULT_FRAME_COUNT,
  fps = FPS,
): number {
  const displayFps = safeFps(fps)
  const configuredFrameCount =
    Number.isSafeInteger(frameCount) && frameCount > 0
      ? frameCount
      : H3_TIMELINE_DEFAULT_FRAME_COUNT
  return Math.max(
    configuredFrameCount,
    ...marks
      .filter((mark) => mark.placement.kind !== "end" && Number.isSafeInteger(mark.frame))
      .map(
        (mark) =>
          Math.ceil(
            Math.max(mark.frame + (mark.frames ?? 1) + displayFps, mark.frame * 1.16) / displayFps,
          ) * displayFps,
      ),
  )
}

export function draggedFrame(frame: number, deltaX: number, width: number, extent: number): number {
  if (!(width > 0)) return frame
  return Math.max(0, Math.min(extent - 1, Math.round(frame + (deltaX / width) * extent)))
}
