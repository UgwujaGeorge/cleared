"use client";

import { useState } from "react";
import {
  toFriendlyError,
  toneClasses,
  type FriendlyError,
} from "@/lib/friendly-error";

// Pure UI component. Shows a friendly title + optional detail + hint, with a
// collapsible "details" section that exposes the raw error for power users.
// Does not affect any transaction flow.
export function FriendlyErrorBox({
  error,
  compact,
}: {
  error: unknown;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fe: FriendlyError =
    error && typeof error === "object" && "title" in (error as FriendlyError)
      ? (error as FriendlyError)
      : toFriendlyError(error);

  const padding = compact ? "p-2.5" : "p-3";
  const titleSize = compact ? "text-xs" : "text-sm";

  return (
    <div className={`rounded-md border ${toneClasses(fe.tone)} ${padding}`}>
      <p className={`${titleSize} font-medium`}>{fe.title}</p>
      {fe.detail && (
        <p className="mt-1 text-[11px] opacity-80">{fe.detail}</p>
      )}
      {fe.hint && (
        <p className="mt-1 text-[11px] opacity-90">{fe.hint}</p>
      )}
      {fe.raw && fe.raw !== fe.title && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 font-mono text-[10px] uppercase tracking-wider opacity-60 hover:opacity-100"
        >
          {open ? "− hide details" : "+ show details"}
        </button>
      )}
      {open && (
        <pre className="mt-2 max-h-32 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] leading-snug opacity-80">
          {fe.raw}
        </pre>
      )}
    </div>
  );
}
