import { Suspense } from "react";
import { LoadingBlock } from "@/components/ui";
import { VerifyEmail } from "../forms";

export const metadata = { title: "Verify email" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <VerifyEmail />
    </Suspense>
  );
}
