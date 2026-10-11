import { useEffect, useState } from "react"

import { Input } from "@/components/ui/input"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

function isValidIso(v: string): boolean {
  const m = ISO.exec(v)
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
}

/**
 * A YYYY-MM-DD date field rendered in the app's language. The native date
 * input follows the operating system's locale instead, which mixed languages
 * whenever the UI and Windows languages differed. `value` and `onChange` use
 * ISO dates ("" when empty), like `<input type="date">`.
 */
export function DateField({
  id,
  value,
  onChange,
  className,
}: {
  id: string
  value: string
  onChange: (iso: string) => void
  className?: string
}) {
  const { t } = useI18n()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const invalid = text !== "" && !isValidIso(text)
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={10}
      placeholder={t("date.placeholder")}
      title={t("date.format")}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(e) => {
        const next = e.target.value.replace(/[^\d-]/g, "")
        setText(next)
        if (next === "") onChange("")
        else if (isValidIso(next)) onChange(next)
      }}
      className={cn("font-mono tabular-nums", className)}
    />
  )
}
