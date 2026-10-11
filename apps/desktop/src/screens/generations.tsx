import { useState } from "react"
import { useNavigate } from "react-router"
import { FolderOpen, ListChecks, RotateCcw, Trash2, X } from "lucide-react"
import { TERMINAL_JOB_STATUSES, type GenerationJob, type JobStatus } from "@vidra/core"

import { ConfirmDialog, EmptyState, JobStatusBadge, LoadingRows, PageHeader } from "@/components/app/common"
import { useGenerator } from "@/components/studio/generate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLive } from "@/hooks/use-live"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt, jobErrorText } from "@/lib/errors"
import { useApp } from "@/lib/store"

const STATUSES: JobStatus[] = ["submitting", "queued", "generating", "completed", "failed", "canceled", "blocked"]

export function GenerationsScreen() {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const navigate = useNavigate()
  const providers = useApp((s) => s.providers)
  const models = useApp((s) => s.models)
  const jobs = useLive(() => api.listJobs(), "jobs", ["jobs-changed"])
  const [status, setStatus] = useState<JobStatus | "all">("all")
  const [search, setSearch] = useState("")
  const [removing, setRemoving] = useState<GenerationJob | null>(null)
  const { generate, dialogs } = useGenerator()

  const list = (jobs.data ?? []).filter(
    (j) =>
      (status === "all" || j.status === status) &&
      (!search.trim() || `${j.prompt} ${j.modelName}`.toLowerCase().includes(search.trim().toLowerCase()))
  )

  const retry = (job: GenerationJob) => {
    const model = models.find((m) => m.id === job.modelId)
    void generate(
      { modelId: job.modelId, prompt: job.prompt, negativePrompt: job.negativePrompt, params: job.params },
      { promptId: job.promptId, projectId: job.projectId, modelName: model?.displayName ?? job.modelName }
    )
  }

  return (
    <>
      <PageHeader title={t("nav.generations")} description={t("generations.subtitle")} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          data-page-search
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("generations.search")}
          aria-label={t("generations.search")}
          className="h-8 w-64"
        />
        <Select value={status} onValueChange={(v) => setStatus(v as JobStatus | "all")}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("archive.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("generations.allStatuses")}</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`job.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {jobs.loading && !jobs.data ? (
        <LoadingRows rows={6} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ListChecks />}
          title={t("generations.empty")}
          description={t("generations.emptyBody")}
          action={
            <Button size="sm" onClick={() => void navigate("/video")}>
              {t("palette.newVideo")}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm" data-testid="jobs-table">
            <thead className="bg-card text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t("archive.status")}</th>
                <th className="px-4 py-2.5 font-medium">{t("models.model")}</th>
                <th className="px-4 py-2.5 font-medium">{t("studio.prompt")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("estimate.label")}</th>
                <th className="px-4 py-2.5 font-medium">{t("archive.created")}</th>
                <th className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((job) => {
                const p = providers.find((x) => x.id === job.provider)
                const terminal = TERMINAL_JOB_STATUSES.includes(job.status)
                return (
                  <tr key={job.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <JobStatusBadge status={job.status} />
                      {(job.errorCode || job.errorMessage) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="mt-0.5 max-w-48 truncate text-[11px] text-destructive">{jobErrorText(i18n, job)}</p>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">{jobErrorText(i18n, job)}</TooltipContent>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{job.modelName}</div>
                      <div className="text-xs text-muted-foreground">{p?.displayName ?? job.provider}</div>
                    </td>
                    <td className="max-w-80 px-4 py-2.5">
                      <p className="truncate text-muted-foreground" title={job.prompt}>
                        {job.prompt || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {fmt.usd(job.estimatedCostUsd)}
                      {job.confirmedCostUsd != null && (
                        <div className="text-[11px] text-muted-foreground">
                          {t("analytics.confirmed")}: {fmt.usd(job.confirmedCostUsd)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{fmt.dateTime(job.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        {!terminal && p?.capabilities.cancel && (
                          <Button variant="ghost" size="xs" onClick={() => void attempt(() => api.cancelGeneration(job.id), t("studio.canceled"))}>
                            <X />
                            {t("common.cancel")}
                          </Button>
                        )}
                        {(job.status === "failed" || job.status === "canceled" || job.status === "blocked") && (
                          <Button variant="ghost" size="xs" onClick={() => retry(job)}>
                            <RotateCcw />
                            {t("common.retry")}
                          </Button>
                        )}
                        {job.status === "completed" && (
                          <Button variant="ghost" size="xs" onClick={() => void navigate("/archive")}>
                            <FolderOpen />
                            {t("studio.openInArchive")}
                          </Button>
                        )}
                        {terminal && (
                          <Button variant="ghost" size="icon-xs" aria-label={t("generations.remove")} onClick={() => setRemoving(job)}>
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("generations.removeTitle")}
        description={t("generations.removeBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={async () => {
          if (removing) await attempt(() => api.deleteJob(removing.id))
          setRemoving(null)
        }}
      />
      {dialogs}
    </>
  )
}
