/**
 * Prompt templates with {variable} placeholders.
 *   "A cinematic shot of {subject} in {location}, {lighting}"
 * Variable names: letters, digits, underscore; must start with a letter.
 * "{{" and "}}" produce literal braces.
 */

const TOKEN = /\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]{0,39})\}/g

export function templateVariables(body: string): string[] {
  const seen: string[] = []
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1]
    if (name && !seen.includes(name)) seen.push(name)
  }
  return seen
}

export interface RenderResult {
  text: string
  /** Variables without a value (left as "{name}" in the text). */
  missing: string[]
}

export function renderTemplate(body: string, values: Record<string, string>): RenderResult {
  const missing: string[] = []
  const text = body.replace(TOKEN, (token, name: string | undefined) => {
    if (token === "{{") return "{"
    if (token === "}}") return "}"
    const value = name ? values[name]?.trim() : undefined
    if (!value) {
      if (name && !missing.includes(name)) missing.push(name)
      return token
    }
    // Values are inserted literally; braces in values are not re-expanded.
    return value
  })
  return { text, missing }
}

export function isTemplate(body: string): boolean {
  return templateVariables(body).length > 0
}

/** Human label for a variable: "camera_movement" → "Camera movement". */
export function variableLabel(name: string): string {
  const spaced = name.replace(/_/g, " ").trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
