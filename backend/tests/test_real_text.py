"""Regression tests for text seen in real data: flattened resumes, live job postings, matcher misses."""

from __future__ import annotations

import pytest

from app.schemas.resume import ResumeContent
from app.services.extraction.extractor import extract
from app.services.extraction.recover import recover
from app.services.ml.jd import extract_jd
from app.services.taxonomy import get_taxonomy


def _x(text: str) -> dict:
    return extract(text, [{"page": 1, "char_start": 0, "char_end": len(text)}])


FLAT = (
    "Jane Roe\n"
    "SummaryAnalyst with six years of reporting experience in healthcare and retail settings.\n"
    "HighlightsMicrosoft Excel, SQL, Tableau, Python\n"
    "ExperienceData Analyst,09/2015-06/2016Altice Usa Tyler,TX,Loaded daily enrollment files into the warehouse with SQL."
    "Performed a monthly reconciliation on enrollment files using Python.Built Tableau dashboards for the finance team "
    "covering revenue, churn and claims across four regions and two product lines every month.Security Analyst,"
    "09/2013-08/2015Cisco Systems Minneapolis,MN,Monitored an average of 200 trade breaks daily.\n"
    "EducationBachelor of Science: Economics, 2013 Westminster College\n"
)


def test_flattened_resume_recovers_sections_and_entries():
    r = _x(FLAT)
    c = r["content"]
    ResumeContent.model_validate(c)
    assert "layout_recovered" in r["warnings"]
    assert {"experience", "education", "skills"} <= set(r["detected_sections"])
    assert [e["title"] for e in c["experience"]][:2] == ["Data Analyst", "Security Analyst"]
    assert c["experience"][0]["start"] == "2015-09" and c["experience"][0]["end"] == "2016-06"
    assert len(c["experience"][0]["bullets"]) >= 2
    assert {"SQL", "Tableau", "Python", "Excel"} <= set(c["skills"]["technical"])


def test_recovered_evidence_points_at_the_original_text():
    r = _x(FLAT)
    for ev in r["evidence"].values():
        assert FLAT[ev["start"]:ev["end"]][:300] == ev["text"]


def test_structured_text_is_left_unchanged():
    text = "Jane Roe\nEXPERIENCE\nData Analyst | Acme Labs\nJan 2020 – Present\n• Built SQL reports.\n"
    rec = recover(text)
    assert not rec.changed and rec.text == text


def test_text_without_any_sections_keeps_mentioned_skills_as_listed_only():
    text = ("marie anderson staff accountant with python sql tableau and excel experience " * 12).strip()
    r = _x(text)
    c = r["content"]
    assert "no_sections_found" in r["warnings"]
    assert {"Python", "SQL", "Tableau", "Excel"} <= set(c["skills"]["technical"])
    assert c["summary"] and not c["experience"]
    from app.services.ml.features import resume_skill_evidence

    ev = resume_skill_evidence(ResumeContent.model_validate(c))
    assert not ev.demonstrated  # mentioned, never "shown in work"


def test_very_long_lines_never_break_the_schema():
    long_edu = ("Bachelor of Science in Computer Science with a minor in mathematics where I completed coursework in "
                "algorithms, operating systems, databases, networking, compilers and graphics, University of Somewhere")
    text = "Jane Doe\nEDUCATION\n" + long_edu + "\nEXPERIENCE\nEngineer | Acme\n2020 - 2021\n• " + "word " * 300 + "\n"
    r = _x(text)
    ResumeContent.model_validate(r["content"])
    assert "fields_truncated" in r["warnings"]


@pytest.mark.parametrize("degree", ["B.Ed", "B.Des in Communication Design", "MBBS", "LLB", "B.Pharm"])
def test_more_degrees_are_recognised(degree):
    c = _x(f"Sam Lee\nEDUCATION\n{degree}, Riverbend College, 2015 – 2019\n")["content"]
    assert c["education"] and degree.split()[0] in (c["education"][0]["degree"] or "")


@pytest.mark.parametrize("title,org", [("Science Teacher", "Juniper Schools"), ("Staff Nurse", "Saffron Fintech"),
                                       ("SDET", "Quarry Analytics"), ("Accountant", "Cobalt Energy")])
def test_company_first_lines_with_non_tech_titles(title, org):
    text = f"Sam Lee\nWork History:\n{org} — {title} (03/2020 – Present)\n- Did the work well every day.\n"
    e = _x(text)["content"]["experience"][0]
    assert (e["title"], e["organization"]) == (title, org)


@pytest.mark.parametrize("text,skills", [
    ("Used ES6 and React to cut processing time.", {"JavaScript", "React"}),
    ("Migrated a legacy system to Spark, reducing incidents.", {"Spark"}),
    ("Used R and Python to build models.", {"R", "Python"}),
    ("Wrote Dockerfiles for every service.", {"Docker"}),
    ("Split the monolith into microservices.", {"Microservices"}),
])
def test_matcher_finds_skills_it_used_to_miss(text, skills):
    assert {h.skill for h in get_taxonomy().find_skills(text)} == skills


@pytest.mark.parametrize("text", ["React to incidents quickly.", "Plan C and D", "R&D team", "Built a Go-to-market plan",
                                  "helped spark interest", "Took the helm of the team"])
def test_everyday_words_stay_prose(text):
    assert get_taxonomy().find_skills(text) == []


# ------------------------------------------------------------------ job descriptions
def _req_skills(jd: dict, importance: str) -> set[str]:
    return {s for r in jd["requirements"] if r["importance"] == importance for s in r["skills"]}


@pytest.mark.parametrize("heading", ["What you bring", "About You", "Job Requirements", "Candidate Qualifications",
                                     "YOUR EXPERIENCE", "Your profile", "Must-haves"])
def test_more_requirement_headings(heading):
    jd = extract_jd(f"Backend Engineer\n\nAbout the role\nBuild APIs.\n\n{heading}\n- Python\n- PostgreSQL\n")
    assert {"Python", "PostgreSQL"} <= _req_skills(jd, "required")


def test_boilerplate_sections_are_not_requirements():
    jd = extract_jd("Backend Engineer\n\nRequirements\n- Python\n- Django\n\nNot your tech stack?\n"
                    "We also hire Swift, iOS and Vue developers.\n\nBenefits\n- Kubernetes training budget\n")
    assert _req_skills(jd, "required") == {"Python", "Django"}
    assert not {"Swift", "iOS", "Vue.js", "Kubernetes"} & set(jd["skills"])


def test_headline_years_is_the_main_requirement_not_the_smallest():
    jd = extract_jd("Senior Go Developer\n\nRequirements\n- 5+ years of experience with Golang\n"
                    "- 1+ year of AI-assisted coding experience\n- Client onboarding experience within the last three years\n")
    assert jd["years_required"] == 5


def test_years_without_the_word_experience():
    jd = extract_jd("Staff Engineer\n\nRequirements\n- 12+ years building software\n- Python\n")
    assert jd["years_required"] == 12


@pytest.mark.parametrize("first", ["About the Role", "How it works", "Our Technology Stack", "5+ years of commercial experience with Python"])
def test_title_skips_headings_and_requirement_lines(first):
    jd = extract_jd(f"{first}\nSenior Back-end Developer\n\nRequirements\n- Python\n")
    assert jd["title"] == "Senior Back-end Developer"


def test_prose_jd_reads_importance_and_years_from_sentences():
    jd = extract_jd("Data Engineer\n\nOur payments team is looking for someone who is comfortable with Python, SQL and Spark. "
                    "You should have 3+ years of professional experience. It is a plus if you have worked with Kafka or dbt.\n")
    assert {"Python", "SQL", "Spark"} <= _req_skills(jd, "required")
    assert {"Kafka", "dbt"} <= _req_skills(jd, "preferred")
    assert jd["years_required"] == 3


def test_flattened_jd_headings_and_sentences():
    jd = extract_jd("Key Responsibilities:Build data pipelines.Work with analysts.\n"
                    "Requirements:Minimum of 5 years of practical experience in data engineering.Strong SQL skills.Experience with Airflow.")
    assert jd["years_required"] == 5
    assert {"SQL", "Airflow"} <= _req_skills(jd, "required")


def test_stale_openings_and_applications_are_rescored(personas):
    from app.db import SessionLocal
    from app.models import JobOpening, OpeningApplication
    from app.services.openings import refresh_stale
    from app.versions import JD_MATCHER_VERSION

    with SessionLocal() as db:
        o = JobOpening(title="Data Engineer", company="Acme", description="Requirements\n- Python\n- SQL\n- Spark\n",
                       extracted={"matcher_version": "jd-matcher-0.0.1", "requirements": []}, status="open")
        db.add(o)
        db.flush()
        a = OpeningApplication(opening_id=o.id, source="uploaded", score=0.0, result={}, matcher_version="jd-matcher-0.0.1",
                               content_enc=__import__("json").dumps(next(iter(personas.values()))["content"]))
        db.add(a)
        db.commit()
        out = refresh_stale(db)
        db.commit()
        assert out == {"openings": 1, "applications": 1}
        assert o.extracted["matcher_version"] == JD_MATCHER_VERSION and o.extracted["requirements"]
        assert a.matcher_version == JD_MATCHER_VERSION and a.result.get("requirements")
        assert refresh_stale(db) == {"openings": 0, "applications": 0}


def test_posting_with_only_a_duties_section_still_has_requirements():
    jd = extract_jd("LLM Engineer\n\nRole Overview\nBuild agents.\n\nKey Responsibilities\n"
                    "- Build LLM services in Python\n- Deploy them with Docker and Kubernetes on AWS\n")
    assert {"Python", "Docker", "Kubernetes", "AWS", "LLMs"} <= _req_skills(jd, "required")


def test_about_section_ends_at_the_next_heading_like_line():
    jd = extract_jd("R&D Engineer\n\nWho we are ?\nA research lab.\n\nYour main responsibilities will include :\n"
                    "- Write C++ and Python tools\n\nYour profile:\n- Experience with Docker\n\nWhy join us?\n- Kubernetes training\n")
    assert {"Docker"} <= _req_skills(jd, "required")
    assert {"C++", "Python"} <= set(jd["skills"])
    assert "Kubernetes" not in jd["skills"]
