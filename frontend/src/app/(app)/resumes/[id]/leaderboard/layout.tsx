import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("resume.tab.leaderboard");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
