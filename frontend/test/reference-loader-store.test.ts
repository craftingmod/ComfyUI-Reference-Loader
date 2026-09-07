import { describe, expect, test } from "bun:test"

import { LoaderStore } from "../src/reference-loader/loader-store.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

const source = {
  path: "reference_loader/sources/clip.mp4",
  mime: "video/mp4",
  sha256: "a".repeat(64),
}

describe("Reference Loader store", () => {
  test("owns action history, caption merges, and no-op detection", () => {
    const store = new LoaderStore(createEmptyLoaderState())
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/image.png", mime: "image/png", sha256: "b".repeat(64) },
      "image-1",
    )

    expect(store.dispatch({ type: "add", item: image })).toBe(true)
    expect(store.canUndo).toBe(true)
    expect(store.dispatch({ type: "set-caption", id: image.id, caption: "" })).toBe(false)

    expect(
      store.dispatch(
        { type: "set-caption", id: image.id, caption: "A" },
        { mergeKey: "caption:image:image-1" },
      ),
    ).toBe(true)
    expect(
      store.dispatch(
        { type: "set-caption", id: image.id, caption: "AB" },
        { mergeKey: "caption:image:image-1" },
      ),
    ).toBe(true)
    expect(store.state.items[image.id]?.caption).toBe("AB")

    expect(store.undo()).toBe(true)
    expect(store.state.items[image.id]?.caption).toBe("")
    expect(store.redo()).toBe(true)
    expect(store.state.items[image.id]?.caption).toBe("AB")
  })

  test("restore starts a fresh history", () => {
    const store = new LoaderStore(createEmptyLoaderState())
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/image.png", mime: "image/png", sha256: "c".repeat(64) },
      "image-1",
    )
    store.dispatch({ type: "add", item: image })

    store.restore(createEmptyLoaderState())

    expect(store.state.items).toEqual({})
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
  })

  test("repairs silent video audio flags throughout undo and redo history", () => {
    const store = new LoaderStore(createEmptyLoaderState())
    const video = createMediaItem("video", source, "video-1")
    store.dispatch({ type: "add", item: video })
    store.dispatch({ type: "toggle", id: video.id, channel: "audio" })
    store.dispatch({ type: "toggle-video-audio", id: video.id })
    store.undo()

    expect(store.state.items[video.id]).toMatchObject({
      audioEnabled: true,
      videoAudioEnabled: true,
    })
    expect(store.canDisableSilentVideoAudio(video.id)).toBe(true)
    expect(store.disableSilentVideoAudio(video.id)).toBe(true)
    expect(store.state.items[video.id]).toMatchObject({
      audioEnabled: false,
      videoAudioEnabled: false,
    })

    store.undo()
    expect(store.state.items[video.id]).toMatchObject({
      audioEnabled: false,
      videoAudioEnabled: false,
    })
    store.redo()
    expect(store.state.items[video.id]).toMatchObject({
      audioEnabled: false,
      videoAudioEnabled: false,
    })
  })
})
