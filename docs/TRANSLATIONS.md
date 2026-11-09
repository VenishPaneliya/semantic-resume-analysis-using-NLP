# Interface translations (English, हिन्दी, ગુજરાતી)

The frontend interface is available in English, Hindi and Gujarati. **Only the interface is translated.**
Resumes are still read and analysed in English, and everything that comes from the API — reasons, tips,
explanations, rubric text, role titles, skill names, error messages — is shown as the API sends it, in English.
Pages that show a lot of API text carry one short note in the current language ("Detailed analysis is shown
in English").

> **Status: machine-drafted, not production-ready.** The Hindi and Gujarati text was drafted by an AI model
> and has **not** been reviewed by native speakers. Before this goes to production, a fluent Hindi speaker
> and a fluent Gujarati speaker — ideally people who work in HR / recruiting in India — must review every
> string in `frontend/src/messages/*.ts`, in context in the running app. Pay particular attention to the
> consent and privacy wording (opening applications, AI consent, voluntary self-identification), which has
> legal weight.

## How it works

| Piece | Where |
| --- | --- |
| Locale list, plural/interpolation logic, `defineMessages` | `frontend/src/lib/i18n-core.ts` |
| React provider, `useT()`, `useI18n()`, `t.rich()` | `frontend/src/lib/i18n.tsx` |
| Server helpers (cookie → locale, metadata titles) | `frontend/src/lib/i18n-server.ts` |
| Message catalogs (English + translations side by side) | `frontend/src/messages/*.ts`, merged in `frontend/src/messages/index.ts` |
| Language switcher | `frontend/src/components/language-switcher.tsx` |
| "Shown in English" note | `EnglishNote` in `frontend/src/components/ui.tsx` |

- **No URL routing.** URLs are the same in every language.
- The choice is stored in `localStorage` (`ri_lang`) and a cookie (`ri_lang`). The root layout reads the cookie
  so the server renders `<html lang>` and the first paint in the chosen language; the provider keeps
  `<html lang>` in sync after a switch. The default is English.
- `en` is the source of truth. Each catalog file is `defineMessages({ en: {...}, hi: {...}, gu: {...} })`;
  the type of `hi` and `gu` is derived from `en`, so a missing, extra or misspelt key is a **TypeScript error**.
- Interpolation: `"Hello, {name}"` → `t("dash.helloName", { name })`.
- Plurals: `{ one: "{count} page", other: "{count} pages" }` → `t("common.pages", { count })`. The form is
  chosen with `Intl.PluralRules` for the current language (Hindi and Gujarati treat 0 and 1 as "one").
- Inline markup: `"Go to <link>your dashboard</link>"` → `t.rich(key, { link: (c) => <Link …>{c}</Link> })`.
- Fonts: Inter has no Devanagari or Gujarati glyphs, so `Noto Sans Devanagari` and `Noto Sans Gujarati`
  (via `next/font/google`, not preloaded) sit after Inter in the font stacks. Latin text stays Inter.
  `globals.css` adds a little more line height for `:lang(hi)` / `:lang(gu)` and removes letter-spacing and
  uppercase there, which break Indic shaping.
- Dates are still formatted with the browser's default locale, and numbers use Western digits in every language.

## Style used in the drafts

- Hindi uses formal **आप**; Gujarati uses **તમે** consistently.
- Hindi sentences end with **।**; Gujarati uses the full stop **.**
- Product name (Resume Intelligence), skill names (Python, SQL…), role titles from the backend, file formats
  (PDF, DOCX) and numbers are left as they are.
- Everyday tech loanwords are kept the way Indian users say them instead of forcing Sanskritised terms.

### Glossary

| English | हिन्दी | ગુજરાતી |
| --- | --- | --- |
| resume | रिज़्यूमे | રિઝ્યુમે |
| score | स्कोर | સ્કોર |
| upload | अपलोड | અપલોડ |
| AI | AI | AI |
| sign in / sign out | साइन इन / साइन आउट | સાઇન ઇન / સાઇન આઉટ |
| account | खाता | ખાતું |
| settings | सेटिंग्स | સેટિંગ્સ |
| openings (jobs) | नौकरियाँ | નોકરીઓ |
| an opening | नौकरी / ओपनिंग | નોકરી / ઓપનિંગ |
| application(s) | आवेदन | અરજી / અરજીઓ |
| apply | आवेदन करें | અરજી કરો |
| recruiter | रिक्रूटर | રિક્રૂટર |
| candidate | उम्मीदवार | ઉમેદવાર |
| role (job role) | रोल | રોલ |
| skill(s) | स्किल / स्किल्स | સ્કિલ / સ્કિલ્સ |
| analysis | विश्लेषण | વિશ્લેષણ |
| leaderboard | लीडरबोर्ड | લીડરબોર્ડ |
| version | वर्ज़न | વર્ઝન |
| consent | सहमति | સંમતિ |
| verify (email) | सत्यापित करें | ચકાસો |
| two-factor sign-in | टू-फ़ैक्टर साइन-इन | ટુ-ફેક્ટર સાઇન-ઇન |
| recovery code | रिकवरी कोड | રિકવરી કોડ |
| job description | जॉब डिस्क्रिप्शन | જોબ ડિસ્ક્રિપ્શન |
| suggestion | सुझाव | સૂચન |
| evidence | प्रमाण | પુરાવા |
| stage (pipeline) | स्टेज | સ્ટેજ |
| shortlisted | शॉर्टलिस्ट | શોર્ટલિસ્ટ |

## Terms we were unsure about

Reviewers should decide these first; they recur across many screens.

- **"Extraction" (the first resume tab, the text pulled out of the uploaded file).** Drafted as
  "जानकारी जाँचें" / "માહિતી તપાસો" ("check the information") for the tab, and "निकाली गई जानकारी" /
  "કાઢેલી માહિતી" ("information taken out") in sentences. A literal "एक्सट्रैक्शन" was avoided.
- **"Openings".** Drafted as "नौकरियाँ" / "નોકરીઓ" ("jobs"). HR staff may prefer "ओपनिंग्स" / "ઓપનિંગ્સ".
- **"Role" / "role fit".** Kept as the loanword "रोल" / "રોલ" ("रोल फ़िट"). "भूमिका" / "ભૂમિકા" is the formal word.
- **"Rubric".** Kept as "रूब्रिक" / "રૂબ્રિક"; this may not be understood by candidates.
- **"Targeted variant"** (a resume copy tailored for one role). Drafted as "लक्षित वर्ज़न" / "લક્ષિત વર્ઝન".
- **"Gender"** in self-identification. Drafted as the loanword "जेंडर" / "જેન્ડર"; "लिंग" / "લિંગ" is the formal
  alternative but can read as "sex". The Hindi self-describe option uses "चाहता/चाहती" because Hindi verbs are gendered.
- **"Advisory indicator"** (what scores are). Drafted as "सलाहकारी संकेत" / "સલાહરૂપ સંકેત".
- **"Development fixture — not live AI".** A developer-facing label; translated loosely ("डमी सिस्टम").
- **"Opening" in the staff area** is drafted as "ओपनिंग" / "ઓપનિંગ", while candidate screens say "नौकरी" / "નોકરી".
  Pick one word for both if HR staff and candidates should see the same term.
- **Consent and privacy paraphrases** (needs legal-quality review): "redacted sections" in the AI-consent
  button ("छिपाई गई निजी जानकारी वाले सेक्शन" / "ખાનગી માહિતી છુપાવેલા વિભાગો"), "Retention"
  ("कितने समय तक रखा जाता है" / "કેટલો સમય રાખવામાં આવે છે"), "Voluntary self-identification"
  ("स्वैच्छिक स्व-पहचान" / "સ્વૈચ્છિક સ્વ-ઓળખ"), "anonymous, aggregate fairness checks"
  ("गुमनाम, समग्र निष्पक्षता जाँच" / "અનામી, સમગ્ર નિષ્પક્ષતા તપાસ"), and the opening-application consent sentence.
- **Score bands:** "Stretch" → "थोड़ा दूर" / "થોડું દૂર"; "Compatibility, not probability" → "अनुकूलता, संभावना नहीं" /
  "અનુકૂળતા, સંભાવના નહીં"; recruiter-side "Compatibility score" kept as a loanword ("कम्पैटिबिलिटी स्कोर").
- **Skill evidence:** "listed only" → "सिर्फ़ सूची में" / "માત્ર યાદીમાં"; "demonstrated" → "प्रमाणित" / "સાબિત";
  "preferred" (skill/requirement) → "वांछनीय" / "ઇચ્છનીય" (one Gujarati screen uses "પસંદગીની").
- **Analysis terms:** "Overall indicator" → "कुल संकेतक" / "કુલ સૂચક"; "What-if score" → "बदलाव के बाद का स्कोर" /
  "ફેરફાર પછીનો સ્કોર"; "Semantic alignment" → "अर्थ का मेल" / "અર્થનો મેળ"; "Title signal" → "पद-नाम संकेत" /
  "હોદ્દાના નામનો સંકેત"; "Seniority" kept as a loanword; "Findings" → "बिंदु" / "મુદ્દા"; "Tailor" →
  "…के अनुसार ढालें" / "…મુજબ ઢાળો"; "No keyword stuffing" → "कीवर्ड ठूँसें नहीं" / "કીવર્ડ ઠાંસશો નહીં".
- **Pipeline stages and statuses:** "Not progressing" → "आगे नहीं बढ़ा/रहे" / "આગળ વધ્યું નથી"; "Hired" → "नियुक्त" /
  "નિમણૂક"; "Interviewing" → "इंटरव्यू जारी" / "ઇન્ટરવ્યૂ ચાલુ"; "Withdrawn" → "वापस लिया" / "પાછી ખેંચી";
  "On-site" → "ऑफ़िस से" / "ઑફિસથી".
- **Fairness report:** "Impact ratio" kept as a loanword; "four-fifths rule" → "चार-पाँचवाँ नियम" / "ચાર-પંચમાંશ નિયમ";
  "median" → "मीडियन" / "મધ્યક".
- **Gendered first person in Hindi** ("मैं … करता/करती हूँ") appears in a few checkbox labels; a reviewer may prefer a
  neutral rephrasing.
- **"Resume health"** → "रिज़्यूमे की सेहत" / "રિઝ્યુમેની તંદુરસ્તી" — may sound too literal.

## Adding a language

1. Add its code to `LOCALES` in `frontend/src/lib/i18n-core.ts` and its name, written in its own script, to
   `LOCALE_NAMES`.
2. Run `npx tsc --noEmit`. Every catalog in `frontend/src/messages/` now fails to compile until it has the new
   locale's block with every key — that list is your to-do list. Add the block to each `defineMessages({...})`,
   then add the locale to `hi`/`gu`-style exports in `frontend/src/messages/index.ts` and to `dictionaries`.
3. If the script is not covered by Inter, add a matching Noto font in `frontend/src/app/layout.tsx` and put its
   CSS variable into `--font-sans` / `--font-display` in `frontend/src/app/globals.css` after Inter, and extend
   the `:lang(…)` rules there.
4. For a right-to-left language you would also need `dir="rtl"` on `<html>` and a layout review; that is not
   handled today.
5. Run `frontend/e2e/i18n.mjs` (extend its `LOCALES` list) to check every page for overflow and console errors,
   and look at the screenshots it writes.
6. Have a native speaker review it before shipping.

## Adding or changing text

- Add the English string to the catalog for that area (keys are prefixed by area: `dash.`, `auth.`, …), then
  the same key in `hi` and `gu`. TypeScript will refuse to build until all three exist.
- Never translate text that comes from the API; show it as is. If a page shows a lot of it, use `<EnglishNote />`.
- Mark new translations for native review (e.g. in the pull request) — the machine-drafted status above applies
  to anything added later the same way.
