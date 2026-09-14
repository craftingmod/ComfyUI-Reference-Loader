import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

const harmlessLexicalWarning =
  "updateEditorSync: an editor update (e.g. a command listener that mutates the editor) ran while a read-only context was on the stack. This most commonly happens when a command is dispatched from inside editor.read(). The update has been deferred to a fresh writable update so it still applies, but dispatching mutations from a read-only context is an anti-pattern — dispatch after editor.read() returns, or via queueMicrotask."

if (Bun.env.CI_TEST_HIDE_LEXICAL_WARNING === "1") {
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === harmlessLexicalWarning) return
    warn(...args)
  }
}
