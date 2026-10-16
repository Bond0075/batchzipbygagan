import { useEffect, useRef } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, actions, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 outline-none`}
      >
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-100">{title}</h2>
        </div>
        <div className="px-5 py-4 text-sm text-slate-300">{children}</div>
        {actions && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 px-5 py-4">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
