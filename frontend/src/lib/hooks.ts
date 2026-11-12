"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "./api";

/* Data that never changes while the app is open (role taxonomy, rubric, export templates, provider
   status). Kept for the browser session so switching resume tabs doesn't fetch it again. */
const staticCache = new Map<string, unknown>();

/** Fetch-on-mount with explicit loading / error / retry state.
    `{ static: true }`: remember the response for the rest of the session (only for data that doesn't
    depend on the user's own actions); reload() still refetches. */
export function useApi<T>(path: string | null, deps: unknown[] = [], opts: { static?: boolean } = {}) {
  const cached = opts.static && path ? (staticCache.get(path) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path && cached === undefined);
  const seq = useRef(0);
  const isStatic = !!opts.static;

  const load = useCallback(async (force = true) => {
    if (!path) return;
    if (isStatic && !force && staticCache.has(path)) {
      setData(staticCache.get(path) as T);
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const d = await api<T>(path);
      if (isStatic) staticCache.set(path, d);
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
  }, [path, isStatic, ...deps]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  return { data, setData, error, errorCode, loading, reload };
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
