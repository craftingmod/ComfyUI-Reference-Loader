import { describe, expect, test } from "bun:test"

import type {
  ComfyApiLike,
  ComfyAppLike,
  ComfyExtension,
  ComfyNode,
  ComfyWidget,
} from "../src/comfyui.ts"
import {
  PROMPT_LIVE_CACHE_NODE_TYPE,
  REFERENCE_PROMPT_CACHE_NODE_TYPE,
  registerReferencePromptCache,
} from "../src/reference-loader/prompt-cache.ts"

function widget(name: string): ComfyWidget {
  return { name, value: "" }
}

function api(): ComfyApiLike & EventTarget {
  return Object.assign(new EventTarget(), {
    fetchApi: async () => new Response("{}"),
  })
}

function appWithGraph(graph: { getNodeById(id: string): ComfyNode | null }): ComfyAppLike {
  return {
    graph,
    registerExtension() {},
  } as ComfyAppLike
}

function appWithExtension(onExtension: (extension: ComfyExtension) => void): ComfyAppLike {
  return {
    registerExtension(extension) {
      onExtension(extension)
    },
  } as ComfyAppLike
}

describe("Reference Prompt Cache frontend bridge", () => {
  test("captures refreshed prompt and hash from executed UI output", () => {
    const prompt = widget("cached_prompt")
    const hash = widget("cached_ref_hash")
    const invalidateKey = widget("cached_invalidate_key")
    let dirty = 0
    const node: ComfyNode = {
      type: REFERENCE_PROMPT_CACHE_NODE_TYPE,
      widgets: [prompt, hash, invalidateKey],
      addDOMWidget: () => prompt,
      setDirtyCanvas: () => dirty++,
    }
    const eventApi = api()
    registerReferencePromptCache(appWithGraph({ getNodeById: () => node }), eventApi)

    eventApi.dispatchEvent(
      new CustomEvent("executed", {
        detail: {
          node: "7",
          display_node: "7",
          output: {
            cached_prompt: ["fresh prompt"],
            cached_ref_hash: ["a".repeat(64)],
            cached_invalidate_key: ["c".repeat(64)],
          },
        },
      }),
    )

    expect(prompt.value).toBe("fresh prompt")
    expect(hash.value).toBe("a".repeat(64))
    expect(invalidateKey.value).toBe("c".repeat(64))
    expect(dirty).toBe(1)
  })

  test("resolves execution IDs inside subgraphs", () => {
    const prompt = widget("cached_prompt")
    const hash = widget("cached_ref_hash")
    const invalidateKey = widget("cached_invalidate_key")
    const node: ComfyNode = {
      type: REFERENCE_PROMPT_CACHE_NODE_TYPE,
      widgets: [prompt, hash, invalidateKey],
      addDOMWidget: () => prompt,
      setDirtyCanvas: () => undefined,
    }
    const eventApi = api()
    registerReferencePromptCache(
      appWithGraph({
        getNodeById: (id) =>
          id === "1"
            ? ({
                subgraph: { getNodeById: (nestedId: string) => (nestedId === "7" ? node : null) },
              } as unknown as ComfyNode)
            : null,
      }),
      eventApi,
    )

    eventApi.dispatchEvent(
      new CustomEvent("executed", {
        detail: {
          node: "1:7",
          display_node: "1:7",
          output: {
            cached_prompt: "nested prompt",
            cached_ref_hash: "b".repeat(64),
            cached_invalidate_key: "d".repeat(64),
          },
        },
      }),
    )

    expect(prompt.value).toBe("nested prompt")
    expect(hash.value).toBe("b".repeat(64))
    expect(invalidateKey.value).toBe("d".repeat(64))
  })

  test("syncs the generic Prompt Live Cache node", () => {
    const prompt = widget("cached_prompt")
    const invalidateKey = widget("cached_invalidate_key")
    const node: ComfyNode = {
      type: PROMPT_LIVE_CACHE_NODE_TYPE,
      widgets: [prompt, invalidateKey],
      addDOMWidget: () => prompt,
      setDirtyCanvas: () => undefined,
    }
    const eventApi = api()
    registerReferencePromptCache(appWithGraph({ getNodeById: () => node }), eventApi)

    eventApi.dispatchEvent(
      new CustomEvent("executed", {
        detail: {
          node: "8",
          display_node: "8",
          output: {
            cached_prompt: ["generic prompt"],
            cached_invalidate_key: ["e".repeat(64)],
          },
        },
      }),
    )

    expect(prompt.value).toBe("generic prompt")
    expect(invalidateKey.value).toBe("e".repeat(64))
  })

  test("keeps the cached prompt editable and locks cache fingerprints", () => {
    const prompt = widget("cached_prompt")
    const hash = widget("cached_ref_hash")
    const invalidateKey = widget("cached_invalidate_key")
    const forceRefresh = widget("force_refresh")
    const node: ComfyNode = {
      type: REFERENCE_PROMPT_CACHE_NODE_TYPE,
      widgets: [prompt, hash, forceRefresh, invalidateKey],
      addDOMWidget: () => prompt,
      setDirtyCanvas: () => undefined,
    }
    let extension: { nodeCreated?(node: ComfyNode, app: ComfyAppLike): void } | undefined
    const app = appWithExtension((candidate) => {
      extension = candidate
    })

    registerReferencePromptCache(app, api())
    extension?.nodeCreated?.(node, app)

    expect(prompt.options?.read_only).toBeUndefined()
    expect(hash.options?.read_only).toBe(true)
    expect(prompt.options?.disabled).toBeUndefined()
    expect(hash.options?.disabled).toBe(true)
    expect(prompt.disabled).toBe(false)
    expect(prompt.computedDisabled).toBe(false)
    expect(hash.disabled).toBe(true)
    expect(hash.computedDisabled).toBe(true)
    expect(invalidateKey.options?.read_only).toBe(true)
    expect(invalidateKey.options?.disabled).toBe(true)
    expect(invalidateKey.disabled).toBe(true)
    expect(invalidateKey.computedDisabled).toBe(true)
    expect(node.widgets?.at(-1)?.name).toBe("cached_invalidate_key")

    const genericInvalidateKey = widget("cached_invalidate_key")
    const genericNode: ComfyNode = {
      type: "unexpected.type",
      comfyClass: PROMPT_LIVE_CACHE_NODE_TYPE,
      widgets: [genericInvalidateKey],
      addDOMWidget: () => genericInvalidateKey,
      setDirtyCanvas: () => undefined,
    }
    extension?.nodeCreated?.(genericNode, app)

    expect(genericInvalidateKey.options?.read_only).toBe(true)
    expect(genericInvalidateKey.options?.disabled).toBe(true)
    expect(genericInvalidateKey.disabled).toBe(true)
    expect(genericInvalidateKey.computedDisabled).toBe(true)
  })
})
