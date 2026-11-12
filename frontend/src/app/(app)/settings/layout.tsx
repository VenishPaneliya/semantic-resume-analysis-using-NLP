import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("nav.settings");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
