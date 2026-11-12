import { RecruiterShell } from "./recruiter-shell";
import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("nav.recruiter");

export default function RecruiterLayout({ children }: { children: React.ReactNode }) {
  return <RecruiterShell>{children}</RecruiterShell>;
}
