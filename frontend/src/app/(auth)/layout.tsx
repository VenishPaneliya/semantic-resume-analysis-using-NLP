import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/shell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <Logo />
        <LanguageSwitcher />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-14">
        <div className="card rise w-full max-w-md p-6 sm:p-8">{children}</div>
      </main>
    </div>
  );
}
