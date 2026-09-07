import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from "./history.ts"
import { loaderReducer, type LoaderAction } from "./reducer.ts"
import type { LoaderState } from "./types.ts"

export interface LoaderDispatchOptions {
  mergeKey?: string
}

export class LoaderStore {
  #history: HistoryState<LoaderState>
  #historyLimit: number

  constructor(initial: LoaderState, historyLimit = 100) {
    this.#history = createHistory(initial)
    this.#historyLimit = Math.max(1, historyLimit)
  }

  get state(): LoaderState {
    return this.#history.present
  }

  get canUndo(): boolean {
    return canUndo(this.#history)
  }

  get canRedo(): boolean {
    return canRedo(this.#history)
  }

  hasChange(action: LoaderAction): boolean {
    return loaderReducer(this.state, action) !== this.state
  }

  dispatch(action: LoaderAction, options: LoaderDispatchOptions = {}): boolean {
    const next = loaderReducer(this.state, action)
    if (next === this.state) return false
    this.#history = commitHistory(this.#history, next, {
      limit: this.#historyLimit,
      ...options,
    })
    return true
  }

  undo(): boolean {
    const next = undoHistory(this.#history)
    if (next === this.#history) return false
    this.#history = next
    return true
  }

  redo(): boolean {
    const next = redoHistory(this.#history)
    if (next === this.#history) return false
    this.#history = next
    return true
  }

  restore(state: LoaderState): void {
    this.#history = createHistory(state)
  }

  canDisableSilentVideoAudio(id: string): boolean {
    const item = this.state.items[id]
    return item?.kind === "video" && (item.audioEnabled || item.videoAudioEnabled)
  }

  disableSilentVideoAudio(id: string): boolean {
    const disable = (state: LoaderState): LoaderState => {
      const item = state.items[id]
      if (item?.kind !== "video") return state
      let next = state
      if (item.audioEnabled) next = loaderReducer(next, { type: "toggle", id, channel: "audio" })
      const current = next.items[id]
      if (current?.kind === "video" && current.videoAudioEnabled)
        next = loaderReducer(next, { type: "toggle-video-audio", id })
      return next
    }
    const present = disable(this.#history.present)
    if (present === this.#history.present) return false
    this.#history = {
      ...this.#history,
      past: this.#history.past.map(disable),
      present,
      future: this.#history.future.map(disable),
    }
    return true
  }
}
