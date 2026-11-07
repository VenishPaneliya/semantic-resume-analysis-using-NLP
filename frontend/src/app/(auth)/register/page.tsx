import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { RegisterForm } from "../forms";

export const metadata = { title: "Create account" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <RegisterForm />
    </Suspense>
  );
}
