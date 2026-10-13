import { useEffect, useState, type ComponentType } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router"
import {
  BarChart3,
  Clapperboard,
  Download,
  FolderArchive,
  Home,
  ImageIcon,
  Keyboard,
  Layers,
  ListChecks,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Settings,
} from "lucide-react"

import { ErrorBoundary, Mark } from "@/components/app/common"
import { StorageIndicator } from "@/components/app/storage"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n, type MessageKey } from "@/i18n"
import { backend } from "@/lib/backend"
import { cn } from "@/lib/utils"

export interface NavItem {
  to: string
  label: MessageKey
  icon: ComponentType<{ className?: string }>
}

export const NAV: NavItem[] = [
  { to: "/", label: "nav.home", icon: Home },
  { to: "/video", label: "nav.video", icon: Clapperboard },
  { to: "/image", label: "nav.image", icon: ImageIcon },
  { to: "/models", label: "nav.models", icon: Layers },
  { to: "/archive", label: "nav.archive", icon: FolderArchive },
  { to: "/generations", label: "nav.generations", icon: ListChecks },
  { to: "/downloads", label: "nav.downloads", icon: Download },
  { to: "/prompts", label: "nav.prompts", icon: Library },
  { to: "/analytics", label: "nav.analytics", icon: BarChart3 },
  { to: "/providers", label: "nav.providers", icon: PlugZap },
  { to: "/settings", label: "nav.settings", icon: Settings },
]

const COLLAPSE_KEY = "vidra.sidebar.collapsed"

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
}

export function DemoBanner() {
  const { t } = useI18n()
  if (!backend().isMock) return null
  return (
    <div
      role="note"
      className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-warning/20 bg-warning/[0.06] text-[11px] font-medium tracking-wide text-warning"
    >
      {t("demo.banner")}
    </div>
  )
}

export function AppShell() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsedPref, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1"
    } catch {
      return false
    }
  })
  // Narrow windows always get the compact sidebar; the preference is kept.
  const [narrow, setNarrow] = useState(() => typeof window?.matchMedia === "function" && window.matchMedia("(max-width: 800px)").matches)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const mq = window.matchMedia("(max-width: 800px)")
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  const collapsed = collapsedPref || narrow
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsedPref ? "1" : "0")
    } catch {
      /* storage unavailable */
    }
  }, [collapsedPref])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-page-search]")
        if (search) {
          e.preventDefault()
          search.focus()
        }
      } else if (e.key === "?") {
        e.preventDefault()
        setShortcuts(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const go = (to: string) => {
    setPalette(false)
    void navigate(to)
  }

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200",
          collapsed ? "w-[60px]" : "w-[216px]"
        )}
        aria-label={t("nav.label")}
      >
        <div className={cn("flex h-14 items-center gap-2.5 px-3.5", collapsed && "justify-center px-0")}>
          <Mark />
          {!collapsed && <span className="truncate text-sm font-semibold tracking-tight">Vidra Studio</span>}
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {NAV.map((item) => {
            const link = (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                    isActive && "bg-white/[0.07] text-foreground",
                    collapsed && "justify-center px-0"
                  )
                }
                aria-label={collapsed ? t(item.label) : undefined}
              >
                <item.icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{t(item.label)}</span>}
              </NavLink>
            )
            return collapsed ? (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{t(item.label)}</TooltipContent>
              </Tooltip>
            ) : (
              link
            )
          })}
        </nav>
        <StorageIndicator collapsed={collapsed} />
        <div className={cn("flex items-center gap-1 border-t p-2", collapsed && "flex-col")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("shortcuts.title")} onClick={() => setShortcuts(true)}>
            <Keyboard />
          </Button>
          {!collapsed && (
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              Ctrl K
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto" id="main">
        <div className="mx-auto max-w-[1480px] px-8 py-7 max-[800px]:px-4 max-[800px]:py-4">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>

      <CommandDialog open={palette} onOpenChange={setPalette} title={t("palette.title")} description={t("palette.description")}>
        <CommandInput placeholder={t("palette.placeholder")} />
        <CommandList>
          <CommandEmpty>{t("palette.empty")}</CommandEmpty>
          <CommandGroup heading={t("palette.navigation")}>
            {NAV.map((item) => (
              <CommandItem key={item.to} value={`${t(item.label)} ${item.to}`} onSelect={() => go(item.to)}>
                <item.icon />
                {t(item.label)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={t("palette.actions")}>
            <CommandItem value={t("palette.newVideo")} onSelect={() => go("/video")}>
              <Clapperboard />
              {t("palette.newVideo")}
            </CommandItem>
            <CommandItem value={t("palette.newImage")} onSelect={() => go("/image")}>
              <ImageIcon />
              {t("palette.newImage")}
            </CommandItem>
            <CommandItem value={t("palette.addProvider")} onSelect={() => go("/providers")}>
              <PlugZap />
              {t("palette.addProvider")}
            </CommandItem>
            <CommandItem
              value={t("palette.toggleSidebar")}
              onSelect={() => {
                setCollapsed((c) => !c)
                setPalette(false)
              }}
            >
              <PanelLeftClose />
              {t("palette.toggleSidebar")}
            </CommandItem>
            <CommandItem
              value={t("shortcuts.title")}
              onSelect={() => {
                setPalette(false)
                setShortcuts(true)
              }}
            >
              <Keyboard />
              {t("shortcuts.title")}
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <Dialog open={shortcuts} onOpenChange={setShortcuts}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("shortcuts.title")}</DialogTitle>
            <DialogDescription>{t("shortcuts.description")}</DialogDescription>
          </DialogHeader>
          <dl className="divide-y text-sm">
            {(
              [
                ["Ctrl + K", "shortcuts.palette"],
                ["Ctrl + Enter", "shortcuts.generate"],
                ["/", "shortcuts.search"],
                ["?", "shortcuts.help"],
                ["Esc", "shortcuts.close"],
              ] as const
            ).map(([keys, label]) => (
              <div key={keys} className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">{t(label)}</dt>
                <dd>
                  <kbd className="rounded border bg-black/40 px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  )
}
