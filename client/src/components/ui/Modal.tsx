import React, { useEffect, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className = "" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "modal-title" : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className={`relative bg-brand-card border border-brand-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto ${className}`}
      >
        {title && (
          <div className="flex items-center justify-between p-6 border-b border-brand-border">
            <h2 id="modal-title" className="text-lg font-semibold text-brand-textPrimary">
              {title}
            </h2>
            <button
              onClick={onClose}
              data-autofocus
              className="text-brand-textSubtle hover:text-brand-textPrimary transition-colors text-xl leading-none"
              aria-label="Close modal"
            >
              ×
            </button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
