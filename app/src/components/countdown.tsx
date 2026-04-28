"use client";

import { useEffect, useState } from "react";

export function Countdown({ targetUnix }: { targetUnix: number }) {
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, targetUnix * 1000 - Date.now())
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemainingMs(Math.max(0, targetUnix * 1000 - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [targetUnix]);

  if (remainingMs <= 0) {
    return <span className="font-mono text-xs text-muted-foreground">closed</span>;
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts =
    d > 0
      ? [`${d}d`, `${h}h`, `${m}m`]
      : h > 0
      ? [`${h}h`, `${m}m`, `${s}s`]
      : [`${m}m`, `${s}s`];
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {parts.join(" ")}
    </span>
  );
}
