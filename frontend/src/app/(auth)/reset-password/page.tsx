import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { ResetForm } from "../forms";

export const metadata = { title: "Reset password" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ResetForm />
    </Suspense>
  );
}
