"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingBlock } from "@/components/ui";
import { useResume } from "./context";

export default function ResumeIndex() {
  const { resume } = useResume();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/resumes/${resume.id}/${resume.latest_version_id ? "analysis" : "review"}`);
  }, [resume, router]);
  return <LoadingBlock />;
}
