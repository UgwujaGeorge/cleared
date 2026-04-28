"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type CalendarProps = {
  selected?: Date | null
  onSelect: (date: Date) => void
  disabled?: (date: Date) => boolean
  className?: string
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
})

function Calendar({ selected, onSelect, disabled, className }: CalendarProps) {
  const [month, setMonth] = React.useState(() => startOfMonth(selected ?? new Date()))

  React.useEffect(() => {
    if (selected) setMonth(startOfMonth(selected))
  }, [selected])

  const days = React.useMemo(() => getCalendarDays(month), [month])

  return (
    <div className={cn("w-[280px]", className)}>
      <div className="mb-3 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setMonth(addMonths(month, -1))}
          aria-label="Previous month"
        >
          <ChevronLeft />
        </Button>
        <div className="font-mono text-sm font-medium">
          {MONTH_LABEL.format(month)}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setMonth(addMonths(month, 1))}
          aria-label="Next month"
        >
          <ChevronRight />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="py-1">
            {weekday}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((date) => {
          const isOutside = date.getMonth() !== month.getMonth()
          const isSelected = selected ? isSameDay(date, selected) : false
          const isDisabled = disabled?.(date) ?? false

          return (
            <button
              key={date.toISOString()}
              type="button"
              disabled={isDisabled}
              onClick={() => onSelect(date)}
              className={cn(
                "h-8 rounded-md text-sm transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35",
                isOutside && "text-muted-foreground/45",
                isSelected && "bg-primary text-primary-foreground hover:bg-primary"
              )}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

function getCalendarDays(month: Date) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  start.setDate(start.getDate() - start.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export { Calendar }
