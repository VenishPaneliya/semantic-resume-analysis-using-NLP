import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="eyebrow">404</p>
      <h1 className="text-3xl">This page does not exist</h1>
      <p className="text-sm text-ink-2">It may have been deleted, or the link is wrong.</p>
      <Link href="/dashboard" className="btn btn-primary">
        Back to your resumes
      </Link>
    </main>
  );
}
