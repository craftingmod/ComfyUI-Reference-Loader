import { describe, expect, test } from "bun:test"

import type { ComfyApiLike } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import {
  MediaRuntimeCoordinator,
  type MediaRuntimeHost,
} from "../src/reference-loader/media-runtime-coordinator.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  type LoaderState,
} from "../src/reference-loader/types.ts"

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((next) => (resolve = next)), resolve }
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function createHost(
  state: LoaderState,
  api: ReferenceLoaderApi,
  overrides: Partial<MediaRuntimeHost> = {},
): MediaRuntimeHost {
  return {
    getState: () => state,
    getApi: () => api,
    getPreviewMaxPixels: () => state.ui.previewMaxPixels,
    getWaveformPeaks: () => state.ui.waveformPeaks,
    isDestroyed: () => false,
    setStatus: () => undefined,
    render: () => undefined,
    scheduleRender: () => undefined,
    publishRuntimeUpdate: () => undefined,
    commitUploadedMedia: () => undefined,
    commitRuntimeCapabilityChange: () => undefined,
    onRuntimePreviewUpdated: () => undefined,
    ...overrides,
  }
}

describe("MediaRuntimeCoordinator", () => {
  test("keeps the newest sequence when an older reload completes later", async () => {
    const image = createMediaItem(
      "image",
      { path: "sources/image.png", mime: "image/png", sha256: "a".repeat(64) },
      "image-1",
    )
    const state = {
      ...createEmptyLoaderState(),
      items: { [image.id]: image },
      imageOrder: [image.id],
    }
    const requests: Array<{ route: string; resolve: (value: Response) => void }> = []
    const api: ComfyApiLike = {
      fetchApi(route) {
        const next = deferred<Response>()
        requests.push({ route, resolve: next.resolve })
        return next.promise
      },
    }
    const coordinator = new MediaRuntimeCoordinator(createHost(state, new ReferenceLoaderApi(api)))

    const firstLoad = coordinator.load(image, { renderStart: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const secondLoad = coordinator.load(image, { renderStart: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toHaveLength(4)

    requests[2]?.resolve(response({ metadata: { width: 2, height: 2 } }))
    requests[3]?.resolve(response({ url: "/new.webp" }))
    await secondLoad
    requests[0]?.resolve(response({ metadata: { width: 1, height: 1 } }))
    requests[1]?.resolve(response({ url: "/old.webp" }))
    await firstLoad

    expect(coordinator.getRuntime(image.id)).toMatchObject({
      loading: false,
      previewUrl: "/new.webp",
      metadata: { width: 2, height: 2 },
    })
    coordinator.destroy()
  })

  test("does not commit or retain an upload completed after a state reset", async () => {
    const uploadResponse = deferred<Response>()
    const api: ComfyApiLike = { fetchApi: () => uploadResponse.promise }
    const state = createEmptyLoaderState()
    let commits = 0
    const host = createHost(state, new ReferenceLoaderApi(api), {
      commitUploadedMedia: () => {
        commits += 1
        return undefined
      },
    })
    const coordinator = new MediaRuntimeCoordinator(host)
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let revoked = 0
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:runtime-test",
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {
        revoked += 1
      },
    })
    try {
      const upload = coordinator.upload(new File(["image"], "image.png", { type: "image/png" }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(coordinator.pending.size).toBe(1)

      coordinator.resetForStateChange()
      uploadResponse.resolve(
        response({
          kind: "image",
          source: { path: "sources/image.png", mime: "image/png", sha256: "b".repeat(64) },
          metadata: { width: 2, height: 2 },
        }),
      )
      await upload

      expect(commits).toBe(0)
      expect(coordinator.pending.size).toBe(0)
      expect(revoked).toBe(1)
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      })
      coordinator.destroy()
    }
  })
})
