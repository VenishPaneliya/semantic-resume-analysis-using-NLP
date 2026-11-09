"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <main id="main" className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="eyebrow">404</p>
      <h1 className="text-3xl">{t("notFound.title")}</h1>
      <p className="text-sm text-ink-2">{t("notFound.body")}</p>
      <Link href="/dashboard" className="btn btn-primary">
        {t("notFound.back")}
      </Link>
    </main>
  );
}
