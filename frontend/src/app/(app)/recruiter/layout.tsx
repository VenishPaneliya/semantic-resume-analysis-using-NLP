"use client";

import { ShieldOff } from "lucide-react";
import Link from "next/link";
import { useUser } from "@/components/shell";
import { Empty } from "@/components/ui";

function isRecruiter(role: string) {
  return role === "recruiter" || role === "admin";
}

export default function RecruiterLayout({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  if (!isRecruiter(user.role))
    return (
      <Empty
        icon={<ShieldOff className="h-8 w-8" aria-hidden />}
        title="HR staff only"
        action={
          <Link href="/openings" className="btn btn-secondary btn-sm">
            Browse openings
          </Link>
        }
      >
        The recruiter area is for the HR team that posts openings. You don&apos;t have access to it.
      </Empty>
    );
  return <>{children}</>;
}
