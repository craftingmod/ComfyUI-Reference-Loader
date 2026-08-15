import { api } from "../../scripts/api.js"
import { app } from "../../scripts/app.js"
import { registerReferenceLoader } from "./reference-loader/extension.ts"

import referenceLoaderCss from "./reference-loader/styles.css"

const STYLE_ID = "reference-loader-style"

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = referenceLoaderCss
  document.head.append(style)
}

installStyles()
registerReferenceLoader(app, api)
