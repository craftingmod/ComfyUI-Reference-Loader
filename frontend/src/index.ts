import { api } from "../../scripts/api.js"
import { app } from "../../scripts/app.js"
import { registerReferenceLoader } from "./reference-loader/extension.ts"
import { registerReferencePromptCache } from "./reference-loader/prompt-cache.ts"
import { installStylesheet } from "./stylesheet.ts"
import { installReferenceEditorHistoryGuard } from "./reference-loader/change-tracker-hook.ts"
import "./reference-loader/styles/index.css"

installReferenceEditorHistoryGuard()
installStylesheet()
registerReferenceLoader(app, api)
registerReferencePromptCache(app, api)
