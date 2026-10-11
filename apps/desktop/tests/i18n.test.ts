import { describe, expect, it } from "vitest"

import { en } from "@/i18n/en"
import { tr } from "@/i18n/tr"
import { translate } from "@/i18n"

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("i18n", () => {
  it("has exactly the same keys in English and Turkish", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort())
  })

  it("has no empty strings and keeps the same placeholders", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].trim(), key).not.toBe("")
      expect(tr[key].trim(), key).not.toBe("")
      expect(placeholders(tr[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it("interpolates variables", () => {
    expect(translate("en", "archive.selected", { count: 3 })).toBe("3 selected")
    expect(translate("tr", "archive.selected", { count: 3 })).toBe("3 seçili")
  })
})
