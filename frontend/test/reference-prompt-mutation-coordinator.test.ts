import { describe, expect, test } from "bun:test"

import { PromptMutationCoordinator } from "../src/reference-loader/prompt-mutation-coordinator.ts"
import { PromptStore } from "../src/reference-loader/prompt-store.ts"
import {
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  serializePromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

function createCoordinator(document = createEmptyPromptDocumentV6()) {
  const store = new PromptStore(() => [], serializePromptDocumentV6(document))
  const transactions: string[] = []
  let dirty = 0
  const coordinator = new PromptMutationCoordinator(store, {
    runGraphChange(change) {
      transactions.push("before")
      try {
        change()
      } finally {
        transactions.push("after")
      }
    },
    markDirty() {
      dirty += 1
    },
    referenceFingerprint: () => "references",
  })
  return {
    coordinator,
    store,
    transactions,
    get dirty() {
      return dirty
    },
  }
}

describe("PromptMutationCoordinator", () => {
  test("opens one graph transaction for a normal graph mutation and none for a no-op", () => {
    const sceneId = createPromptDefinitionId()
    const cameraId = createPromptDefinitionId()
    const context = createCoordinator({
      ...createEmptyPromptDocumentV6(),
      sections: [
        { id: sceneId, title: "scene", parts: [] },
        { id: cameraId, title: "camera_direction", parts: [] },
      ],
    })

    expect(context.coordinator.reorderSection("scene", 1)).toMatchObject({
      accepted: true,
      changed: true,
    })
    expect(context.transactions).toEqual(["before", "after"])
    expect(context.dirty).toBe(1)
    expect(context.coordinator.reorderSection("scene", 1)).toMatchObject({
      accepted: true,
      changed: false,
    })
    expect(context.transactions).toEqual(["before", "after"])
    expect(context.dirty).toBe(1)
  })

  test("keeps stale body edits from changing the document or dirty state", () => {
    const sectionId = createPromptDefinitionId()
    const context = createCoordinator({
      ...createEmptyPromptDocumentV6(),
      sections: [{ id: sectionId, title: "scene", parts: [] }],
    })
    const snapshot = context.coordinator.getPromptBodySnapshot({ type: "section", id: sectionId })!

    expect(
      context.coordinator.applyPromptBodyEdit({
        target: snapshot.target,
        baseRevision: snapshot.revision,
        epoch: snapshot.epoch,
        parts: [{ type: "text", text: "accepted" }],
        editId: "edit-1",
        composing: false,
      }),
    ).toEqual({ ok: true, revision: 1, editId: "edit-1" })
    expect(
      context.coordinator.applyPromptBodyEdit({
        target: snapshot.target,
        baseRevision: snapshot.revision,
        epoch: snapshot.epoch,
        parts: [{ type: "text", text: "stale" }],
        editId: "edit-2",
        composing: false,
      }),
    ).toEqual({ ok: false, reason: "stale" })
    expect(context.store.document.sections[0]?.parts).toEqual([{ type: "text", text: "accepted" }])
    expect(context.dirty).toBe(1)
    expect(context.transactions).toEqual([])
  })

  test("keeps Shot draft changes outside graph state until Apply and supports Cancel", () => {
    const shotId = createPromptDefinitionId()
    const secondShotId = createPromptDefinitionId()
    const context = createCoordinator({
      ...createEmptyPromptDocumentV6(),
      shots: [
        { id: shotId, tag: "opening", frameIndex: 0, parts: [] },
        { id: secondShotId, tag: "middle", frameIndex: 0, parts: [] },
      ],
    })

    expect(context.coordinator.setShotFrameDraftByIdentity(secondShotId, 48).changed).toBe(true)
    expect(context.coordinator.setShotFrameDraftByIdentity(shotId, 24).changed).toBe(true)
    expect(context.store.document.shots.map((shot) => shot.frameIndex)).toEqual([0, 0])
    expect(context.coordinator.applyShotDraft().changed).toBe(true)
    expect(context.store.document.shots.map((shot) => shot.frameIndex)).toEqual([24, 48])
    expect(context.transactions).toEqual(["before", "after"])

    expect(context.coordinator.setShotFrameDraftByIdentity(secondShotId, 72).changed).toBe(true)
    expect(context.coordinator.cancelShotDraft().changed).toBe(true)
    expect(context.store.document.shots.map((shot) => shot.frameIndex)).toEqual([24, 48])
    expect(context.transactions).toEqual(["before", "after"])
  })

  test("preserves the definition reference failure without opening a transaction", () => {
    const subjectId = createPromptDefinitionId()
    const context = createCoordinator({
      ...createEmptyPromptDocumentV6(),
      subjects: [{ id: subjectId, tag: "hero", parts: [] }],
      sections: [
        {
          id: createPromptDefinitionId(),
          title: "scene",
          parts: [{ type: "definition-ref", definitionId: subjectId }],
        },
      ],
    })

    const result = context.coordinator.removeDefinition("subject", subjectId)
    expect(result).toMatchObject({ accepted: false, changed: false })
    expect(result.message).toContain("Definition is referenced")
    expect(context.store.document.subjects).toHaveLength(1)
    expect(context.transactions).toEqual([])
    expect(context.dirty).toBe(0)
  })
})
