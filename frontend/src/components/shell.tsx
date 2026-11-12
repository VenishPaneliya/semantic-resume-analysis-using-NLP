"use client";

import { Briefcase, Building2, FileText, GraduationCap, KeyRound, LayoutDashboard, LogOut, Menu, Settings, Shield, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ConfirmProvider } from "./confirm";
import { LanguageSwitcher } from "./language-switcher";
import { Alert, cx, LoadingBlock } from "./ui";
import { api, ApiError, MFA_REQUIRED_EVENT } from "@/lib/api";
import { useI18n, useT, type MessageKey } from "@/lib/i18n";
import type { User } from "@/lib/types";

interface Ctx {
  user: User;
  refreshUser: () => Promise<void>;
  setUser: (u: User) => void;
}
const UserCtx = createContext<Ctx | null>(null);

export function useUser() {
  const c = useContext(UserCtx);
  if (!c) throw new Error("useUser outside AppShell");
  return c;
}

/** HR staff and admins may see technical details (model names, costs, rubric versions) that candidates
    don't need. */
export function useIsStaff() {
  const c = useContext(UserCtx);
  return c?.user.role === "recruiter" || c?.user.role === "admin";
}

export function Logo({ className }: { className?: string }) {
  const t = useT();
  return (
    <Link href="/" className={cx("inline-flex shrink-0 items-center gap-2 font-semibold", className)} aria-label={t("shell.home")}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="1" y="1" width="24" height="24" rx="5" fill="#0f5c55" />
        <path d="M7 7.5h8M7 11.5h12M7 15.5h6" stroke="#f7f4ee" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="18.5" cy="17.5" r="3.2" fill="none" stroke="#e9c97a" strokeWidth="1.8" />
      </svg>
      <span className="font-display text-[1.05rem] tracking-tight">Resume Intelligence</span>
    </Link>
  );
}

const NAV: { href: string; label: MessageKey; icon: typeof Settings }[] = [
  { href: "/dashboard", label: "nav.resumes", icon: LayoutDashboard },
  { href: "/openings", label: "nav.openings", icon: Building2 },
  { href: "/applications", label: "nav.applications", icon: Briefcase },
  { href: "/learning", label: "nav.learning", icon: GraduationCap },
  { href: "/settings", label: "nav.settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mfaBlock, setMfaBlock] = useState<{ path: string; message: string } | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api<User>("/api/auth/me"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const h = (e: Event) => setMfaBlock({ path: window.location.pathname, message: String((e as CustomEvent).detail ?? "") });
    window.addEventListener(MFA_REQUIRED_EVENT, h);
    return () => window.removeEventListener(MFA_REQUIRED_EVENT, h);
  }, []);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", noRedirect: true });
    } finally {
      router.push("/login");
    }
  }

  if (error) return <div className="mx-auto max-w-xl p-8"><Alert tone="bad" title={t("shell.loadError")}>{error}</Alert></div>;
  if (!user) return <div className="mx-auto max-w-xl p-8"><LoadingBlock label={t("shell.loadingWorkspace")} /></div>;

  const nav = [
    ...NAV,
    ...(user.role === "recruiter" || user.role === "admin" ? [{ href: "/recruiter", label: "nav.recruiter" as const, icon: Users }] : []),
    ...(user.role === "admin" ? [{ href: "/admin", label: "nav.admin" as const, icon: Shield }] : []),
  ];

  return (
    <UserCtx.Provider value={{ user, refreshUser, setUser }}>
      <ConfirmProvider>
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Logo />
          <nav aria-label={t("nav.main")} className="hidden min-w-0 items-center gap-1 lg:flex" data-testid="main-nav">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname.startsWith(href) || (href === "/dashboard" && pathname.startsWith("/resumes")) ? "page" : undefined}
                className="btn btn-ghost btn-sm whitespace-nowrap aria-[current=page]:bg-paper-2 aria-[current=page]:text-ink"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden /> {t(label)}
              </Link>
            ))}
            <button className="btn btn-ghost btn-sm whitespace-nowrap" onClick={logout}>
              <LogOut className="h-4 w-4 shrink-0" aria-hidden /> {t("nav.signOut")}
            </button>
            <LanguageSwitcher className="ml-1" />
          </nav>
          <button className="btn btn-ghost btn-sm lg:hidden" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
            <span className="sr-only">{t("nav.menu")}</span>
          </button>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label={t("nav.main")} className="border-t border-line bg-card px-4 py-2 lg:hidden" data-testid="mobile-nav">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} className="flex items-center gap-2 rounded px-2 py-2.5 text-sm font-medium hover:bg-paper-2">
                <Icon className="h-4 w-4" aria-hidden /> {t(label)}
              </Link>
            ))}
            <button className="flex w-full items-center gap-2 rounded px-2 py-2.5 text-sm font-medium hover:bg-paper-2" onClick={logout}>
              <LogOut className="h-4 w-4" aria-hidden /> {t("nav.signOut")}
            </button>
            <div className="mt-1 border-t border-line px-2 pb-1 pt-3">
              <LanguageSwitcher />
            </div>
          </nav>
        )}
      </header>
      {!user.email_verified && (
        <div className="mx-auto max-w-6xl px-4 pt-4">
          <VerifyBanner />
        </div>
      )}
      <main id="main" className="mx-auto max-w-6xl px-4 py-8">
        {mfaBlock && mfaBlock.path === pathname && !user.mfa_enabled ? <MfaRequiredPrompt message={mfaBlock.message} /> : children}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
        <p className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden /> {t("shell.disclaimer")}
        </p>
      </footer>
      </ConfirmProvider>
    </UserCtx.Provider>
  );
}

function VerifyBanner() {
  const t = useT();
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  return (
    <Alert
      tone="warn"
      title={t("shell.verifyTitle")}
      action={
        <button
          className="btn btn-secondary btn-sm"
          disabled={state === "sent"}
          onClick={async () => {
            try {
              await api("/api/auth/resend-verification", { method: "POST" });
              setState("sent");
            } catch {
              setState("error");
            }
          }}
        >
          {state === "sent" ? t("shell.verifySent") : t("shell.verifyResend")}
        </button>
      }
    >
      {t("shell.verifyBody")} {state === "error" && t("shell.verifyError")}
    </Alert>
  );
}

/** Full-page prompt shown instead of an error when a staff API says two-factor login is required. */
export function MfaRequiredPrompt({ message }: { message?: string }) {
  const { locale, t } = useI18n();
  return (
    <div className="mx-auto max-w-xl" data-testid="mfa-required">
      <div className="card flex flex-col items-center gap-4 px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-soft text-teal">
          <KeyRound className="h-7 w-7" aria-hidden />
        </span>
        <h1 className="text-2xl">{t("shell.mfaTitle")}</h1>
        <p className="text-sm text-ink-2">
          {/* the API's message is English; outside English show our own translated explanation */}
          {(locale === "en" && message) || t("shell.mfaBody")}
        </p>
        <Link href="/settings#security" className="btn btn-primary">
          <KeyRound className="h-4 w-4" aria-hidden /> {t("shell.mfaSetup")}
        </Link>
        <p className="text-xs text-muted">{t("shell.mfaNote")}</p>
      </div>
    </div>
  );
}
