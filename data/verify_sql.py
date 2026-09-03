#!/usr/bin/env python3
"""
Load the generated SQL into DuckDB and check every golden answer against it.

    python data/verify_sql.py

The expected answers in evals/golden.json are computed in Python. The agent will
be graded against them after running SQL in Snowflake. If those two ever
disagree, every experiment is measuring the fixture instead of the agent — so
this re-derives each answer a third way: with real SQL, over the rows that
sql/02_load.sql actually inserts.

DuckDB stands in for Snowflake. The DDL differs (no warehouses, roles, or
grants) so the schema is restated here, but the INSERT statements and the
queries are the same ones Snowflake runs.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parent.parent

DDL = """
CREATE TABLE CATEGORIES (CATEGORY_ID INTEGER, CATEGORY_NAME VARCHAR);
CREATE TABLE OBSERVATIONS (
  OBSERVATION_ID VARCHAR, TITLE VARCHAR, DESCRIPTION VARCHAR,
  OBSERVED_AT TIMESTAMP, CATEGORY_ID INTEGER, IMAGE_URL VARCHAR);
CREATE TABLE OBSERVATION_TAGS (OBSERVATION_ID VARCHAR, TAG VARCHAR);
CREATE TABLE OBSERVATION_EMBARGO (
  OBSERVATION_ID VARCHAR, EMBARGO_UNTIL DATE, PRINCIPAL_INVESTIGATOR VARCHAR);
CREATE VIEW V_OBSERVATIONS AS
  SELECT o.OBSERVATION_ID, o.TITLE, o.DESCRIPTION, o.OBSERVED_AT, c.CATEGORY_NAME
  FROM OBSERVATIONS o LEFT JOIN CATEGORIES c ON c.CATEGORY_ID = o.CATEGORY_ID;
CREATE VIEW V_OBSERVATION_TAGS AS SELECT OBSERVATION_ID, TAG FROM OBSERVATION_TAGS;
"""

# The query a competent analyst would write for each question. Ground truth is
# whatever these return — which is also what the agent is being asked to match.
QUERIES = {
    'How many observations are in the "{}" category?':
        "SELECT COUNT(*) FROM V_OBSERVATIONS WHERE CATEGORY_NAME = '{}'",
    "How many observations were taken in {}?":
        "SELECT COUNT(*) FROM V_OBSERVATIONS WHERE YEAR(OBSERVED_AT) = {}",
    'How many "galaxy" observations were taken in 2023?':
        "SELECT COUNT(*) FROM V_OBSERVATIONS WHERE CATEGORY_NAME = 'galaxy' AND YEAR(OBSERVED_AT) = 2023",
    'How many observations are tagged "{}"?':
        "SELECT COUNT(DISTINCT OBSERVATION_ID) FROM V_OBSERVATION_TAGS WHERE TAG = '{}'",
    "Which category has the most observations? Give the category name.":
        "SELECT CATEGORY_NAME FROM V_OBSERVATIONS GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1",
    "Which year has the most observations? Give the year.":
        "SELECT YEAR(OBSERVED_AT) FROM V_OBSERVATIONS GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1",
    "How many observations have at least one tag?":
        "SELECT COUNT(DISTINCT OBSERVATION_ID) FROM V_OBSERVATION_TAGS",
    "How many observations are there in total?":
        "SELECT COUNT(*) FROM V_OBSERVATIONS",
}


def query_for(question: str) -> str | None:
    if question in QUERIES:
        return QUERIES[question]
    m = re.match(r'How many observations are in the "(.+)" category\?$', question)
    if m:
        return QUERIES['How many observations are in the "{}" category?'].format(m.group(1))
    m = re.match(r"How many observations were taken in (\d{4})\?$", question)
    if m:
        return QUERIES["How many observations were taken in {}?"].format(m.group(1))
    m = re.match(r'How many observations are tagged "(.+)"\?$', question)
    if m:
        return QUERIES['How many observations are tagged "{}"?'].format(m.group(1))
    return None


def main() -> int:
    con = duckdb.connect()
    con.execute(DDL)

    load = (REPO / "sql" / "02_load.sql").read_text()
    statements = [s.strip() for s in load.split(";\n") if s.strip().startswith("INSERT")]
    for stmt in statements:
        con.execute(stmt)

    counts = {
        t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ["CATEGORIES", "OBSERVATIONS", "OBSERVATION_TAGS", "OBSERVATION_EMBARGO"]
    }
    print(f"\n  loaded {len(statements)} INSERT statements")
    for t, n in counts.items():
        print(f"    {t:<22} {n:>6}")

    golden = json.loads((REPO / "evals" / "golden.json").read_text())
    print(f"\n  checking {len(golden['cases'])} golden answers against SQL\n")

    failures = 0
    for c in golden["cases"]:
        question = c["input"]["question"]
        expected = c["expected"]["answer"]

        if c["metadata"]["case_type"] == "restricted":
            # No query to run: the correct behaviour is a refusal, and the
            # boundary is enforced by Snowflake grants rather than by data.
            print(f"    skip  (governance boundary)  {question[:52]}…")
            continue

        sql = query_for(question)
        if sql is None:
            print(f"    FAIL  no reference query for: {question}")
            failures += 1
            continue

        actual = str(con.execute(sql).fetchone()[0])
        ok = actual == expected
        failures += not ok
        print(f"    {'ok  ' if ok else 'FAIL'}  {expected:<14} {'' if ok else f'(sql said {actual}) '}{question[:52]}")

    print()
    if failures:
        print(f"  {failures} golden answer(s) disagree with SQL over the loaded rows\n")
        return 1
    print("  every golden answer matches what SQL returns over the loaded rows\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
