"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingBlock } from "@/components/ui";

/** The Roles tab was merged into Leaderboard; keep old links working. */
export default function RolesRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => router.replace(`/resumes/${id}/leaderboard`), [id, router]);
  return <LoadingBlock />;
}
