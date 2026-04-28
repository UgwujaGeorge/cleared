"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type PopoverContextValue = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null)

function Popover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return

    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener("mousedown", closeOnOutsidePress)
    return () => document.removeEventListener("mousedown", closeOnOutsidePress)
  }, [open])

  return (
    <PopoverContext.Provider value={{ open, setOpen }}>
      <div ref={ref} className="relative">
        {children}
      </div>
    </PopoverContext.Provider>
  )
}

function PopoverTrigger({
  render,
  children,
}: {
  render: React.ReactElement
  children: React.ReactNode
}) {
  const context = usePopoverContext()

  return React.cloneElement(render, {
    "aria-expanded": context.open,
    "aria-haspopup": "dialog",
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      render.props.onClick?.(event)
      context.setOpen((open) => !open)
    },
    children,
  })
}

function PopoverContent({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const context = usePopoverContext()

  if (!context.open) return null

  return (
    <div
      data-slot="popover-content"
      className={cn(
        "absolute left-0 top-full z-50 mt-2 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
        className
      )}
      role="dialog"
    >
      {children}
    </div>
  )
}

function usePopoverContext() {
  const context = React.useContext(PopoverContext)
  if (!context) throw new Error("Popover components must be used inside Popover")
  return context
}

export { Popover, PopoverTrigger, PopoverContent }
