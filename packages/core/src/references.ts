import type { ModelDefinition, ParameterSpec } from "./registry"
import type { ParamValues } from "./params"
import type { ReferenceType } from "./types"

/**
 * Visual references: how uploaded images are placed into a model's documented
 * inputs, which models can take a given set of references, and the prompt
 * guidance used for character consistency. Pure functions shared by the UI
 * and the tests; nothing here talks to a provider.
 */

export const REFERENCE_TYPES: readonly ReferenceType[] = ["character", "product", "style", "scene", "start_frame", "end_frame"]

export type MediaParam = Extract<ParameterSpec, { type: "media" }>

/** The minimum a reference needs to be placed. */
export interface ReferenceLike {
  id: string
  refType: ReferenceType
  url: string
  name: string
}

export type UnplacedReason = "no_slot" | "slot_full"

export interface ReferencePlan<R extends ReferenceLike = ReferenceLike> {
  /** Image-media parameter values implied by the references (empty slots omitted). */
  values: ParamValues
  /** Every image-media parameter key of the model, so stale values can be cleared. */
  imageKeys: string[]
  placed: Array<{ ref: R; paramKey: string; index: number }>
  unplaced: Array<{ ref: R; reason: UnplacedReason }>
}

const FRAME_ROLE: Partial<Record<ReferenceType, MediaParam["role"]>> = { start_frame: "start_frame", end_frame: "end_frame" }

export function imageSlots(model: ModelDefinition): MediaParam[] {
  return model.params.filter((p): p is MediaParam => p.type === "media" && p.mediaKind === "image")
}

/** Slots a reference of this type may go into, in priority order. */
function slotsFor(model: ModelDefinition, refType: ReferenceType): MediaParam[] {
  const frame = FRAME_ROLE[refType]
  return imageSlots(model).filter((s) => (frame ? s.role === frame : s.role === "reference"))
}

/**
 * Places references into the model's documented image inputs: frames go to
 * the start/end-frame inputs, everything else to the reference-image input,
 * in the user's order. A reference that has no input, or no room left, is
 * reported, never dropped silently.
 */
export function planReferences<R extends ReferenceLike>(model: ModelDefinition, refs: R[]): ReferencePlan<R> {
  const counts = new Map<string, string[]>()
  const placed: ReferencePlan<R>["placed"] = []
  const unplaced: ReferencePlan<R>["unplaced"] = []
  for (const ref of refs) {
    const slots = slotsFor(model, ref.refType)
    if (!slots.length) {
      unplaced.push({ ref, reason: "no_slot" })
      continue
    }
    const slot = slots.find((s) => (counts.get(s.key)?.length ?? 0) < s.maxItems)
    if (!slot) {
      unplaced.push({ ref, reason: "slot_full" })
      continue
    }
    const urls = counts.get(slot.key) ?? []
    urls.push(ref.url)
    counts.set(slot.key, urls)
    placed.push({ ref, paramKey: slot.key, index: urls.length - 1 })
  }
  const values: ParamValues = {}
  for (const slot of imageSlots(model)) {
    const urls = counts.get(slot.key) ?? []
    const first = urls[0]
    if (first === undefined) continue
    values[slot.key] = slot.shape === "url" && slot.maxItems === 1 ? first : urls
  }
  return { values, imageKeys: imageSlots(model).map((s) => s.key), placed, unplaced }
}

/** True when every reference fits this model. */
export function acceptsReferences(model: ModelDefinition, refs: ReferenceLike[]): boolean {
  return planReferences(model, refs).unplaced.length === 0
}

/**
 * Models that take every reference, best first: same provider and family as
 * the current model, then same provider, then the rest; longer maximum
 * duration wins ties. Used to offer a switch instead of discarding images.
 */
export function compatibleModels(models: ModelDefinition[], refs: ReferenceLike[], current: ModelDefinition | null): ModelDefinition[] {
  const score = (m: ModelDefinition) =>
    (current && m.provider === current.provider ? 2 : 0) + (current && m.family === current.family ? 1 : 0)
  return models
    .filter((m) => m.id !== current?.id && m.output === "video" && acceptsReferences(m, refs))
    .sort((a, b) => score(b) - score(a) || (b.capabilities.maxDurationSec ?? 0) - (a.capabilities.maxDurationSec ?? 0))
}

const ROLE_TEXT: Record<Exclude<ReferenceType, "start_frame" | "end_frame">, (n: number, name: string) => string> = {
  character: (n, name) =>
    `Reference image ${n} shows the character "${name}". Keep this character's identity exactly as shown: the same colors, proportions, facial structure and design. Do not redesign or restyle it.`,
  product: (n, name) => `Reference image ${n} shows the product "${name}". Keep its shape, colors, markings and proportions exactly as shown.`,
  style: (n, name) => `Match the visual style of reference image ${n} ("${name}"): its look, lighting, palette and rendering.`,
  scene: (n, name) => `Use reference image ${n} ("${name}") as the setting and environment of the scene.`,
}

/**
 * Prompt text that asks the model to preserve the supplied references. It is
 * appended to the user's prompt (prompts are documented inputs; there is no
 * separate "consistency" parameter at any provider), numbered in the order the
 * images are sent. Frames get no text: they are documented inputs already.
 */
export function consistencyGuidance(plan: ReferencePlan, preserveIdentity: boolean): string {
  if (!preserveIdentity) return ""
  const lines: string[] = []
  for (const { ref, index } of plan.placed) {
    if (ref.refType === "start_frame" || ref.refType === "end_frame") continue
    const text = ROLE_TEXT[ref.refType]
    lines.push(text(index + 1, ref.name.replace(/["\n\r]/g, " ").trim() || "reference"))
  }
  return lines.join(" ")
}

/** Final prompt with guidance; `fits` is false when it would exceed the model's limit. */
export function composePrompt(prompt: string, guidance: string, maxLength: number): { text: string; fits: boolean } {
  const base = prompt.trim()
  const text = guidance ? (base ? `${base}\n\n${guidance}` : guidance) : base
  return { text, fits: text.length <= maxLength }
}
