import { Suspense } from "react";
import { getServerT } from "@/lib/i18n-server";
import { LoadingBlock } from "@/components/ui";
import { ResetForm } from "../forms";

export async function generateMetadata() {
  const t = await getServerT();
  return { title: t("auth.meta.reset") };
}

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ResetForm />
    </Suspense>
  );
}
