import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import type { ModelDefinition, ProviderStatus, Workflow } from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"

export function providerName(providers: ProviderStatus[], id: string): string {
  return providers.find((p) => p.id === id)?.displayName ?? id
}

export function ModelPicker({
  models,
  providers,
  value,
  onChange,
}: {
  models: ModelDefinition[]
  providers: ProviderStatus[]
  value: string | null
  onChange: (id: string) => void
}) {
  const { t, model: mn } = useI18n()
  const [open, setOpen] = useState(false)
  const [workflow, setWorkflow] = useState<Workflow | "all">("all")
  const workflows = useMemo(() => [...new Set(models.map((m) => m.workflow))], [models])
  const selected = models.find((m) => m.id === value)
  const visible = models.filter((m) => workflow === "all" || m.workflow === workflow)
  const groups = useMemo(() => {
    const map = new Map<string, ModelDefinition[]>()
    for (const m of visible) map.set(m.provider, [...(map.get(m.provider) ?? []), m])
    return [...map.entries()]
  }, [visible])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t("studio.model")}
          className="h-auto w-full justify-between py-2 text-left"
          data-testid="model-picker"
        >
          {selected ? (
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{mn(selected.displayName)}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {providerName(providers, selected.provider)} · {t(`workflow.${selected.workflow}`)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("studio.chooseModel")}</span>
          )}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        {workflows.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b p-2" role="group" aria-label={t("models.workflow")}>
            {(["all", ...workflows] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={workflow === w}
                onClick={() => setWorkflow(w)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground",
                  workflow === w && "border-white/25 bg-white/[0.06] text-foreground"
                )}
              >
                {w === "all" ? t("common.all") : t(`workflow.${w}`)}
              </button>
            ))}
          </div>
        )}
        <Command>
          <CommandInput placeholder={t("studio.searchModels")} />
          <CommandList className="max-h-80">
            <CommandEmpty>{t("studio.noModelMatch")}</CommandEmpty>
            {groups.map(([provider, list]) => {
              const status = providers.find((p) => p.id === provider)
              return (
                <CommandGroup
                  key={provider}
                  heading={`${providerName(providers, provider)}${status && !status.configured ? ` · ${t("providers.notConfigured")}` : ""}`}
                >
                  {list.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={`${m.displayName} ${m.family} ${m.provider} ${m.workflow}`}
                      onSelect={() => {
                        onChange(m.id)
                        setOpen(false)
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{mn(m.displayName)}</div>
                        <div className="truncate text-xs text-muted-foreground">{t(`workflow.${m.workflow}`)}</div>
                      </div>
                      <Check className={cn("ml-auto", value === m.id ? "opacity-100" : "opacity-0")} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
