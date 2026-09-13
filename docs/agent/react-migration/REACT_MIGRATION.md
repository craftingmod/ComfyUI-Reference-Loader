# React migration plan

## Current implementation status (2026-09-11)

The React migration now covers the ordinary Media surface and the H3
Guide/Timeline workspace. loader-react.tsx owns the toolbar, channels, cards,
captions, output controls, ordering, upload/drop surface, previews, and the
single-image panel. h3-workspace-react.tsx and h3-timeline-react.tsx own the
fixed shell, Timeline/List views, markers, End dock, Guide/Shot selection,
Inspector, recovery view, draft footer, keyboard actions, pointer gestures, and
Timeline Guide drag/drop.

ReferenceLoaderController remains the single owner of saved Loader state,
Guide and Shot drafts, validation, history, ComfyUI graph transactions,
asynchronous resources, native player/editor hosts, and typed callbacks.
h3-timeline.ts is now a pure projection/math module. The old H3 markup mount,
imperative H3Timeline, card overlay, and footer portal path were removed.

The same React root is used for GUIDE-free state, enabled or disabled H3 state,
incomplete Guides, and workflow/Snapshot restore. Video-derived Audio and Video
remain ineligible Guide sources. The H3 wrapper/conditioning boundary remains
outside this UI migration.

Automated frontend tests, typecheck, build, and backend tests are the evidence
for the current implementation. A live ComfyUI check of Nodes 2.0 and Legacy
Canvas layout, resizing, focus, upload/drop, playback, queue, restore, and node
removal remains required before calling the migration fully verified.

## Decision

Move the Reference Loader's declarative UI to React while keeping the existing
Loader state model, reducer, validation, serialization, history, API, native
player/editor hosts, and ComfyUI lifecycle boundaries. H3 Guide behavior is
included in this implementation because it now has a typed Controller adapter
and a permanent React workspace; it is not a second saved-state store.

## Guide boundary

During the current React migration:

- Render Guide badges, G toggles, Guide-pencil controls, Timeline lanes,
  List view, Inspector editing, and incomplete-Guide recovery through the
  permanent H3 workspace.
- Keep Media Guide eligibility, paired visual/audio semantics, Start/End rules,
  frame validation, and Apply/Cancel/Undo in the Controller and existing
  h3-media-guides.ts/reducer contracts.
- Keep Shot text timing owned by Prompt. The H3 workspace only projects,
  selects, and delegates Shot changes through the existing Prompt callbacks.
- Keep native MiniMax H3 execution and checkpoint/runtime validation outside the
  frontend migration. UI tests do not prove native H3 generation.
- Keep the same React root across normal updates and restore. Do not recreate
  the root or replace React-owned descendants from Controller code.

## State ownership

There must be one saved-state owner:

- `LoaderState`, reducer actions, validation, serialization, and history stay
  outside React.
- React receives a derived `LoaderViewModel` and dispatches typed Loader
  actions through a narrow adapter.
- React may own transient UI state such as expanded menus, focus hints, and
  local dialog state.
- React must not create a second saved Loader store.
- Uploads, previews, waveforms, ComfyUI node lifecycle, and contenteditable
  caret/selection remain external or native interaction state.

The migrated root must be mounted once. A normal state update must not delete
the React root with `innerHTML` and recreate it. Native Timeline, Prompt, and
media-player surfaces can remain explicit host elements under the React tree.

## Migration scope

### First React slice: ordinary Media UI

Convert the following together as one testable vertical slice:

- Loader toolbar and status;
- Image, Video, and Audio channel shells;
- Media cards, filenames, badges, captions, and disabled states;
- ordinary `I`, `V`, `VA`, and `A` output controls;
- channel-local ordering controls;
- upload/drop targets and pending upload display;
- preview controls and runtime loading/error display;
- Snapshot menu and ordinary Clear/Undo/Redo actions;
- the existing image/audio/video editor launch boundary.

The image/trim editors themselves may remain native dialogs initially. React
should own their launch buttons and host boundaries before their internal DOM
is considered for migration.

### Keep native initially

- Timeline interaction and any non-Guide Shot lane;
- Prompt contenteditable, caret, chip, autocomplete, and composition handling;
- audio/video playback elements and waveform drawing;
- image/trim dialog internals;
- ComfyUI DOM-widget and graph lifecycle integration.

These are native islands, not failed React migrations. Their state must be
exposed through explicit host callbacks rather than accidental DOM queries.

### Later Guide restoration

Guide restoration is a separate phase. It must first define whether the Guide
draft is owned by a dedicated React reducer or remains a Controller draft. It
must not reuse the current mixed `useState` plus Controller mutation path as a
final architecture.

The restoration phase covers Guide cards, placement editing, paired-source
behavior, Timeline Guide interactions, incomplete recovery, serialization
round-trip, and native H3 conditioning verification as separate acceptance
boundaries.

## Component and adapter boundary

Use a small tree with narrow models rather than passing the complete Loader
state to every leaf:

```text
ReferenceLoaderReactRoot
├── LoaderToolbar
├── H3SummaryWithoutGuides
├── MediaChannel
│   └── MediaCard
├── NativeEditorHosts
└── NativePromptOrTimelineHosts
```

The root may receive the complete view snapshot and action adapter. A channel
receives channel data; a card receives one card view model and the actions it
needs. View-model derivation belongs outside leaf components. Do not add a
global state library until this boundary has failed under tests.

## Work sequence

1. Freeze the current Loader/reducer/serialization contracts and record the
   Guide-disabled behavior.
2. Extract the ordinary Media view model and typed action adapter without
   changing saved state or backend contracts.
3. Mount one permanent React root and place native interaction hosts inside
   it.
4. Move Toolbar, channels, and Media cards as a single ordinary-Media slice.
5. Move ordinary event handling from delegated DOM selectors to component
   actions. Keep native listeners only inside native hosts.
6. Preserve and expand integration tests before moving another surface.
7. Move Prompt and editor shells only after ordinary Media rerender, focus,
   upload, preview, and restore behavior is stable.
8. Restore Guide in a separately planned phase.

Do not combine this migration with Tailwind adoption, JS chunk splitting, or a
new external state-management library. Those are independent decisions and
would make failures harder to attribute.

## Acceptance tests for the first slice

The first slice is complete only when the full Controller-to-UI path passes for
Guide-free state:

- initial state renders all three channels;
- upload, remove, reorder, caption, and ordinary output toggles update the
  canonical Loader state;
- previews, pending uploads, loading, and errors survive unrelated rerenders;
- image/video/audio edit dialogs open from React and return through the
  existing Controller transaction boundary;
- Snapshot save/load, workflow restore, Clear, Undo, and Redo preserve the
  same serialized state;
- two Loader instances have independent React roots and actions;
- destroying a node removes the React root and all native host listeners;
- ordinary actions preserve an existing untouched `h3Timeline` value;
- Guide controls are absent or explicitly unavailable, and no Guide action is
  silently executed.

Run automated tests separately from live ComfyUI verification. The first live
check covers ordinary Media behavior only; Guide behavior remains an
explicitly deferred and broken boundary until its restoration phase.

## Next scope

Prompt/editor shell conversion and full Guide restoration are separate follow-up
work. Guide restoration must cover the draft owner, paired sources, Timeline
interaction, incomplete recovery, serialization round-trip, and native H3
conditioning verification before the legacy boundary is removed.

## CSS boundary

Keep the existing `.rl-*` stylesheet and component CSS during the first React
slice. Do not migrate CSS to Tailwind at the same time. After React component
boundaries and state ownership are stable, Tailwind can be evaluated only for
new React surfaces, with ComfyUI global-style isolation and existing CSS
compatibility tested separately.
