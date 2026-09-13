import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

function nextEnabledIndex(options: SelectOption[], from: number, direction: 1 | -1): number {
  const count = options.length;
  if (count === 0) return from;
  let idx = from;
  for (let i = 0; i < count; i++) {
    idx = (idx + direction + count) % count;
    if (!options[idx]!.disabled) return idx;
  }
  return from;
}

/**
 * Custom dropdown replacing the native <select> everywhere in the app, so
 * every selection menu shares one look/behavior we control directly instead
 * of the browser's native picker UI (which varies by OS/browser and can't be
 * themed). Deliberately kept to the single-select case: nothing in the app
 * uses `multiple` or `required` on a native select today (multi-value
 * pickers like custom-field "multi_select" already use their own chip-button
 * UI, not <select>), so those aren't supported here.
 *
 * Visual styling lives in styles.css under `.ph-select*` and deliberately
 * mirrors the old element-selector rules (`select { ... }`, `.ph-field
 * select`, `.ph-filter-bar select`, `.ph-bulk-bar-group select`) targeting
 * the new class names instead, so swapping the markup needed zero visual
 * changes at any call site.
 */
export default function Select({
  value,
  onChange,
  options,
  id,
  disabled,
  className,
  style,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [panelLayout, setPanelLayout] = useState<{ placement: "top" | "bottom"; maxHeight: number }>({
    placement: "bottom",
    maxHeight: 280,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlighted(idx >= 0 ? idx : 0);
    // Only reset the highlight when the panel opens, not on every options/value change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Flips the panel above the trigger (and always clamps its height to
  // whatever room actually exists) instead of always opening downward —
  // a downward-only panel gets cropped by the viewport edge whenever the
  // trigger sits near the bottom of the screen, e.g. the Kanban board's
  // fixed-position bulk-action bar.
  useLayoutEffect(() => {
    if (!open) return;
    const GAP = 6;
    const VIEWPORT_MARGIN = 8;
    const IDEAL_MAX = 280;

    function recompute() {
      const trigger = rootRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - GAP - VIEWPORT_MARGIN;
      if (spaceBelow >= IDEAL_MAX || spaceBelow >= spaceAbove) {
        setPanelLayout({ placement: "bottom", maxHeight: Math.max(80, Math.min(IDEAL_MAX, spaceBelow)) });
      } else {
        setPanelLayout({ placement: "top", maxHeight: Math.max(80, Math.min(IDEAL_MAX, spaceAbove)) });
      }
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((h) => nextEnabledIndex(options, h, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((h) => nextEnabledIndex(options, h, -1));
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(nextEnabledIndex(options, -1, 1));
        break;
      case "End":
        e.preventDefault();
        setHighlighted(nextEnabledIndex(options, options.length, -1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(highlighted);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className={["ph-select", className].filter(Boolean).join(" ")} style={style} ref={rootRef}>
      <button
        type="button"
        id={id}
        className="ph-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
      >
        <span className="ph-select-value">{selected ? selected.label : ""}</span>
        <span className="ph-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={panelRef}
          className={`ph-select-panel ph-select-panel-${panelLayout.placement}`}
          role="listbox"
          id={listboxId}
          aria-label={ariaLabel}
          tabIndex={-1}
          style={{ maxHeight: panelLayout.maxHeight }}
        >
          {options.map((opt, idx) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              aria-disabled={opt.disabled || undefined}
              className={[
                "ph-select-option",
                idx === highlighted ? "ph-select-option-highlighted" : "",
                opt.value === value ? "ph-select-option-selected" : "",
                opt.disabled ? "ph-select-option-disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseEnter={() => setHighlighted(idx)}
              onClick={() => commit(idx)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
