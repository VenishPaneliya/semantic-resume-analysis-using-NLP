"use client";

import { createContext, useContext } from "react";
import type { Resume } from "@/lib/types";

export interface ResumeCtx {
  resume: Resume;
  reload: () => Promise<void>;
  /** latest confirmed version id, or null before review is confirmed */
  versionId: string | null;
}

export const ResumeContext = createContext<ResumeCtx | null>(null);

export function useResume() {
  const c = useContext(ResumeContext);
  if (!c) throw new Error("useResume outside resume layout");
  return c;
}
