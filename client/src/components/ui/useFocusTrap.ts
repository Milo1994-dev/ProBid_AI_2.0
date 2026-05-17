import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "video[controls]",
  "audio[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
  if (typeof (el as HTMLElement & { inert?: boolean }).inert === "boolean"
    && (el as HTMLElement & { inert?: boolean }).inert) return false;
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && isVisible(el));
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const trigger = document.activeElement as HTMLElement | null;

    const focusables = getFocusable(container);
    const initial = container.querySelector<HTMLElement>("[data-autofocus]")
      ?? focusables[0]
      ?? container;
    if (initial === container && container.tabIndex < 0) container.tabIndex = -1;
    initial.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last || !container.contains(current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (trigger && typeof trigger.focus === "function") {
        try { trigger.focus(); } catch { /* trigger no longer in DOM */ }
      }
    };
  }, [active, containerRef]);
}
