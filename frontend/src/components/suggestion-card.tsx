"use client";

import { Check, HelpCircle, PencilLine, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { api, errMsg } from "@/lib/api";
import type { Suggestion } from "@/lib/types";
import { DiffView, WithPlaceholders } from "./preview";
import { AIBadge, Alert, Badge, FixtureBadge, Spinner } from "./ui";

const OP_LABEL: Record<string, string> = {
  rewrite_bullet: "Rewrite",
  improve_summary: "Improve summary",
  shorten: "Shorten",
  grammar: "Grammar",
  tailor: "Tailor",
  tone: "Adjust tone",
};

export function SuggestionCard({ s, onResolved }: { s: Suggestion; onResolved: (r: { accepted: boolean; versionId?: string }) => void }) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>(Object.fromEntries(s.items.map((i) => [i.target_id, i.after])));
  const unsupported = s.grounding.unsupported ?? [];
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = s.status === "pending" || s.status === "needs_facts";
  const needsConfirm = unsupported.filter((u) => !confirmed[u.value]);
  const editedAny = s.items.some((i) => edits[i.target_id] !== i.after);

  async function accept() {
    setPending("accept");
    setError(null);
    try {
      const r = await api<{ version_id: string }>(`/api/suggestions/${s.id}/accept`, {
        body: {
          confirmed_facts: unsupported.filter((u) => confirmed[u.value]).map((u) => u.value),
          edited_items: editedAny ? s.items.map((i) => ({ target_id: i.target_id, text: edits[i.target_id] })) : null,
        },
      });
      onResolved({ accepted: true, versionId: r.version_id });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }
  async function reject() {
    setPending("reject");
    try {
      await api(`/api/suggestions/${s.id}/reject`, { method: "POST" });
      onResolved({ accepted: false });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="ai-surface p-4" aria-label={`AI suggestion: ${OP_LABEL[s.operation] ?? s.operation}`}>
      <div className="flex flex-wrap items-center gap-2">
        <AIBadge>{open ? "AI suggestion — not applied" : `AI suggestion — ${s.status}`}</AIBadge>
        <Badge>{OP_LABEL[s.operation] ?? s.operation}</Badge>
        <FixtureBadge show={s.is_fixture} />
        {s.status === "needs_facts" && (
          <Badge tone="warn">
            <ShieldAlert className="h-3 w-3" aria-hidden /> Needs your facts
          </Badge>
        )}
      </div>

      <div className="mt-3 space-y-3">
        {s.items.map((it) => (
          <div key={it.target_id} className="rounded-md bg-white/80 p-3">
            <p className="eyebrow mb-1">Change</p>
            {it.before.trim() === it.after.trim() ? (
              <p className="text-sm text-muted">No changes proposed — this text already meets the guidance for this action.</p>
            ) : (
              <DiffView ops={it.diff} />
            )}
            {editing && open ? (
              <div className="mt-2">
                <label className="label" htmlFor={`edit-${s.id}-${it.target_id}`}>
                  Edit before accepting
                </label>
                <textarea
                  id={`edit-${s.id}-${it.target_id}`}
                  className="input"
                  rows={3}
                  value={edits[it.target_id]}
                  onChange={(e) => setEdits({ ...edits, [it.target_id]: e.target.value })}
                />
              </div>
            ) : (
              <p className="mt-2 text-sm">
                <span className="eyebrow mr-1">After</span>
                <WithPlaceholders text={edits[it.target_id]} />
              </p>
            )}
          </div>
        ))}
      </div>

      {s.explanation && (
        <p className="mt-3 text-sm text-ink-2">
          <strong>Why:</strong> {s.explanation}
        </p>
      )}

      {s.placeholders.length > 0 && (
        <p className="mt-2 text-xs text-ai">Placeholders mark facts only you can provide. Replace them before sending your resume — exports flag any left over.</p>
      )}

      {unsupported.length > 0 && open && (
        <fieldset className="mt-3 rounded-md border border-[#ecc89c] bg-warn-soft p-3">
          <legend className="px-1 text-sm font-semibold text-warn">Not in your confirmed resume</legend>
          <p className="mb-2 text-xs text-warn">
            Tick only what is true — your confirmation is recorded. Otherwise edit the text to remove it.
          </p>
          {unsupported.map((u) => (
            <label key={u.type + u.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!confirmed[u.value]} onChange={(e) => setConfirmed({ ...confirmed, [u.value]: e.target.checked })} />
              “{u.value}” <span className="text-xs text-muted">({u.type})</span> is accurate
            </label>
          ))}
        </fieldset>
      )}

      {s.questions.length > 0 && open && (
        <div className="mt-3">
          <p className="flex items-center gap-1 text-xs font-semibold text-ink-2">
            <HelpCircle className="h-3.5 w-3.5" aria-hidden /> Questions for you
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
            {s.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}

      {open && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary btn-sm" onClick={accept} disabled={!!pending || (needsConfirm.length > 0 && !editedAny)}>
            {pending === "accept" ? <Spinner label="Applying" /> : (<><Check className="h-4 w-4" aria-hidden /> Accept{editedAny ? " edited" : ""}</>)}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
            <PencilLine className="h-4 w-4" aria-hidden /> {editing ? "Done editing" : "Edit"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={reject} disabled={!!pending}>
            <X className="h-4 w-4" aria-hidden /> Reject
          </button>
        </div>
      )}
      {open && needsConfirm.length > 0 && !editedAny && (
        <p className="mt-2 text-xs text-muted">Accept is disabled until each flagged detail is confirmed or edited out.</p>
      )}
      <p className="mt-3 num text-[10px] text-muted">
        {s.provider} · {s.model} · {s.prompt_version}
      </p>
    </article>
  );
}
