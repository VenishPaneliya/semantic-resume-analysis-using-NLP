"use client";

import { Briefcase, Building2, FileText, LayoutDashboard, LogOut, Menu, Settings, Shield, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import type { User } from "@/lib/types";
import { Alert, cx, LoadingBlock } from "./ui";

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

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cx("inline-flex items-center gap-2 font-semibold", className)} aria-label="Resume Intelligence home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="1" y="1" width="24" height="24" rx="5" fill="#0f5c55" />
        <path d="M7 7.5h8M7 11.5h12M7 15.5h6" stroke="#f7f4ee" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="18.5" cy="17.5" r="3.2" fill="none" stroke="#e9c97a" strokeWidth="1.8" />
      </svg>
      <span className="font-display text-[1.05rem] tracking-tight">Resume Intelligence</span>
    </Link>
  );
}

const NAV = [
  { href: "/dashboard", label: "Resumes", icon: LayoutDashboard },
  { href: "/openings", label: "Openings", icon: Building2 },
  { href: "/applications", label: "Applications", icon: Briefcase },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

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

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", noRedirect: true });
    } finally {
      router.push("/login");
    }
  }

  if (error) return <div className="mx-auto max-w-xl p-8"><Alert tone="bad" title="Could not load your account">{error}</Alert></div>;
  if (!user) return <div className="mx-auto max-w-xl p-8"><LoadingBlock label="Loading your workspace…" /></div>;

  const nav = [
    ...NAV,
    ...(user.role === "recruiter" || user.role === "admin" ? [{ href: "/recruiter", label: "Recruiter", icon: Users }] : []),
    ...(user.role === "admin" ? [{ href: "/admin", label: "Admin", icon: Shield }] : []),
  ];

  return (
    <UserCtx.Provider value={{ user, refreshUser, setUser }}>
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Logo />
          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname.startsWith(href) || (href === "/dashboard" && pathname.startsWith("/resumes")) ? "page" : undefined}
                className="btn btn-ghost btn-sm aria-[current=page]:bg-paper-2 aria-[current=page]:text-ink"
              >
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </Link>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={logout}>
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </button>
          </nav>
          <button className="btn btn-ghost btn-sm lg:hidden" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
            <span className="sr-only">Menu</span>
          </button>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Main" className="border-t border-line bg-card px-4 py-2 lg:hidden">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} className="flex items-center gap-2 rounded px-2 py-2.5 text-sm font-medium hover:bg-paper-2">
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </Link>
            ))}
            <button className="flex w-full items-center gap-2 rounded px-2 py-2.5 text-sm font-medium hover:bg-paper-2" onClick={logout}>
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </button>
          </nav>
        )}
      </header>
      {!user.email_verified && (
        <div className="mx-auto max-w-6xl px-4 pt-4">
          <VerifyBanner />
        </div>
      )}
      <main id="main" className="mx-auto max-w-6xl px-4 py-8">
        {children}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
        <p className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" aria-hidden /> Scores are advisory indicators with published rules — not ATS scores, and not predictions of
          interviews or hiring.
        </p>
      </footer>
    </UserCtx.Provider>
  );
}

function VerifyBanner() {
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  return (
    <Alert
      tone="warn"
      title="Verify your email to start uploading"
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
          {state === "sent" ? "Sent" : "Resend link"}
        </button>
      }
    >
      We sent a link to your inbox. {state === "error" && "Could not resend right now — try again in a few minutes."}
    </Alert>
  );
}
