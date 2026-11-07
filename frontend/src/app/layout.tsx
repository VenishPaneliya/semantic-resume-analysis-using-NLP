import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Resume Intelligence", template: "%s · Resume Intelligence" },
  description: "Evidence-backed resume analysis, role recommendations and grounded AI editing.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f6f8fa" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <div className="relative z-[1]">{children}</div>
      </body>
    </html>
  );
}
