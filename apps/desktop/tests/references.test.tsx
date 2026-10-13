import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FIXTURE_IDS } from "@/lib/mock-fixtures"
import { renderApp } from "./helpers"

const tiles = () => screen.getAllByTestId("refs-tile")

describe("visual references", () => {
  it("saves an uploaded image to the library and reuses it without uploading again by hand", async () => {
    const { user } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.motion } })
    await user.click(await screen.findByTestId("refs-add"))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-status", "ready"))
    expect(tiles()[0]).toHaveAttribute("data-placed", "true")

    const name = within(tiles()[0]!).getByTestId("refs-name")
    await user.clear(name)
    await user.type(name, "Zihin mascot")
    await user.click(within(tiles()[0]!).getByTestId("refs-save"))
    expect(await within(tiles()[0]!).findByText("Saved")).toBeInTheDocument()

    await user.click(within(tiles()[0]!).getByTestId("refs-remove"))
    expect(screen.queryByTestId("refs-tile")).toBeNull()

    await user.click(screen.getByTestId("refs-library"))
    const item = (await screen.findAllByTestId("refs-library-item")).find((el) => el.textContent?.includes("Zihin mascot"))!
    expect(item).toBeTruthy()
    await user.click(within(item).getByTestId("refs-library-use"))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-status", "ready"))
    expect(within(tiles()[0]!).getByText("Saved")).toBeInTheDocument()
    expect(within(tiles()[0]!).getByTestId("refs-name")).toHaveValue("Zihin mascot")
    expect(tiles()[0]).toHaveAttribute("data-placed", "true")
  })

  it("warns when the model has no reference input and offers a compatible model instead of dropping the image", async () => {
    const { user } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.cinema } })
    await user.click(await screen.findByTestId("refs-add"))
    const warning = await screen.findByTestId("refs-unsupported")
    expect(warning).toHaveTextContent("this model has no such input")
    expect(warning).toHaveTextContent("The images were kept")
    await user.click(within(warning).getByTestId(`refs-switch-${FIXTURE_IDS.motion}`))
    await waitFor(() => expect(screen.getByTestId("model-picker")).toHaveTextContent("Demo Motion"))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-placed", "true"))
    expect(screen.queryByTestId("refs-unsupported")).toBeNull()
  })

  it("sends the references, their types and the consistency guidance with the request", async () => {
    const { user, backend } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.motion } })
    await user.click(await screen.findByTestId("refs-add"))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-status", "ready"))
    const name = within(tiles()[0]!).getByTestId("refs-name")
    await user.clear(name)
    await user.type(name, "Zihin")
    expect(screen.getByTestId("refs-guidance")).toHaveTextContent('Reference image 1 shows the character "Zihin"')

    await user.type(screen.getByTestId("prompt-input"), "A 28-second cinematic ad")
    await user.click(screen.getByTestId("generate-button"))
    const dialog = await screen.findByTestId("confirm-generate")
    const ack = within(dialog).queryByTestId("cost-ack")
    if (ack) await user.click(within(ack).getByRole("checkbox"))
    await user.click(within(dialog).getByTestId("confirm-generate-button"))
    await waitFor(() => expect(backend.mock!.control.jobs()).toHaveLength(1))
    const job = backend.mock!.control.jobs()[0]!
    expect(job.references).toEqual([expect.objectContaining({ paramKey: "reference_images", refType: "character", name: "Zihin" })])
    expect(job.preserveIdentity).toBe(true)
    expect(job.prompt).toContain('Reference image 1 shows the character "Zihin"')
    expect(job.prompt.startsWith("A 28-second cinematic ad")).toBe(true)
    expect(job.params.reference_images).toEqual([job.references[0]!.url])

    // Turning consistency off removes the guidance; the images are still sent.
    await user.click(screen.getByTestId("refs-consistency"))
    await waitFor(() => expect(screen.queryByTestId("refs-guidance")).toBeNull())
  })

  it("maps first/last frame references to the start and end frame inputs", async () => {
    const { user } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.motion } })
    await user.click(await screen.findByTestId("refs-add"))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-status", "ready"))
    await user.click(within(tiles()[0]!).getByTestId("refs-type"))
    await user.click(await screen.findByRole("option", { name: "First frame" }))
    await waitFor(() => expect(tiles()[0]).toHaveAttribute("data-ref-type", "start_frame"))
    expect(tiles()[0]).toHaveAttribute("data-placed", "true")
    // Demo Motion has one start-frame input: a second first frame does not fit.
    await user.click(screen.getByTestId("refs-add"))
    await waitFor(() => expect(tiles()).toHaveLength(2))
    await user.click(within(tiles()[1]!).getByTestId("refs-type"))
    await user.click(await screen.findByRole("option", { name: "First frame" }))
    expect(await screen.findByTestId("refs-unsupported")).toHaveTextContent("no room left")
  })
})
