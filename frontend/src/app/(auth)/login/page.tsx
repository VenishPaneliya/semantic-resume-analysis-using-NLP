import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { LoginForm } from "../forms";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LoginForm />
    </Suspense>
  );
}
