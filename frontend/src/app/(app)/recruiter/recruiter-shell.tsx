"use client";

import { BarChart3, ListChecks, Scale, ShieldOff } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MfaRequiredPrompt, useUser } from "@/components/shell";
import { Empty } from "@/components/ui";
import { useT, type MessageKey } from "@/lib/i18n";

function isRecruiter(role: string) {
  return role === "recruiter" || role === "admin";
}

const SUBNAV: { href: string; label: MessageKey; icon: typeof Scale; exact?: boolean; adminOnly?: boolean }[] = [
  { href: "/recruiter", label: "rec.sub.openings", icon: ListChecks, exact: true },
  { href: "/recruiter/analytics", label: "rec.sub.analytics", icon: BarChart3 },
  // admin-only: recruiters move candidates between stages, so they must not also see group outcomes
  { href: "/recruiter/fairness", label: "rec.sub.fairness", icon: Scale, adminOnly: true },
];

export function RecruiterShell({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const pathname = usePathname();
  const t = useT();
  if (!isRecruiter(user.role))
    return (
      <Empty level={2}
        icon={<ShieldOff className="h-8 w-8" aria-hidden />}
        title={t("rec.staffOnly")}
        action={
          <Link href="/openings" className="btn btn-secondary btn-sm">
            {t("rec.browseOpenings")}
          </Link>
        }
      >
        {t("rec.staffOnlyBody")}
      </Empty>
    );
  if (user.mfa_required_for_role && !user.mfa_enabled) return <MfaRequiredPrompt />;
  return (
    <>
      <nav aria-label={t("rec.sections")} className="-mx-4 mb-6 overflow-x-auto px-4">
        <ul className="flex min-w-max gap-1 border-b border-line">
          {SUBNAV.filter((s) => !s.adminOnly || user.role === "admin").map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href || pathname.startsWith("/recruiter/openings") || pathname.startsWith("/recruiter/applications") : pathname.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-teal text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden /> {t(label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </>
  );
}
