import { useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import type { ModelDefinition, ParamValues } from "@vidra/core"

import { addReference, DynamicForm, type MediaSpec } from "@/components/studio/dynamic-form"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FIXTURE_IDS, FIXTURE_MODELS } from "@/lib/mock-fixtures"
import { carryWithChanges } from "@/lib/model-switch"
import { useApp } from "@/lib/store"

const model = (id: string) => FIXTURE_MODELS.find((m) => m.id === id) as ModelDefinition

function Harness({ m, initial }: { m: ModelDefinition; initial: ParamValues }) {
  const [values, setValues] = useState(initial)
  return (
    <TooltipProvider>
      <DynamicForm model={m} values={values} onChange={setValues} references={{}} onPickReference={async () => undefined} />
      <output data-testid="values">{JSON.stringify(values)}</output>
    </TooltipProvider>
  )
}

function setLanguage(language: "en" | "tr") {
  useApp.setState({
    settings: {
      language,
      onboardingCompleted: true,
      autoSave: true,
      downloadConcurrency: 2,
      trashRetentionDays: 30,
      budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: true },
      archiveRoot: "C:\\Archive",
      exportDir: null,
      catalogAutoSync: true,
    },
  })
}

const durationField = () => document.querySelector('[data-param-key="duration"]') as HTMLElement

describe("v2 dynamic form", () => {
  beforeEach(() => setLanguage("en"))

  it("offers 15 and 30 second durations when the model allows them, with an Auto label", () => {
    render(<Harness m={model(FIXTURE_IDS.cinema)} initial={{ duration: 5, resolution: "720p" }} />)
    const field = within(durationField())
    expect(field.getByRole("radio", { name: "15 s" })).toBeEnabled()
    expect(field.getByRole("radio", { name: "30 s" })).toBeEnabled()
    expect(field.getByRole("radio", { name: "Auto" })).toBeEnabled()
  })

  it("shows the Turkish value label and unit", () => {
    setLanguage("tr")
    render(<Harness m={model(FIXTURE_IDS.cinema)} initial={{ duration: 5 }} />)
    const field = within(durationField())
    expect(field.getByRole("radio", { name: "Otomatik" })).toBeInTheDocument()
    expect(field.getByRole("radio", { name: "30 sn" })).toBeInTheDocument()
  })

  it("uses a select for long discrete duration lists", () => {
    render(<Harness m={model(FIXTURE_IDS.motion)} initial={{ duration: 5 }} />)
    const field = within(durationField())
    expect(field.getByRole("combobox", { name: "Duration" })).toBeInTheDocument()
    expect(field.queryByRole("radio")).toBeNull()
  })

  it("does not offer durations the model does not support", () => {
    render(<Harness m={model(FIXTURE_IDS.units)} initial={{ duration: 5 }} />)
    const field = within(durationField())
    expect(field.getAllByRole("radio").map((r) => r.textContent)).toEqual(["5 s", "10 s"])
    expect(field.queryByRole("radio", { name: "15 s" })).toBeNull()
    expect(field.queryByRole("radio", { name: "30 s" })).toBeNull()
  })

  it("disables durations above a resolution-dependent limit and explains why", () => {
    render(<Harness m={model(FIXTURE_IDS.cinema)} initial={{ duration: 5, resolution: "4k" }} />)
    const field = within(durationField())
    expect(field.getByRole("radio", { name: "15 s" })).toBeDisabled()
    expect(field.getByRole("radio", { name: "30 s" })).toBeDisabled()
    expect(field.getByRole("radio", { name: "10 s" })).toBeEnabled()
    expect(field.getByRole("radio", { name: "30 s" })).toHaveAttribute("title", "Unavailable: 4K is limited to 10 seconds.")
    expect(field.getByText("Unavailable: 4K is limited to 10 seconds.")).toBeInTheDocument()
  })

  it("explains disabled options in Turkish", () => {
    setLanguage("tr")
    render(<Harness m={model(FIXTURE_IDS.cinema)} initial={{ duration: 30, resolution: "720p" }} />)
    const res = within(document.querySelector('[data-param-key="resolution"]') as HTMLElement)
    expect(res.getByRole("radio", { name: "4k" })).toBeDisabled()
    expect(res.getByText("Kullanılamaz: 4K en fazla 10 saniye olabilir.")).toBeInTheDocument()
  })

  it("shows conditional rule messages inline", () => {
    render(
      <Harness
        m={model(FIXTURE_IDS.motion)}
        initial={{ duration: 5, image: "https://cdn.example.com/a.png", reference_images: ["https://cdn.example.com/b.png"] }}
      />
    )
    expect(screen.getAllByText("Use either a start frame or references.").length).toBeGreaterThan(0)
  })

  it("accepts reference images up to the maximum and rejects more", () => {
    const m = model(FIXTURE_IDS.motion)
    const spec = m.params.find((p) => p.key === "reference_images") as MediaSpec
    let values: ParamValues = {}
    for (let i = 0; i < 4; i++) values = addReference(values, spec, `https://cdn.example.com/${i}.png`)!
    expect(values.reference_images).toHaveLength(4)
    expect(addReference(values, spec, "https://cdn.example.com/5.png")).toBeNull()
    render(<Harness m={m} initial={values} />)
    expect(screen.getByTestId("count-reference_images")).toHaveTextContent("4/4")
    expect(screen.queryByTestId("add-reference_images")).toBeNull()
    expect(screen.getByTestId("limits-reference_images")).toHaveTextContent("Up to 4 files · Formats: JPG, PNG, WEBP · max 10 MB each")
  })

  it("flags an image dimension that is not on the documented step", () => {
    render(<Harness m={model(FIXTURE_IDS.still)} initial={{ width: 1024, height: 1024 }} />)
    const width = within(document.querySelector('[data-param-key="width"]') as HTMLElement).getByRole("spinbutton")
    fireEvent.change(width, { target: { value: "1000" } })
    expect(screen.getByText("Width: must be in steps of 64.")).toBeInTheDocument()
  })

  it("reports a clamped duration when switching models instead of silently downgrading", () => {
    const { values, changes } = carryWithChanges({ duration: 30, resolution: "720p" }, model(FIXTURE_IDS.cinema), model(FIXTURE_IDS.units))
    expect(String(values.duration)).toBe("10")
    expect(changes).toEqual([expect.objectContaining({ key: "duration", kind: "clamped", from: 30, max: 10 })])
  })

  it("clamps a carried value that breaks a conditional limit", () => {
    const { values, changes } = carryWithChanges({ duration: 30, resolution: "4k" }, model(FIXTURE_IDS.motion), model(FIXTURE_IDS.cinema))
    expect(values.duration).toBe(10)
    expect(changes[0]).toEqual(expect.objectContaining({ key: "duration", kind: "clamped", max: 10 }))
    expect(changes[0]!.reason?.en).toBe("4K is limited to 10 seconds.")
  })
})
