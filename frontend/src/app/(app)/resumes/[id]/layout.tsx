import { ResumeShell } from "./resume-shell";
import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("title.resume");

export default function ResumeLayout({ children }: { children: React.ReactNode }) {
  return <ResumeShell>{children}</ResumeShell>;
}
