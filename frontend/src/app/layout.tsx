import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Devanagari, Noto_Sans_Gujarati } from "next/font/google";
import { SkipLink } from "@/components/language-switcher";
import { I18nProvider } from "@/lib/i18n";
import { getServerLocale, getServerT } from "@/lib/i18n-server";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Inter has no Indic glyphs. These come after Inter in the font stack (globals.css), so Latin text stays
// Inter and only Devanagari/Gujarati characters use Noto. Not preloaded: English visitors never fetch them.
const devanagari = Noto_Sans_Devanagari({ subsets: ["devanagari"], variable: "--font-devanagari", display: "swap", preload: false });
const gujarati = Noto_Sans_Gujarati({ subsets: ["gujarati"], variable: "--font-gujarati", display: "swap", preload: false });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return {
    title: { default: "Resume Intelligence", template: "%s · Resume Intelligence" },
    description: t("meta.description"),
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f6f8fa" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getServerLocale();
  return (
    <html lang={locale} className={`${inter.variable} ${devanagari.variable} ${gujarati.variable}`}>
      <body className="antialiased">
        <I18nProvider initialLocale={locale}>
          <SkipLink />
          <div className="relative z-[1]">{children}</div>
        </I18nProvider>
      </body>
    </html>
  );
}
