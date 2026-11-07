"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "./api";

/** Fetch-on-mount with explicit loading / error / retry state. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const d = await api<T>(path);
      if (my === seq.current) setData(d);
    } catch (e) {
      if (my === seq.current) {
        setError(errMsg(e));
        setErrorCode((e as { code?: string }).code ?? null);
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, setData, error, errorCode, loading, reload: load };
}

/** Async action with pending + error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(errMsg(e));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, setError };
}
