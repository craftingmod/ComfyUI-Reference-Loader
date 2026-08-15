export const STYLESHEET_ID = "reference-loader-stylesheet"

export function installStylesheet(moduleUrl: string = import.meta.url): HTMLLinkElement {
  const existing = document.getElementById(STYLESHEET_ID)
  if (existing instanceof HTMLLinkElement) return existing

  const link = document.createElement("link")
  link.id = STYLESHEET_ID
  link.rel = "stylesheet"
  link.href = new URL("./index.css", moduleUrl).href
  document.head.append(link)
  return link
}
