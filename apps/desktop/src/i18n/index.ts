import { useMemo } from "react"
import type { Language } from "@vidra/core"

import { useApp } from "@/lib/store"
import { en, type MessageKey } from "./en"
import { tr } from "./tr"

export type { MessageKey }
export const messages: Record<Language, Record<MessageKey, string>> = { en, tr }

export type Vars = Record<string, string | number>

export function translate(lang: Language, key: MessageKey, vars?: Vars): string {
  const template = messages[lang][key] ?? en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** First-run default: Turkish for tr* system languages, else English. */
export function detectLanguage(tag: string | null | undefined): Language {
  return tag && /^tr(-|_|$)/i.test(tag) ? "tr" : "en"
}

export function hasMessage(key: string): key is MessageKey {
  return key in en
}

export function currentLanguage(): Language {
  return useApp.getState().settings?.language ?? "en"
}

export function tNow(key: MessageKey, vars?: Vars): string {
  return translate(currentLanguage(), key, vars)
}

/** English workflow suffixes used in manifest display names ("Seedance 2.0 · Text to video"). */
const MODEL_SUFFIXES: Record<string, MessageKey> = {
  "Text to video": "workflow.text-to-video",
  "Image to video": "workflow.image-to-video",
  "Reference to video": "workflow.reference-to-video",
  "Video to video": "workflow.video-to-video",
  "Video edit": "workflow.video-edit",
  "Video extend": "workflow.video-extend",
  "Text to image": "workflow.text-to-image",
  "Image to image": "workflow.image-to-image",
  "Image edit": "workflow.image-edit",
  Edit: "workflow.image-edit",
}

/** Localizes the workflow suffix of a model display name; the model name itself is kept. */
export function localizeModelName(lang: Language, name: string): string {
  if (lang === "en") return name
  const at = name.lastIndexOf(" · ")
  const key = at < 0 ? undefined : MODEL_SUFFIXES[name.slice(at + 3)]
  return key ? `${name.slice(0, at)} · ${translate(lang, key)}` : name
}

export function makeI18n(lang: Language) {
  const locale = lang === "tr" ? "tr-TR" : "en-US"
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 })
  const dateF = new Intl.DateTimeFormat(locale, { dateStyle: "medium" })
  const dateTimeF = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
  const usdF = (digits: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits })
  const usd2 = usdF(2)
  const usd4 = usdF(4)
  const t = (key: MessageKey, vars?: Vars) => translate(lang, key, vars)
  return {
    lang,
    locale,
    t,
    has: hasMessage,
    /** Label from a manifest {en, tr} pair. */
    loc: (l: { en: string; tr: string } | undefined) => (l ? l[lang] || l.en : ""),
    /** Model display name with its workflow suffix in the UI language. */
    model: (name: string) => localizeModelName(lang, name),
    fmt: {
      num: (n: number) => num.format(n),
      pct: (n: number) => pct.format(n),
      usd: (n: number | null | undefined) => (n == null ? "—" : (Math.abs(n) > 0 && Math.abs(n) < 1 ? usd4 : usd2).format(n)),
      date: (ms: number) => dateF.format(ms),
      dateTime: (ms: number) => dateTimeF.format(ms),
      bytes: (n: number | null | undefined) => {
        if (n == null) return "—"
        const units = ["B", "KB", "MB", "GB", "TB"]
        let v = n
        let i = 0
        while (v >= 1024 && i < units.length - 1) {
          v /= 1024
          i++
        }
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`
      },
      duration: (sec: number | null | undefined) => {
        if (sec == null) return "—"
        const s = Math.round(sec)
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const r = String(s % 60).padStart(2, "0")
        return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`
      },
    },
  }
}

export type I18n = ReturnType<typeof makeI18n>

export function useI18n(): I18n {
  const lang = useApp((s) => s.settings?.language ?? "en")
  return useMemo(() => makeI18n(lang), [lang])
}
