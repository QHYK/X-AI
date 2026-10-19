"use client";

import { useState } from "react";
import styles from "./dashboard.module.css";

/** A deliberately small, keyboard-accessible explanation control for ambiguous metrics. */
export function MetricInfo({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.metricInfo}>
      <button
        type="button"
        className={styles.metricInfoButton}
        aria-label="指标说明"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open ? <span className={styles.metricInfoPopover} role="tooltip">{text}</span> : null}
    </span>
  );
}
