import { Suspense } from "react";
import { getServerT } from "@/lib/i18n-server";
import { LoadingBlock } from "@/components/ui";
import { ForgotForm } from "../forms";

export async function generateMetadata() {
  const t = await getServerT();
  return { title: t("auth.meta.forgot") };
}

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ForgotForm />
    </Suspense>
  );
}
