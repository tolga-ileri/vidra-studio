import { Link, useNavigate } from "react-router"
import { ArrowRight, Clapperboard, Download, FolderArchive, ImageIcon, Library, PlugZap } from "lucide-react"
import { TERMINAL_JOB_STATUSES } from "@vidra/core"

import { EmptyState, JobStatusBadge, PageHeader, Section, Skeleton } from "@/components/app/common"
import { Thumb } from "@/components/archive/thumb"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useLive } from "@/hooks/use-live"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

export function HomeScreen() {
  const { t, fmt } = useI18n()
  const navigate = useNavigate()
  const providers = useApp((s) => s.providers)
  const jobs = useLive(() => api.listJobs(), "home-jobs", ["jobs-changed"])
  const recent = useLive(() => api.listArchive({ states: ["saved"], sort: "date", direction: "desc" }), "home-recent", ["archive-changed"])
  const downloads = useLive(() => api.listDownloads(), "home-dl", ["archive-changed", "download-progress"])

  const active = (jobs.data ?? []).filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status))
  const queue = (downloads.data ?? []).filter((d) => d.task.status !== "completed")
  const integrated = providers.filter((p) => p.integration === "integrated")
  const anyConfigured = integrated.some((p) => p.configured)

  return (
    <>
      <PageHeader
        title={t("home.title")}
        description={t("home.subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/image">
                <ImageIcon />
                {t("palette.newImage")}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/video">
                <Clapperboard />
                {t("palette.newVideo")}
              </Link>
            </Button>
          </>
        }
      />

      {!anyConfigured && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <PlugZap className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t("home.connectTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("home.connectBody")}</p>
            </div>
          </div>
          <Button size="sm" asChild>
            <Link to="/providers">{t("home.connect")}</Link>
          </Button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 max-[1180px]:grid-cols-2">
        <Section
          title={t("home.recent")}
          className="col-span-2"
          actions={
            <Button variant="ghost" size="xs" asChild>
              <Link to="/archive">
                {t("common.viewAll")}
                <ArrowRight />
              </Link>
            </Button>
          }
        >
          {recent.loading && !recent.data ? (
            <div className="grid grid-cols-4 gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="aspect-video" />
              ))}
            </div>
          ) : (recent.data ?? []).length === 0 ? (
            <EmptyState
              icon={<FolderArchive />}
              title={t("home.noRecent")}
              description={t("home.noRecentBody")}
              action={
                <Button size="sm" asChild>
                  <Link to="/video">{t("palette.newVideo")}</Link>
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-4 gap-3 max-[1180px]:grid-cols-3">
              {(recent.data ?? []).slice(0, 8).map((e) => (
                <button
                  key={e.asset?.id ?? e.job.id}
                  type="button"
                  onClick={() => void navigate("/archive")}
                  className="group overflow-hidden rounded-lg border bg-black/40 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Thumb entry={e} className="aspect-video" />
                  <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">{e.item?.customTitle || e.job.modelName}</div>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section
          title={t("home.active")}
          actions={
            <Button variant="ghost" size="xs" asChild>
              <Link to="/generations">{t("common.viewAll")}</Link>
            </Button>
          }
        >
          {active.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("home.noActive")}</p>
          ) : (
            <ul className="space-y-3">
              {active.slice(0, 5).map((j) => (
                <li key={j.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{j.modelName}</span>
                    <JobStatusBadge status={j.status} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{j.prompt}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={t("home.downloads")}
          actions={
            <Button variant="ghost" size="xs" asChild>
              <Link to="/downloads">{t("common.viewAll")}</Link>
            </Button>
          }
        >
          {queue.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Download className="size-4" />
              {t("home.noDownloads")}
            </p>
          ) : (
            <ul className="space-y-3">
              {queue.slice(0, 4).map(({ task, asset }) => (
                <li key={task.id} className="space-y-1">
                  <div className="flex justify-between gap-2 text-xs">
                    <span className="truncate">{asset.filename}</span>
                    <span className="text-muted-foreground">{t(`download.${task.status}`)}</span>
                  </div>
                  <Progress
                    value={task.totalBytes ? (task.bytesDownloaded / task.totalBytes) * 100 : 0}
                    className="h-1"
                    aria-label={asset.filename}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={t("home.providers")}
          actions={
            <Button variant="ghost" size="xs" asChild>
              <Link to="/providers">{t("common.manage")}</Link>
            </Button>
          }
        >
          <ul className="space-y-2">
            {integrated.map((p) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <span>{p.displayName}</span>
                <span
                  className={cn(
                    "text-xs",
                    !p.configured
                      ? "text-muted-foreground"
                      : p.verification === "ok"
                        ? "text-success"
                        : p.verification === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                  )}
                >
                  {!p.configured ? t("providers.notConfigured") : t(`providers.verification.${p.verification}`)}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("home.quick")}>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["/video", Clapperboard, "nav.video"],
                ["/image", ImageIcon, "nav.image"],
                ["/prompts", Library, "nav.prompts"],
                ["/archive", FolderArchive, "nav.archive"],
              ] as const
            ).map(([to, Icon, label]) => (
              <Button key={to} variant="outline" size="sm" className="justify-start" asChild>
                <Link to={to}>
                  <Icon />
                  {t(label)}
                </Link>
              </Button>
            ))}
          </div>
          {jobs.data && <p className="mt-3 text-xs text-muted-foreground">{t("home.totals", { count: fmt.num(jobs.data.length) })}</p>}
        </Section>
      </div>
    </>
  )
}
