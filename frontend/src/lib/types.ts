/* Hand-written response shapes mirroring backend/app/api/* and docs/openapi.json. */

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: "user" | "recruiter" | "admin";
  email_verified: boolean;
  ai_consent_provider: string | null;
  has_password: boolean;
  notification_prefs: Record<string, boolean | number | string | null>;
  career_prefs: CareerPrefs;
  mfa_enabled?: boolean;
  mfa_required_for_role?: boolean;
}

export interface CareerPrefs {
  target_roles?: string[];
  domains?: string[];
  locations?: string[];
  work_arrangements?: ("remote" | "hybrid" | "onsite")[];
}

// ---------------------------------------------------------------- resume content
export interface Link { label: string; url: string }
export interface Contact { name: string | null; email: string | null; phone: string | null; location: string | null; links: Link[] }
export interface Bullet { id: string; text: string }
export type EmploymentType = "full_time" | "part_time" | "internship" | "contract" | "freelance" | "unknown";
export interface Experience {
  id: string; title: string | null; organization: string | null; location: string | null;
  start: string | null; end: string | null; current: boolean; employment_type: EmploymentType; bullets: Bullet[];
}
export interface Education {
  id: string; degree: string | null; field_of_study: string | null; institution: string | null; location: string | null;
  start: string | null; end: string | null; grade: string | null; details: string[];
}
export interface Project { id: string; name: string; url: string | null; start: string | null; end: string | null; technologies: string[]; bullets: Bullet[] }
export interface Skills { technical: string[]; soft: string[]; other: string[] }
export interface Certification { id: string; name: string; issuer: string | null; date: string | null; url: string | null }
export interface SimpleItem { id: string; text: string }
export interface LanguageItem { id: string; name: string; proficiency: string | null }
export type SectionKey = "summary" | "experience" | "projects" | "education" | "skills" | "certifications" | "achievements" | "languages";
export interface ResumeContent {
  contact: Contact; summary: string | null; experience: Experience[]; education: Education[]; projects: Project[];
  skills: Skills; certifications: Certification[]; achievements: SimpleItem[]; languages: LanguageItem[]; section_order: SectionKey[];
}

// ---------------------------------------------------------------- resumes
export interface JobState {
  id: string; status: "queued" | "running" | "succeeded" | "failed"; stage: string | null; progress: number;
  attempts: number; max_attempts: number; error_code: string | null; error_message: string | null;
}
export interface Resume {
  id: string; title: string; original_filename: string; file_kind: "pdf" | "docx"; size_bytes: number; page_count: number | null;
  status: "uploaded" | "processing" | "needs_review" | "ready" | "failed"; error_code: string | null; error_message: string | null;
  created_at: string; latest_version_id: string | null; latest_version_number: number | null; source_resume_id: string | null;
  target_role: string | null; job: JobState | null;
}
export interface Evidence { page: number | null; start: number; end: number; text: string }
export interface Extraction {
  resume_id: string; status: string; content: ResumeContent; evidence: Record<string, Evidence>; confidence: Record<string, number>;
  uncertain: { path: string; reason: string }[]; detected_sections: string[]; unparsed_sections: { section: string; reason: string }[];
  unrecognized_skills: string[]; warnings: string[]; layout: Record<string, unknown>; ocr_used: boolean;
  parser_version: string; extractor_version: string;
}

export interface Version {
  id: string; resume_id: string; number: number; label: string | null; source: "extracted" | "user_edit" | "ai_accepted" | "restore";
  parent_id: string | null; created_at: string; content_hash: string; target_role: string | null; is_latest: boolean; content: ResumeContent | null;
}

// ---------------------------------------------------------------- analysis
export interface EvidenceRef { path: string; text: string }
export interface Finding { rule: string; message: string; points: number; why: string; suggestion: string; effort: string; evidence: EvidenceRef[] }
export interface Category {
  id: string; name: string; weight: number; status: "scored" | "insufficient_data" | "not_applicable"; score: number | null;
  findings: Finding[]; notes: string[];
}
export interface Improvement {
  issue: string; category: string; rule: string; why: string; evidence: EvidenceRef[]; suggestion: string;
  priority: "high" | "medium" | "low"; effort: "low" | "medium" | "high"; impact: number;
}
export interface KeywordCoverage {
  role_id: string; role_title: string; required: { skill: string; status: string }[]; preferred: { skill: string; status: string }[];
  required_coverage: number | null; preferred_coverage: number | null; note: string;
}
export interface AnalysisResult {
  rubric_version: string; taxonomy_version: string; overall: number | null; overall_label: string; categories: Category[];
  not_extracted: { section: string; message: string }[]; improvements: Improvement[]; role_keyword_coverage: KeywordCoverage | null;
  timeline: { professional_years: number; internship_months: number; effective_years: number };
  stats: Record<string, number>; analysis_id: string; cached: boolean; created_at: string;
}
export interface Rubric {
  version: string; disclaimer: string; scoring: string;
  categories: { id: string; name: string; weight: number }[];
  rules: { id: string; category: string; max_points: number | string; why: string; suggestion: string; effort: string }[];
}

export interface Role {
  id: string; title: string; description: string; required_skills: string[]; preferred_skills: string[];
  responsibilities: string[]; related_titles: string[]; domains: string[];
}
export interface Seniority {
  estimate: string; label: string; plausible_range: string[]; effective_years: number; years_range: [number, number];
  basis: string[]; uncertainty: "low" | "medium" | "high"; note: string;
}
export interface Recommendation {
  role_id: string; title: string; description: string; related_titles: string[]; fit_score: number; preference_adjustment: number;
  preference_reasons: string[]; confidence: "low" | "medium" | "high";
  components: { required_coverage: number; preferred_coverage: number; semantic: number; semantic_raw_cosine: number; title_signal: number };
  matched_skills: { skill: string; evidence: (EvidenceRef & { via?: string })[] }[]; weak_skills: { skill: string; reason: string }[];
  missing_required: string[]; missing_preferred: string[]; possibly_unlisted: { skill: string; because_you_have: string[] }[];
  reasons: string[]; next_steps: string[]; rank: number;
}
export interface Recommendations {
  status: "ok" | "insufficient_evidence"; message?: string; recommender_version: string; embedding_model: string; taxonomy_version: string;
  weights: Record<string, number>; disclaimer: string; seniority: Seniority; preferences_applied: Record<string, unknown>;
  recommendations: Recommendation[]; tentative?: { role_id: string; title: string; fit_score: number; confidence: string }[];
  all_scores?: { role_id: string; title: string; fit_score: number }[]; preference_note?: string; cached: boolean;
}

// ---------------------------------------------------------------- JD
export interface JDRequirement {
  id: string; text: string; kind: "skill" | "experience" | "education" | "certification" | "unassessable" | "other";
  importance: "required" | "preferred"; skills: string[]; any_of: boolean;
}
export interface JD {
  id: string; title: string; company: string | null; source: string; created_at: string; text?: string;
  extracted: {
    title: string | null; company: string | null; responsibilities: string[]; requirements: JDRequirement[]; skills: string[];
    years_required: number | null; education: string | null; location: string | null; work_arrangement: string | null; warnings: string[];
  };
}
export interface MatchRow extends JDRequirement {
  status: "matched" | "partial" | "missing" | "unknown"; explanation: string; evidence: (EvidenceRef & { similarity?: number })[];
  gap_type: "genuine_gap" | "possibly_unlisted" | null; closest_evidence: (EvidenceRef & { similarity: number })[];
}
export interface MatchResult {
  matcher_version: string; embedding_model: string; overall: number | null; overall_label: string; formula: string;
  components: { requirement_coverage: number | null; keyword_coverage: number | null; semantic_alignment: number; semantic_raw_cosine: number; experience_alignment: string };
  counts: Record<"matched" | "partial" | "missing" | "unknown", number>; requirements: MatchRow[];
  keywords: { present: string[]; absent: string[] }; genuine_gaps: string[]; possibly_unlisted: string[]; guidance: string;
  jd_warnings: string[]; cached: boolean; jd: JD;
}

// ---------------------------------------------------------------- AI
export type DiffOp = { op: "equal" | "insert" | "delete"; text: string };
export interface Grounding { grounded: boolean; unsupported: { type: string; value: string }[]; placeholders: string[]; version?: string }
export interface SuggestionItem { target_id: string; before: string; after: string; diff: DiffOp[]; grounding: Grounding }
export interface Suggestion {
  id: string; version_id: string; operation: string; target_path: string;
  status: "pending" | "needs_facts" | "accepted" | "rejected" | "superseded"; items: SuggestionItem[]; explanation: string;
  questions: string[]; placeholders: string[]; grounding: { grounded: boolean; unsupported: { type: string; value: string }[] };
  provider: string; model: string; prompt_version: string; is_fixture: boolean; label: string; fixture_notice: string | null;
  applied_version_id: string | null; created_at: string;
}
export interface Compare {
  a: { id: string; number: number; label: string | null }; b: { id: string; number: number; label: string | null };
  overall: { a: number | null; b: number | null };
  categories: { id: string; name: string; a: number | null; b: number | null; delta: number | null }[];
  changes: { path: string; change?: string; before?: string | null; after?: string | null; diff?: DiffOp[]; added?: string[]; removed?: string[] }[];
}

export interface ExportRow {
  id: string; version_id: string; format: "pdf" | "docx"; template: string; page_size: "A4" | "LETTER"; status: string;
  page_count: number | null; unresolved_placeholders: { path: string; placeholder: string }[]; error_message: string | null; created_at: string;
}
export interface Template { id: string; name: string; description: string; recommended_order: SectionKey[] }

// ---------------------------------------------------------------- career
export interface GapRow { skill: string; importance: "required" | "preferred"; state: "demonstrated" | "listed_only" | "gap"; related_evidence: string[]; evidence: EvidenceRef[] }
export interface SkillGap { role_id: string; title: string; skills: GapRow[]; summary: Record<"demonstrated" | "listed_only" | "gap", number> }
export interface ResourceLookup { status: "ok" | "empty" | "unavailable"; provider: string | null; message?: string; resources?: { title: string; url: string; source?: string; retrieved_on: string }[] }
export interface Roadmap {
  status: "ok" | "insufficient_evidence"; message?: string;
  roles?: { role_id: string; title: string; summary: Record<string, number> }[];
  steps: { skill: string; importance: string; state: string; for_role: string; phase: "now" | "next" | "later"; action: string; resources: ResourceLookup }[];
  portfolio_projects?: { title: string; brief: string; evidence: string; skills: string[]; builds_evidence_for: string[] }[];
  resource_provider?: string;
}
export interface CareerArtifact {
  id: string; kind: string; version_id: string | null; jd_id: string | null; provider: string; model: string; is_fixture: boolean; created_at: string;
  content: {
    questions?: { question: string; why: string; based_on: string }[] | string[]; note?: string | null;
    paragraphs?: string[]; grounding?: Grounding; status?: "grounded" | "needs_review";
  };
}

export interface Application {
  id: string; company: string; role: string; status: "saved" | "applied" | "interviewing" | "offer" | "rejected" | "withdrawn";
  applied_on: string | null; next_step_on: string | null; location: string | null; url: string | null; notes: string | null;
  resume_version_id: string | null; jd_id: string | null; created_at: string; updated_at: string;
}

export interface Privacy {
  ai_provider: string; ai_model: string; sends_data_externally: boolean; consented: boolean; consented_at: string | null;
  what_is_sent: string; training_use: string; retention_days: { files: number; analyses: number }; fixture_notice: string | null;
}

// ---------------------------------------------------------------- leaderboards, openings, tips
export type TierId = "strong" | "good" | "stretch" | "unrelated" | "unknown";
export interface Tier { id: TierId; label: string; help: string; tips_available?: boolean }
export interface TierBand { min: number; id: TierId; label: string }

export interface RoleRow {
  rank: number; role_id: string; title: string; description: string; score: number; tier: Tier; confidence: "low" | "medium" | "high";
  core_coverage: number | null; tips_available: boolean; tips_blocked_reason: string | null;
  components: { required_coverage: number; preferred_coverage: number; semantic: number; semantic_raw_cosine: number; title_signal: number };
  keywords_matched: string[]; keywords_weak: string[]; keywords_missing: string[]; missing_required: string[]; reasons: string[];
  possibly_unlisted: { skill: string; because_you_have: string[] }[]; next_steps: string[];
  /** rows are ordered by score + this adjustment from the user's target roles / domains; the score itself is unchanged */
  preference_adjustment: number; preference_reasons: string[];
}
export interface RoleLeaderboard {
  status: "ok" | "insufficient_evidence"; message?: string; leaderboard_version: string; embedding_model: string; taxonomy_version: string;
  tips_min_score: number; tips_min_core_coverage: number; tiers: TierBand[]; disclaimer: string; rows: RoleRow[]; seniority: Seniority;
}

export type WorkArrangement = "onsite" | "hybrid" | "remote";
export type OpeningEmployment = "full_time" | "part_time" | "contract" | "internship";
export interface Opening {
  id: string; title: string; company: string; location: string | null; work_arrangement: WorkArrangement | null;
  employment_type: OpeningEmployment | null; status: "open" | "closed"; role_id: string | null; role_title: string | null;
  is_demo: boolean; skills: string[]; years_required: number | null; created_at: string; updated_at: string;
}
export interface OpeningFull extends Opening {
  description: string; requirements: { text: string; importance: "required" | "preferred"; kind: string }[]; responsibilities: string[];
}
export interface OpeningRow extends Opening {
  rank: number; score: number | null; tier: Tier; core_coverage: number | null; tips_available: boolean; tips_blocked_reason: string | null;
  keywords_matched: string[]; keywords_missing: string[]; counts: Record<"matched" | "partial" | "missing" | "unknown", number>;
  genuine_gaps: string[]; possibly_unlisted: string[];
  application: { score: number; stage: ApplicationStage; version_id: string } | null;
}
export interface OpeningLeaderboard {
  status: "ok" | "no_openings"; message: string | null; leaderboard_version: string; matcher_version: string; disclaimer: string; rows: OpeningRow[];
}

export type ApplicationStage = "submitted" | "shortlisted" | "interview" | "offer" | "hired" | "rejected";
export const STAGES: ApplicationStage[] = ["submitted", "shortlisted", "interview", "offer", "hired", "rejected"];
export type Standing =
  | { available: false; applicants: number; min_pool?: number; message: string }
  | {
      available: true; rank: number; applicants: number; top_percent: number; my_score: number;
      /** null below distribution_min_pool applicants: with few people these would reveal others' scores */
      median: number | null; distribution_min_pool: number;
      /** count is null for a band with 1-2 people ("a few") */
      distribution: { from: number; to: number; count: number | null }[] | null; note: string;
    };
export interface OpeningApplicationOut {
  id: string; version_id: string; score: number; tier: Tier; stage: ApplicationStage; applied_at: string; updated_at: string; standing: Standing;
}
export type OpeningMatch = Omit<MatchResult, "jd" | "cached"> & { version_id: string; tier: Tier };
export interface OpeningDetail extends OpeningFull {
  application: OpeningApplicationOut | null;
  match: OpeningMatch | null;
}
export interface MyOpeningApplication extends OpeningApplicationOut { opening: Opening }

export interface TipAction { type: "ai"; operation: "rewrite_bullet" | "tailor" | "improve_summary"; target_path: string; target_role?: string; opening_id?: string }
export interface Tip {
  id: string; kind: string; priority: "high" | "medium" | "low"; title: string; detail: string; path?: string; action?: TipAction; skill?: string;
}
export interface Tips {
  target: { kind: "role" | "opening"; id: string; title: string }; score: number | null; tier: Tier; eligible: boolean; tips_min_score: number;
  core_coverage: number | null; gate_message?: string; message?: string; tips: Tip[];
  learning_path: { skill: string; importance: "required" | "preferred"; why: string }[]; honesty_note: string;
}

// ---------------------------------------------------------------- recruiter
export interface RecruiterOpening extends Opening { applicants: number; top_score: number | null; stages?: Record<ApplicationStage, number> }
export interface RecruiterOpeningFull extends OpeningFull { applicants: number; warnings?: string[]; rescored_applications?: number }
export type CandidateSource = "applied" | "uploaded";
export interface CandidateRow {
  rank: number; application_id: string; name: string; email: string | null; source: CandidateSource; score: number; tier: Tier; stage: ApplicationStage;
  counts: Partial<Record<"matched" | "partial" | "missing" | "unknown", number>>; keywords_matched: string[]; keywords_missing: string[];
  years: number | null; notes: number; applied_at: string; updated_at: string; stage_changed_at: string | null; expires_at: string | null;
}
export interface CandidateFilters { must_have: string[]; min_years: number | null; min_score: number | null; stage: ApplicationStage[]; source: CandidateSource | null }
export interface CandidateList { opening: Opening; candidates: CandidateRow[]; total: number; filters: CandidateFilters; stages: ApplicationStage[]; note: string }
export interface Note { id: string; text: string; author: string; author_id: string | null; created_at: string }
export interface RecruiterApplication {
  id: string; opening_id: string; name: string; email: string | null; source: CandidateSource; score: number; tier: Tier; stage: ApplicationStage;
  match: Omit<MatchResult, "jd" | "cached"> | null; resume: ResumeContent; applied_at: string;
  facts: { years: number; skills: string[] } | null; expires_at: string | null; notes: Note[];
}
export type ReqStatus = "matched" | "partial" | "missing" | "unknown";
export interface CompareCell { application_id: string; status: ReqStatus; explanation: string | null; evidence: (EvidenceRef & { similarity?: number })[] }
export interface CompareResult {
  opening: Opening; note: string;
  candidates: { application_id: string; name: string; score: number; tier: Tier; stage: ApplicationStage; years: number | null; counts: Partial<Record<ReqStatus, number>> }[];
  requirements: { text: string; importance: "required" | "preferred"; kind: string; cells: CompareCell[] }[];
}
export interface BulkUploadResult {
  added: { application_id: string; file: string; name: string; score: number; tier: Tier }[];
  failed: { file: string; code: string; message: string }[];
  retention_days: number; note: string;
}
export interface AnalyticsOpening extends Opening {
  applicants: number; strong_matches: number; median_score: number | null; advanced: number; median_days_to_advance: number | null; age_days: number; hard_to_fill: boolean;
}
export interface Analytics {
  totals: { openings_open: number; openings_closed: number; candidates: number; applied: number; uploaded: number; stages: Record<ApplicationStage, number>; median_score: number | null };
  most_missing_skills: { skill: string; candidates: number; share: number }[];
  openings: AnalyticsOpening[]; include_demo: boolean; notes: string[];
}
export interface FairnessGroup {
  group: string; n: number; mean_score: number; strong_rate: number; selection_rate: number; flags: string[];
  strong_rate_impact_ratio: number | null; selection_rate_impact_ratio: number | null;
}
export interface Fairness {
  opening_id: string | null; applicants: number; as_of: string; min_group_size: number; min_groups_shown: number;
  dimensions: Record<"gender" | "age_band", { groups: FairnessGroup[] }>; notes: string[];
}

// ---------------------------------------------------------------- engagement
export interface WhatIfSide { score: number | null; tier: Tier; core_coverage: number | null; tips_available: boolean }
export interface WhatIf {
  target: { kind: "role" | "opening"; id: string; title: string }; before: WhatIfSide; after: WhatIfSide; delta: number | null;
  keywords_gained: string[]; keywords_lost: string[]; note: string;
}
export type LearningStatus = "todo" | "learning" | "done";
export interface LearningItem {
  id: string; skill: string; status: LearningStatus; target: { kind: "role" | "opening" | null; id: string | null; title: string | null };
  resources: ResourceLookup; evidence_in_resume: boolean; next_step: string | null; created_at: string; completed_at: string | null;
}
export interface LearningPlan { items: LearningItem[]; progress: { done: number; total: number; percent: number }; resource_provider: string; added?: string[] }
export interface HistoryPoint {
  version_id: string; number: number; label: string | null; source: string; created_at: string; quality: number | null;
  top_role: { role_id: string; title: string; score: number } | null; target_score: number | null;
}
export interface ResumeHistory { resume_id: string; role_id: string | null; points: HistoryPoint[]; change: { quality: number | null; target_score: number | null }; note: string }
export interface CheckItem { id: string; ok: boolean; label: string; tip: string }
export interface AnswerChecks { kind: "rule_based"; label: string; words: number; score: number; items: CheckItem[]; skills_mentioned: string[] }
export type AiFeedback =
  | { status: "ok"; strengths: string[]; improvements: string[]; follow_up: string | null; provider: string; model: string; is_fixture: boolean; label: string }
  | { status: "unavailable"; code: string; message: string }
  | { status: "skipped" };
export interface InterviewAnswer { answer: string; checks: AnswerChecks; ai: AiFeedback; at: string }
export interface InterviewQuestion { id: string; question: string; why?: string; based_on?: string; answer: InterviewAnswer | null }
export interface InterviewSession {
  id: string; version_id: string; target: { kind: "role" | "opening" | null; id: string | null; title: string | null };
  questions: InterviewQuestion[]; questions_source: string; is_fixture: boolean; answered: number; created_at: string; updated_at: string;
}
export interface InterviewSummary { id: string; version_id: string; target: InterviewSession["target"]; answered: number; questions: number; created_at: string }

// ---------------------------------------------------------------- security & privacy
export interface MfaStatus { enabled: boolean; enabled_at: string | null; recovery_codes_left: number }
export interface MfaSetup { secret: string; otpauth_uri: string; instructions: string }
export interface SelfId {
  notice: string; options: { gender: string[]; age_band: string[] };
  value: { gender: string | null; age_band: string | null; consented_at: string } | null;
}
