import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { ForgotForm } from "../forms";

export const metadata = { title: "Forgot password" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ForgotForm />
    </Suspense>
  );
}
