"""Regression tables for skill detection, degree levels and date ranges.

These feed every score in the product, so a wrong match here silently skews role fit, JD matching,
leaderboards and tips. Each row is a real phrasing that was previously handled wrongly.
"""

import pytest

from app.services.extraction.dates import find_range
from app.services.ml.jd import _degree_level
from app.services.taxonomy import get_taxonomy


def skills(text: str) -> set[str]:
    return {h.skill for h in get_taxonomy().find_skills(text)}


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Used ML models daily", {"Machine Learning"}),
        ("Wrote JS and stored files in S3", {"JavaScript", "AWS"}),
        ("Load tests with K6", {"Performance Testing"}),
        ("Built services in Go and Python", {"Go", "Python"}),
        ("Skills: python, sql, aws, c++", {"Python", "SQL", "AWS", "C++"}),
        ("Python, R, SQL", {"Python", "R", "SQL"}),
        ("Analysed survey data in R.", {"R"}),
        ("Built dashboards in React and Express", {"React", "Express"}),
        ("Advanced Excel and Tableau reporting", {"Excel", "Tableau"}),
        ("Deployed charts with Helm on EKS", {"Kubernetes"}),
        ("Fine-tuned BERT for classification", {"Transformers"}),
        ("Shipped an iOS app in Swift", {"iOS", "Swift"}),
        ("Java and JavaScript", {"Java", "JavaScript"}),
        ("Exported weekly reports to Excel", {"Excel"}),
        ("Migrated the frontend to React", {"React"}),
    ],
)
def test_skills_are_found(text, expected):
    assert expected <= skills(text), skills(text)


@pytest.mark.parametrize(
    "text, not_expected",
    [
        ("Built a Go-to-market plan for the launch", "Go"),
        ("Was the go to person for onboarding", "Go"),
        ("Trained to react to incidents calmly", "React"),
        ("Excel at communicating with clients", "Excel"),
        ("Able to express ideas clearly", "Express"),
        ("Took the helm of the support team", "Kubernetes"),
        ("Worked with Bert on the audit", "Transformers"),
        ("Led the SWIFT payments migration", "Swift"),
        ("Helped spark interest in mentoring", "Spark"),
        ("Plan C was adopted", "C"),
        ("Managed the R&D budget", "R"),
        ("Mixed 500 ml solutions in the lab", "Machine Learning"),
    ],
)
def test_prose_is_not_a_skill(text, not_expected):
    assert not_expected not in skills(text), skills(text)


@pytest.mark.parametrize(
    "text, level",
    [
        ("Bachelor's degree in Information Systems", 3),
        ("BSc Systems Engineering", 3),
        ("Bachelor's degree or equivalent time in industry", 3),
        ("B.E. in Computer Engineering", 3),
        ("BE in Mechanical Engineering", 3),
        ("Master's in Computer Science", 4),
        ("M.S. in Data Science", 4),
        ("MS in Statistics", 4),
        ("M.Tech, IIT Bombay", 4),
        ("MBA preferred", 4),
        ("PhD in Machine Learning", 5),
        ("Associate degree in Networking", 2),
        ("Diploma in Computer Engineering", 2),
        ("High school diploma", 1),
        ("Proficient with MS Office", None),
        ("You must be able to work independently", None),
        ("Contact me for details", None),
    ],
)
def test_degree_level(text, level):
    assert _degree_level(text) == level


@pytest.mark.parametrize(
    "text, start, current",
    [
        ("Jan 2019 to date", "2019-01", True),
        ("2019 to date", "2019", True),
        ("Mar 2020 till date", "2020-03", True),
        ("Jan 2019 - Present", "2019-01", True),
        ("Jan 2019 - Mar 2021", "2019-01", False),
    ],
)
def test_date_ranges(text, start, current):
    r = find_range(text)
    assert r is not None
    assert r.start == start
    assert r.current is current


# ---------------------------------------------------------------- job descriptions


def _reqs(jd):
    return {r["text"]: r for r in jd["requirements"]}


def test_single_paragraph_jd_keeps_its_sections():
    """A JD pasted as one paragraph used to lose every section, so nice-to-haves became required."""
    from app.services.ml.jd import extract_jd

    jd = extract_jd("Senior Backend Engineer. Requirements: 5+ years Python, FastAPI or Django, PostgreSQL, Docker. "
                    "Nice to have: Kafka, Terraform, CI/CD. Responsibilities: design REST APIs, mentor juniors.")
    r = _reqs(jd)
    assert jd["title"] == "Senior Backend Engineer"
    assert {k for k, v in r.items() if v["importance"] == "preferred"} == {"Kafka", "Terraform", "CI/CD"}
    assert r["PostgreSQL"]["importance"] == "required"
    assert r["FastAPI or Django"]["any_of"] is True
    assert jd["responsibilities"] == ["design REST APIs", "mentor juniors"]


@pytest.mark.parametrize(
    "line, years, skill",
    [
        ("5+ years Python", 5, "Python"),
        ("At least five years of Python", 5, "Python"),
        ("Minimum 3 years in machine learning", 3, "Machine Learning"),
        ("2-4 yrs experience with PyTorch", 2, "PyTorch"),
        ("3 years of experience building APIs", 3, None),
    ],
)
def test_years_requirements_are_recognised(line, years, skill):
    from app.services.ml.jd import extract_jd

    req = extract_jd(f"Engineer\nRequirements\n- {line}\n")["requirements"][0]
    assert req["kind"] == "experience" and req["years_min"] == years
    assert (skill in req["skills"]) if skill else req["skills"] == []


@pytest.mark.parametrize(
    "text, title",
    [
        ("Requirements\n- Python\n- Docker\n", None),
        ("About us: We are a fintech, based in Pune.\nData Engineer\nRequirements: SQL", "Data Engineer"),
        ("Job title: Platform Engineer.\nRequirements\n- Go", "Platform Engineer"),
    ],
)
def test_jd_title_is_never_a_heading_bullet_or_blurb(text, title):
    from app.services.ml.jd import extract_jd

    assert extract_jd(text)["title"] == title


def test_years_with_skill_needs_the_skill(personas):
    """'5+ years Kotlin' is not met by five years of unrelated experience."""
    from app.services.ml.jd import extract_jd, match

    content = personas["p04"]["content"]  # senior devops persona, no Kotlin
    rows = {r["text"]: r for r in match(content, extract_jd("Engineer\nRequirements\n- 5+ years Kotlin\n- 2+ years Docker\n"))["requirements"]}
    assert rows["5+ years Kotlin"]["status"] == "missing"
    assert rows["2+ years Docker"]["status"] in ("matched", "partial")
    assert "years per skill" in rows["2+ years Docker"]["explanation"]
