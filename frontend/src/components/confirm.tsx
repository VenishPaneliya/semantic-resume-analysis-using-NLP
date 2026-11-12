"use client";

/* In-app confirmation dialog for destructive actions, replacing window.confirm().
   Built on the native <dialog> element opened with showModal(): focus moves into the dialog and is
   trapped there, Escape cancels, the rest of the page is inert, and focus returns to the button that
   opened it. Cancel is focused first so pressing Enter by accident never deletes anything.

     const confirm = useConfirm();
     if (!(await confirm({ title: t("dash.confirmDelete", { title }), confirmLabel: t("common.delete") }))) return; */

import { AlertTriangle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** label of the confirming button; defaults to "Delete" for danger, "Continue" otherwise */
  confirmLabel?: string;
  tone?: "danger" | "default";
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error("useConfirm outside ConfirmProvider");
  return c;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [req, setReq] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setReq({ o, resolve });
      }),
    [],
  );

  useEffect(() => {
    const d = ref.current;
    if (req && d && !d.open) d.showModal();
  }, [req]);

  function close(v: boolean) {
    req?.resolve(v);
    setReq(null);
    ref.current?.close();
    // restore focus to whatever opened the dialog (if it still exists)
    const el = opener.current;
    opener.current = null;
    if (el && el.isConnected) setTimeout(() => el.focus(), 0);
  }

  const danger = (req?.o.tone ?? "danger") === "danger";
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <dialog
          ref={ref}
          aria-labelledby={`${id}-t`}
          aria-describedby={req.o.body ? `${id}-b` : undefined}
          className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-card p-0 text-ink shadow-xl backdrop:bg-ink/40"
          onCancel={(e) => {
            e.preventDefault();
            close(false);
          }}
          data-testid="confirm-dialog"
        >
          <div className="flex gap-3 p-5">
            {danger && (
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </span>
            )}
            <div className="min-w-0">
              <h2 id={`${id}-t`} className="text-lg leading-snug">
                {req.o.title}
              </h2>
              {req.o.body && (
                <p id={`${id}-b`} className="mt-1.5 text-sm text-ink-2">
                  {req.o.body}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-paper px-5 py-3">
            <button type="button" className="btn btn-secondary btn-sm" autoFocus onClick={() => close(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => close(true)} data-testid="confirm-ok">
              {req.o.confirmLabel ?? (danger ? t("common.delete") : t("common.continue"))}
            </button>
          </div>
        </dialog>
      )}
    </ConfirmCtx.Provider>
  );
}
