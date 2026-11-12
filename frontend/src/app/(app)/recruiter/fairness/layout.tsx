import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("rec.sub.fairness");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
