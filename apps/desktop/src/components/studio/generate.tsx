import { useCallback, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { ShieldAlert, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import type { GenerationJob, Id } from "@vidra/core"

import { needsCostAck, PriceDisplay } from "@/components/app/price"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { useI18n, type I18n } from "@/i18n"
import { api } from "@/lib/backend"
import { toastError } from "@/lib/errors"
import { IpcError, type Estimate, type GenerationInput } from "@/lib/ipc"
import { useApp } from "@/lib/store"

interface Meta {
  promptId: Id | null
  projectId: Id | null
  modelName: string
}

type DialogState =
  | { kind: "none" }
  | { kind: "confirm"; input: GenerationInput; meta: Meta; estimate: Estimate | null; changed: boolean; requireAck: boolean }
  | { kind: "blocked"; estimate: Estimate | null; exceeded: string[] }
  | { kind: "uncertain"; message: string }

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

export function estimateSourceLabel(i18n: I18n, source: Estimate["source"] | GenerationJob["estimateSource"]): string {
  if (source === "provider") return i18n.t("estimate.source.provider")
  if (source === "published_rate") return i18n.t("estimate.source.published")
  return i18n.t("estimate.source.unknown")
}

/**
 * Generation submit flow shared by the studios and retries: optional
 * confirmation, fresh idempotency key per attempt, and handling of
 * confirmation_required / budget_exceeded / submit_uncertain.
 */
export function useGenerator(onSubmitted?: (job: GenerationJob) => void) {
  const i18n = useI18n()
  const { t, model: mn } = i18n
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" })
  const [acked, setAcked] = useState(false)
  const openConfirm = (input: GenerationInput, meta: Meta, est: Estimate | null, changed: boolean, forceAck = false) => {
    setAcked(false)
    setDialog({ kind: "confirm", input, meta, estimate: est, changed, requireAck: forceAck || needsCostAck(est) })
  }
  const submittedRef = useRef(onSubmitted)
  submittedRef.current = onSubmitted

  const estimate = (input: GenerationInput) => api.estimateGeneration(input).catch(() => null)

  const submit = useCallback(
    async (input: GenerationInput, meta: Meta, confirmedUsd: number | null, acknowledgeUnknownCost: boolean) => {
      setBusy(true)
      try {
        const job = await api.submitGeneration(input, {
          idempotencyKey: newIdempotencyKey(),
          confirmedEstimateUsd: confirmedUsd,
          acknowledgeUnknownCost,
          promptId: meta.promptId,
          projectId: meta.projectId,
        })
        setDialog({ kind: "none" })
        toast.success(t("generate.submitted"), { description: mn(meta.modelName) })
        submittedRef.current?.(job)
      } catch (error) {
        if (error instanceof IpcError && error.code === "confirmation_required") {
          openConfirm(input, meta, await estimate(input), true)
        } else if (error instanceof IpcError && error.code === "unknown_cost_ack_required") {
          openConfirm(input, meta, await estimate(input), false, true)
        } else if (error instanceof IpcError && error.code === "budget_exceeded") {
          const exceeded = Array.isArray(error.details?.exceeded) ? (error.details.exceeded as string[]) : []
          setDialog({ kind: "blocked", estimate: await estimate(input), exceeded })
        } else if (error instanceof IpcError && error.code === "submit_uncertain") {
          setDialog({ kind: "uncertain", message: error.message })
        } else {
          setDialog({ kind: "none" })
          toastError(error)
        }
      } finally {
        setBusy(false)
      }
    },
    [t, mn]
  )

  const generate = useCallback(
    async (input: GenerationInput, meta: Meta) => {
      const settings = useApp.getState().settings
      setBusy(true)
      const est = await estimate(input)
      setBusy(false)
      if (est && !est.budget.allowed) {
        setDialog({ kind: "blocked", estimate: est, exceeded: est.budget.exceeded })
        return
      }
      if (settings?.budget.confirmBeforeGenerate || needsCostAck(est)) {
        openConfirm(input, meta, est, false)
        return
      }
      await submit(input, meta, est?.usd ?? null, false)
    },
    [submit]
  )

  const close = () => setDialog({ kind: "none" })

  const dialogs: ReactNode = (
    <>
      <Dialog open={dialog.kind === "confirm"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md" data-testid="confirm-generate">
          {dialog.kind === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("generate.confirmTitle")}</DialogTitle>
                <DialogDescription>{mn(dialog.meta.modelName)}</DialogDescription>
              </DialogHeader>
              {dialog.changed && (
                <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/[0.06] p-2.5 text-xs text-warning" role="alert">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {t("generate.estimateChanged")}
                </p>
              )}
              <EstimateSummary estimate={dialog.estimate} />
              {dialog.requireAck && (
                <label className="flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning/[0.05] p-2.5 text-xs leading-relaxed" data-testid="cost-ack">
                  <Checkbox checked={acked} onCheckedChange={(c) => setAcked(c === true)} className="mt-0.5" aria-describedby="cost-ack-hint" />
                  <span>
                    {dialog.estimate?.status === "estimated" && dialog.estimate.currency === "credits"
                      ? t("price.ackCredits", { unit: dialog.estimate.unitName ?? "" })
                      : t("price.ack")}
                    {!acked && (
                      <span id="cost-ack-hint" className="mt-1 block text-muted-foreground">
                        {t("price.ackRequired")}
                      </span>
                    )}
                  </span>
                </label>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">{t("budget.disclaimer")}</p>
              <DialogFooter>
                <Button variant="ghost" onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={busy || (dialog.requireAck && !acked)}
                  onClick={() => void submit(dialog.input, dialog.meta, dialog.estimate?.usd ?? null, dialog.requireAck && acked)}
                  data-testid="confirm-generate-button"
                >
                  {t("generate.confirmAndGenerate")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog.kind === "blocked"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          {dialog.kind === "blocked" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-destructive" />
                  {t("generate.blockedTitle")}
                </DialogTitle>
                <DialogDescription>
                  {dialog.exceeded.includes("daily") && dialog.exceeded.includes("monthly")
                    ? t("generate.blockedBoth")
                    : dialog.exceeded.includes("daily")
                      ? t("generate.blockedDaily")
                      : t("generate.blockedMonthly")}
                </DialogDescription>
              </DialogHeader>
              <EstimateSummary estimate={dialog.estimate} />
              <DialogFooter>
                <Button variant="ghost" onClick={close}>
                  {t("common.close")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    close()
                    void navigate("/analytics#budget")
                  }}
                >
                  {t("generate.reviewBudget")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog.kind === "uncertain"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          {dialog.kind === "uncertain" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <TriangleAlert className="size-4 text-warning" />
                  {t("generate.uncertainTitle")}
                </DialogTitle>
                <DialogDescription>{t("generate.uncertainBody")}</DialogDescription>
              </DialogHeader>
              <p className="rounded-md border bg-black/30 p-2.5 text-xs text-muted-foreground">{dialog.message}</p>
              <DialogFooter>
                <Button onClick={close}>{t("common.understood")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )

  return { generate, busy, dialogs }
}

export function EstimateSummary({ estimate }: { estimate: Estimate | null }) {
  const { t } = useI18n()
  const budget = useApp((s) => s.settings?.budget)
  return (
    <div className="space-y-3 rounded-lg border bg-black/30 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="text-muted-foreground">{t("estimate.label")}</span>
        <div className="text-right" data-testid="estimate-usd">
          <PriceDisplay estimate={estimate} failed={!estimate} />
        </div>
      </div>
      {estimate && budget && (
        <>
          <BudgetMeter label={t("budget.today")} spent={estimate.budget.dailySpentUsd} add={estimate.usd} limit={budget.dailyLimitUsd} />
          <BudgetMeter label={t("budget.thisMonth")} spent={estimate.budget.monthlySpentUsd} add={estimate.usd} limit={budget.monthlyLimitUsd} />
          {estimate.budget.incomplete && <p className="text-[11px] text-muted-foreground">{t("budget.incomplete")}</p>}
        </>
      )}
    </div>
  )
}

function BudgetMeter({ label, spent, add, limit }: { label: string; spent: number; add: number | null; limit: number | null }) {
  const { t, fmt } = useI18n()
  const projected = spent + (add ?? 0)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {limit == null
            ? t("budget.spentNoLimit", { spent: fmt.usd(spent) })
            : t("budget.projectedOfLimit", { projected: fmt.usd(projected), limit: fmt.usd(limit) })}
        </span>
      </div>
      {limit != null && limit > 0 && (
        <Progress value={Math.min(100, (projected / limit) * 100)} className="h-1" aria-label={label} />
      )}
    </div>
  )
}
