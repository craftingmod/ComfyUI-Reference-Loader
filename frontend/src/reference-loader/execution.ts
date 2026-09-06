import type {
  H3TimelineState,
  ImageEditRecipe,
  LoaderState,
  MediaSource,
  TimeRange,
} from "./types.ts"
import { validateLoaderState } from "./validation.ts"

export interface ExecutionItem {
  id: string
  kind: "image" | "audio" | "video"
  source: MediaSource
  caption: string
  enabled: boolean
  videoAudioEnabled?: boolean
  crop?: TimeRange
  edit?: ImageEditRecipe
  derivedFrom?: string
}

export interface LoaderExecutionProjection {
  version: 1
  imageOrder: string[]
  videoOrder: string[]
  audioOrder: string[]
  videoAudioPolicy: "preserve"
  h3Timeline: H3TimelineState
  images: ExecutionItem[]
  audios: ExecutionItem[]
  videos: ExecutionItem[]
}

function optionalCrop<T extends ExecutionItem>(item: T, crop: TimeRange | undefined): T {
  return crop ? { ...item, crop } : item
}

function executionSource(source: MediaSource): MediaSource {
  const { revision: _runtimeRevision, ...portable } = source
  return portable
}

function executionEdit(edit: ImageEditRecipe): ImageEditRecipe {
  return edit.mask ? { ...edit, mask: executionSource(edit.mask) } : edit
}

export function projectLoaderExecution(state: LoaderState): LoaderExecutionProjection {
  const canonical = validateLoaderState(state).state
  const images: ExecutionItem[] = []
  const videos: ExecutionItem[] = []
  const audios: ExecutionItem[] = []

  for (const id of canonical.imageOrder) {
    const item = canonical.items[id]
    if (!item || item.kind !== "image") continue
    const projected: ExecutionItem = {
      id,
      kind: item.kind,
      source: executionSource(item.source),
      caption: item.caption,
      enabled: item.imageEnabled,
    }
    images.push(item.edit ? { ...projected, edit: executionEdit(item.edit) } : projected)
  }

  for (const id of canonical.videoOrder) {
    const item = canonical.items[id]
    if (!item || item.kind !== "video") continue
    videos.push(
      optionalCrop(
        {
          id,
          kind: item.kind,
          source: executionSource(item.source),
          caption: item.caption,
          enabled: item.videoEnabled,
          videoAudioEnabled: item.videoAudioEnabled,
        },
        item.crop,
      ),
    )
  }

  for (const id of canonical.audioOrder) {
    const item = canonical.items[id]
    if (!item || item.kind === "image") continue
    if (item.kind === "audio") {
      audios.push(
        optionalCrop(
          {
            id,
            kind: item.kind,
            source: executionSource(item.source),
            caption: item.caption,
            enabled: item.audioEnabled,
          },
          item.crop,
        ),
      )
    } else {
      audios.push(
        optionalCrop(
          {
            id: `${id}:audio`,
            kind: "audio",
            source: executionSource(item.source),
            caption: item.audioCaptionOverride ?? item.caption,
            enabled: item.audioEnabled,
            derivedFrom: id,
          },
          item.crop,
        ),
      )
    }
  }

  return {
    version: 1,
    imageOrder: [...canonical.imageOrder],
    videoOrder: [...canonical.videoOrder],
    audioOrder: [...canonical.audioOrder],
    videoAudioPolicy: canonical.videoAudioPolicy,
    h3Timeline: {
      ...canonical.h3Timeline,
      guides: canonical.h3Timeline.guides.map((guide) => ({ ...guide })),
    },
    images,
    audios,
    videos,
  }
}

export function executionFingerprintSource(state: LoaderState): string {
  return JSON.stringify(projectLoaderExecution(state))
}
