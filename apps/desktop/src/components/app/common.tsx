import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react"
import { Check, Copy, ExternalLink, TriangleAlert } from "lucide-react"
import type { ArchiveState, JobStatus } from "@vidra/core"

import mark from "@/assets/vidra-mark.svg"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/backend"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { tNow, useI18n } from "@/i18n"
import { cn } from "@/lib/utils"

export function Mark({ className }: { className?: string }) {
  return <img src={mark} alt="" aria-hidden className={cn("size-7 rounded-md", className)} draggable={false} />
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Section({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          {title && <h2 className="text-sm font-medium">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center", className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-6">{icon}</div>}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-white/[0.04]", className)} />
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label={tNow("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

const STATE_TONE: Record<ArchiveState, string> = {
  generation_queued: "text-muted-foreground",
  generating: "text-info",
  generation_failed: "text-destructive",
  download_pending: "text-muted-foreground",
  downloading: "text-info",
  saved: "text-success",
  download_failed: "text-destructive",
  missing: "text-warning",
  trashed: "text-muted-foreground",
}

export function StateBadge({ state, className }: { state: ArchiveState; className?: string }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-black/60 px-2 py-0.5 text-[11px] font-medium backdrop-blur",
        STATE_TONE[state],
        className
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t(`state.${state}`)}
    </span>
  )
}

const JOB_TONE: Record<JobStatus, string> = {
  submitting: "text-muted-foreground",
  queued: "text-muted-foreground",
  generating: "text-info",
  completed: "text-success",
  failed: "text-destructive",
  canceled: "text-muted-foreground",
  blocked: "text-warning",
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const { t } = useI18n()
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", JOB_TONE[status])}>
      <span
        className={cn("size-1.5 rounded-full bg-current", (status === "generating" || status === "queued") && "animate-pulse")}
        aria-hidden
      />
      {t(`job.${status}`)}
    </span>
  )
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(timer)
  }, [done])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label ?? t("common.copy")}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setDone(true), () => undefined)
          }}
        >
          {done ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? t("common.copied") : (label ?? t("common.copy"))}</TooltipContent>
    </Tooltip>
  )
}

/** External URLs are shown and copyable; the renderer has no opener permission. */
export function UrlField({ url }: { url: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border bg-black/30 py-0.5 pr-0.5 pl-2">
      <span className="truncate font-mono text-xs text-muted-foreground" title={url}>
        {url}
      </span>
      <CopyButton value={url} />
      <OpenLinkButton url={url} />
    </div>
  )
}

/** Opens official docs/project links via the native allowlisted command. */
function OpenLinkButton({ url }: { url: string }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={t("common.openLink")}
      title={failed ? t("common.openLinkFailed") : t("common.openLink")}
      onClick={() => {
        setFailed(false)
        api.openExternalUrl(url).catch(() => setFailed(true))
      }}
    >
      <ExternalLink className={failed ? "size-3.5 text-destructive" : "size-3.5"} />
    </Button>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(destructive && "bg-destructive text-white hover:bg-destructive/90")}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Small dialog asking for one text value (names, titles). */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initial = "",
  confirmLabel,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  label: string
  initial?: string
  confirmLabel: string
  onSubmit: (value: string) => Promise<boolean | void> | boolean | void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setValue(initial)
  }, [open, initial])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (!value.trim()) return
            setBusy(true)
            const ok = await onSubmit(value.trim())
            setBusy(false)
            if (ok !== false) onOpenChange(false)
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{label}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="name-dialog-input">{label}</Label>
            <Input id="name-dialog-input" autoFocus value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen crashed", error, info.componentStack)
  }
  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="m-8 flex flex-col items-start gap-3 rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="size-4 text-warning" />
          {tNow("error.screenTitle")}
        </div>
        <p className="text-sm text-muted-foreground">{tNow("error.screenBody")}</p>
        <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
          {tNow("common.tryAgain")}
        </Button>
      </div>
    )
  }
}

export function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
