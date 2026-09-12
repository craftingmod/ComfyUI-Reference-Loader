export interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
  mergeKey?: string
}

export interface HistorySnapshot<T> {
  value: T
  canUndo: boolean
  canRedo: boolean
}

export function createHistory<T>(initial: T): HistoryState<T> {
  return { past: [], present: initial, future: [] }
}

export function commitHistory<T>(
  history: HistoryState<T>,
  next: T,
  options: { mergeKey?: string; limit?: number } = {},
): HistoryState<T> {
  if (Object.is(history.present, next)) return history
  const shouldMerge = options.mergeKey !== undefined && options.mergeKey === history.mergeKey
  const past = shouldMerge ? history.past : [...history.past, history.present]
  const limit = Math.max(1, options.limit ?? 100)
  const boundedPast = past.length > limit ? past.slice(past.length - limit) : past
  return {
    past: boundedPast,
    present: next,
    future: [],
    ...(options.mergeKey ? { mergeKey: options.mergeKey } : {}),
  }
}

export function undoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  const present = history.past[history.past.length - 1]
  if (present === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  }
}

export function redoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  const [present, ...future] = history.future
  if (present === undefined) return history
  return { past: [...history.past, history.present], present, future }
}

export function canUndo<T>(history: HistoryState<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: HistoryState<T>): boolean {
  return history.future.length > 0
}

export class LocalHistory<T> {
  #history: HistoryState<T>
  #limit: number
  #snapshot: HistorySnapshot<T>
  #listeners = new Set<() => void>()

  constructor(initial: T, limit = 100) {
    this.#history = createHistory(initial)
    this.#limit = Math.max(1, limit)
    this.#snapshot = this.#createSnapshot()
  }

  get value(): T {
    return this.#history.present
  }

  get snapshot(): HistorySnapshot<T> {
    return this.#snapshot
  }

  get canUndo(): boolean {
    return canUndo(this.#history)
  }

  get canRedo(): boolean {
    return canRedo(this.#history)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    listener()
    return () => this.#listeners.delete(listener)
  }

  commit(value: T, options: { mergeKey?: string } = {}): T {
    const previous = this.#snapshot
    this.#history = commitHistory(this.#history, value, { limit: this.#limit, ...options })
    this.#publish(previous)
    return value
  }

  replace(value: T): T {
    const previous = this.#snapshot
    if (Object.is(this.#history.present, value)) return value
    this.#history = { ...this.#history, present: value }
    this.#publish(previous)
    return value
  }

  undo(): T {
    const previous = this.#snapshot
    this.#history = undoHistory(this.#history)
    this.#publish(previous)
    return this.value
  }

  redo(): T {
    const previous = this.#snapshot
    this.#history = redoHistory(this.#history)
    this.#publish(previous)
    return this.value
  }

  #createSnapshot(): HistorySnapshot<T> {
    return {
      value: this.#history.present,
      canUndo: canUndo(this.#history),
      canRedo: canRedo(this.#history),
    }
  }

  #publish(previous: HistorySnapshot<T>): void {
    const next = this.#createSnapshot()
    if (
      Object.is(previous.value, next.value) &&
      previous.canUndo === next.canUndo &&
      previous.canRedo === next.canRedo
    )
      return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }
}
