"""Provider-independent LLM adapter.

Every provider implements `complete_json(system, user, schema_name) -> LLMResult`. The
`fixture` provider is deterministic, sends nothing externally, and is always labelled as a
development fixture in API responses and the UI. `disabled` raises LLMUnavailable.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass

import httpx

from app.config import get_settings


class LLMUnavailable(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int

    @property
    def is_fixture(self) -> bool:
        return self.provider == "fixture"


class Provider:
    name = "base"
    sends_data_externally = True

    def __init__(self, model: str) -> None:
        self.model = model

    def complete_json(self, system: str, user: str, *, operation: str, max_tokens: int = 1200) -> LLMResult:
        raise NotImplementedError


def _extract_json(text: str) -> str:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        return m.group(1)
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start >= 0 and end > start else text


class AnthropicProvider(Provider):
    name = "anthropic"

    def complete_json(self, system: str, user: str, *, operation: str, max_tokens: int = 1200) -> LLMResult:
        s = get_settings()
        if not s.anthropic_api_key:
            raise LLMUnavailable("provider_not_configured", "ANTHROPIC_API_KEY is not set.")
        t0 = time.perf_counter()
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            # the system prompt is static per prompt version, so it is cached across calls
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
        }
        try:
            r = httpx.post(
                f"{s.anthropic_base_url}/v1/messages",
                headers={"x-api-key": s.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json=body,
                timeout=s.llm_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise LLMUnavailable("provider_unreachable", "The AI provider could not be reached.") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise LLMUnavailable("provider_busy", f"The AI provider is temporarily unavailable ({r.status_code}).")
        if r.status_code >= 400:
            raise LLMUnavailable("provider_error", f"The AI provider rejected the request ({r.status_code}).")
        data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        u = data.get("usage", {})
        return LLMResult(
            _extract_json(text), self.name, data.get("model", self.model),
            int(u.get("input_tokens", 0)) + int(u.get("cache_read_input_tokens", 0)) + int(u.get("cache_creation_input_tokens", 0)),
            int(u.get("output_tokens", 0)), int((time.perf_counter() - t0) * 1000),
        )


class OpenAIProvider(Provider):
    name = "openai"

    def complete_json(self, system: str, user: str, *, operation: str, max_tokens: int = 1200) -> LLMResult:
        s = get_settings()
        if not s.openai_api_key:
            raise LLMUnavailable("provider_not_configured", "OPENAI_API_KEY is not set.")
        t0 = time.perf_counter()
        try:
            r = httpx.post(
                f"{s.openai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {s.openai_api_key}"},
                json={
                    "model": self.model,
                    "max_tokens": max_tokens,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                },
                timeout=s.llm_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise LLMUnavailable("provider_unreachable", "The AI provider could not be reached.") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise LLMUnavailable("provider_busy", f"The AI provider is temporarily unavailable ({r.status_code}).")
        if r.status_code >= 400:
            raise LLMUnavailable("provider_error", f"The AI provider rejected the request ({r.status_code}).")
        data = r.json()
        u = data.get("usage", {})
        return LLMResult(
            _extract_json(data["choices"][0]["message"]["content"]), self.name, data.get("model", self.model),
            int(u.get("prompt_tokens", 0)), int(u.get("completion_tokens", 0)), int((time.perf_counter() - t0) * 1000),
        )


class DisabledProvider(Provider):
    name = "disabled"
    sends_data_externally = False

    def complete_json(self, system: str, user: str, *, operation: str, max_tokens: int = 1200) -> LLMResult:
        raise LLMUnavailable("ai_disabled", "AI features are disabled on this server.")


class FixtureProvider(Provider):
    """Deterministic development stand-in. Produces conservative, rule-based edits so that
    the full suggestion → grounding → diff → accept flow can be exercised without
    credentials. Output is labelled `provider: fixture` everywhere."""

    name = "fixture"
    sends_data_externally = False

    WEAK = re.compile(r"^(responsible for|worked on|helped( to)?|assisted (in|with)|involved in|duties included|tasked with|participated in)\s+", re.I)
    VERB_FOR = {"responsible for": "Managed", "worked on": "Developed", "helped": "Supported", "helped to": "Supported",
                "assisted in": "Supported", "assisted with": "Supported", "involved in": "Contributed to",
                "duties included": "Handled", "tasked with": "Delivered", "participated in": "Contributed to"}

    def __init__(self, model: str = "fixture-v1") -> None:
        super().__init__("fixture-v1")

    def complete_json(self, system: str, user: str, *, operation: str, max_tokens: int = 1200) -> LLMResult:
        t0 = time.perf_counter()
        payload = json.loads(re.search(r"<task_json>(.*?)</task_json>", user, re.S).group(1))  # type: ignore[union-attr]
        out = getattr(self, f"_op_{operation}", self._op_default)(payload)
        text = json.dumps(out)
        return LLMResult(text, self.name, self.model, len(user) // 4, len(text) // 4, int((time.perf_counter() - t0) * 1000))

    # -- helpers
    def _polish(self, t: str) -> tuple[str, list[str]]:
        notes = []
        t = re.sub(r"\s+", " ", t).strip()
        m = self.WEAK.match(t)
        if m:
            phrase = m.group(0).strip().lower()
            verb = self.VERB_FOR.get(phrase, "Delivered")
            t = verb + " " + t[m.end():]
            notes.append(f"Replaced the duty phrase “{m.group(0).strip()}” with an action verb.")
        t = re.sub(r"\b(I|my)\s+", "", t)
        if t and t[0].islower():
            t = t[0].upper() + t[1:]
            notes.append("Capitalised the first word.")
        if t and not t.endswith((".", "!", "?", "]")):
            t += "."
        return t, notes

    def _op_rewrite_bullet(self, p: dict) -> dict:
        revised = []
        notes: list[str] = []
        questions: list[str] = []
        for item in p["items"]:
            t, n = self._polish(item["text"])
            notes += n
            if not re.search(r"\d", t):
                t = t.rstrip(".") + " [ADD: measurable result, e.g. time saved or users served]."
                questions.append(f"What measurable result did this have? (“{item['text'][:60]}”)")
            revised.append({"target_id": item["id"], "text": t})
        if notes or questions:
            expl = " ".join(dict.fromkeys(notes + (["Added a placeholder for a verifiable outcome."] if questions else [])))
        else:
            expl = "No changes proposed: the rule-based fixture found nothing to adjust."
        return {"revised": revised, "explanation": expl, "questions": questions}

    def _op_grammar(self, p: dict) -> dict:
        revised = []
        for item in p["items"]:
            t = re.sub(r"\s+([,.;:])", r"\1", re.sub(r"\s+", " ", item["text"])).strip()
            t = re.sub(r"\bi\b", "I", t)
            if t and t[0].islower():
                t = t[0].upper() + t[1:]
            if t and not t.endswith((".", "!", "?")):
                t += "."
            revised.append({"target_id": item["id"], "text": t})
        return {"revised": revised, "explanation": "Fixed spacing, capitalisation and end punctuation.", "questions": []}

    def _op_shorten(self, p: dict) -> dict:
        revised = []
        for item in p["items"]:
            t = item["text"]
            t = re.sub(r"\b(successfully|effectively|various|in order to|basically|really|very)\b\s*", "", t, flags=re.I)
            t = re.sub(r"\s+", " ", t).strip()
            words = t.split()
            if len(words) > 28:
                cut = re.split(r"[;,]\s", t)
                t = cut[0].rstrip(".") + "."
            revised.append({"target_id": item["id"], "text": t})
        return {"revised": revised, "explanation": "Removed filler words and secondary clauses.", "questions": []}

    def _op_tone(self, p: dict) -> dict:
        return self._op_rewrite_bullet(p) if p.get("tone") != "concise" else self._op_shorten(p)

    def _op_tailor(self, p: dict) -> dict:
        out = self._op_rewrite_bullet(p)
        out["explanation"] = (out["explanation"] + " Tailoring kept to wording only; the fixture does not add skills or keywords.").strip()
        return out

    def _op_improve_summary(self, p: dict) -> dict:
        facts = p.get("facts", {})
        title = facts.get("latest_title") or "Professional"
        skills = ", ".join(facts.get("top_skills", [])[:4])
        years = facts.get("years")
        lead = f"{title} with {years} years of experience" if years else f"{title}"
        text = f"{lead}{' working with ' + skills if skills else ''}. [ADD: one concrete achievement you are proud of]."
        return {"revised": [{"target_id": "summary", "text": text}],
                "explanation": "Built a short summary from your confirmed title, experience and skills.",
                "questions": ["Which single achievement best represents your work?"]}

    def _op_cover_letter(self, p: dict) -> dict:
        f = p.get("facts", {})
        role = p.get("target", {}).get("title") or "the role"
        company = p.get("target", {}).get("company") or "your team"
        skills = ", ".join(f.get("top_skills", [])[:3])
        paras = [
            f"I am applying for {role} at {company}.",
            f"In my most recent role as {f.get('latest_title') or '[ADD: your current title]'}, I have worked with {skills or '[ADD: key skills]'}.",
            f.get("best_bullet") and f"For example: {f['best_bullet']}" or "[ADD: one specific example of relevant work].",
            "I would welcome the chance to discuss how my experience fits your needs.",
        ]
        return {"paragraphs": paras, "questions": ["Why are you interested in this company specifically?"]}

    def _op_interview_questions(self, p: dict) -> dict:
        qs = []
        for b in p.get("items", [])[:5]:
            qs.append({"question": f"Walk me through this: “{b['text'][:120]}”. What was your specific contribution?",
                       "why": "Interviewers probe resume claims for depth and ownership.", "based_on": b["id"]})
        for s in p.get("gaps", [])[:3]:
            qs.append({"question": f"This role uses {s}. How would you get up to speed?", "why": "The posting lists a skill your resume does not show.", "based_on": "job_description"})
        return {"questions": qs}

    def _op_default(self, p: dict) -> dict:
        return {"revised": [], "explanation": "No change.", "questions": []}


def get_provider() -> Provider:
    s = get_settings()
    if s.llm_provider == "anthropic":
        return AnthropicProvider(s.llm_model)
    if s.llm_provider == "openai":
        return OpenAIProvider(s.llm_model)
    if s.llm_provider == "disabled":
        return DisabledProvider("none")
    return FixtureProvider()
