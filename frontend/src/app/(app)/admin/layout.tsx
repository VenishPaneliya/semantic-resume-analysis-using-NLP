import { pageTitle } from "@/lib/i18n-server";

export const generateMetadata = () => pageTitle("nav.admin");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
