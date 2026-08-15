import { api } from "../../scripts/api.js"
import { app } from "../../scripts/app.js"
import { registerReferenceLoader } from "./reference-loader/extension.ts"
import { installStylesheet } from "./stylesheet.ts"

import "./reference-loader/styles/index.css"

installStylesheet()
registerReferenceLoader(app, api)
