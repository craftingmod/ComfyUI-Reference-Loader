export const STYLESHEET_ID = "reference-loader-stylesheet"
const STYLESHEET_VERSION = "11"

export function installStylesheet(moduleUrl: string = import.meta.url): HTMLLinkElement {
  const stylesheetUrl = new URL("./index.css", moduleUrl)
  stylesheetUrl.searchParams.set("v", STYLESHEET_VERSION)
  const existing = document.getElementById(STYLESHEET_ID)
  if (existing instanceof HTMLLinkElement) {
    if (existing.href !== stylesheetUrl.href) existing.href = stylesheetUrl.href
    return existing
  }

  const link = document.createElement("link")
  link.id = STYLESHEET_ID
  link.rel = "stylesheet"
  link.href = stylesheetUrl.href
  document.head.append(link)
  return link
}
