-- The three queries worth putting on screen.
--
-- Run each on its own and screenshot the result grid. These are shaped for
-- legibility: SHOW GRANTS alone returns a dozen columns, and QUERY_TEXT runs
-- to hundreds of characters. Both are unreadable in a screenshot at the size
-- anyone will actually view it.
--
-- Run this first. INFORMATION_SCHEMA is per-database, so it does not resolve
-- without one selected, and reading another user's query history needs
-- ACCOUNTADMIN — if you have just tested the boundary you are still sitting in
-- GUMLOOP_ANALYST, and section 2 fails with "invalid identifier".

USE ROLE ACCOUNTADMIN;
USE DATABASE JWST;
USE WAREHOUSE JWST_WH;

-- ── 1. What the agent can reach ─────────────────────────────────────────────
-- Five rows. Two views, three usage grants, nothing on the base tables and
-- nothing on OBSERVATION_EMBARGO. This is the grant itself, not a description
-- of one.

SHOW GRANTS TO ROLE GUMLOOP_ANALYST;

SELECT "privilege", "granted_on", "name"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
ORDER BY "granted_on", "name";

-- ── 2. Who asked, and which agent ran it ────────────────────────────────────
-- Gumloop injects user_email, user_id, agent_id and interaction_id into
-- QUERY_TAG on every statement, so the warehouse log answers "what has this
-- thing been doing" without a proprietary tool.
--
-- INFORMATION_SCHEMA, not ACCOUNT_USAGE: the latter lags up to 45 minutes and
-- would show an empty table for the query you just ran.

SELECT START_TIME::TIME AS at,
       -- Masked for a screenshot that ends up in a public repo. The point is
       -- that the warehouse log carries an identity, not whose. Drop the
       -- REGEXP_REPLACE when demoing live on your own account.
       REGEXP_REPLACE(PARSE_JSON(QUERY_TAG):user_email::string,
                      '^(.).*@', '\\1***@')               AS asked_by,
       LEFT(PARSE_JSON(QUERY_TAG):agent_id::string, 8)   AS agent,
       LEFT(REGEXP_REPLACE(QUERY_TEXT, '\s+', ' '), 58) AS query
FROM TABLE(JWST.INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER(
       USER_NAME => 'GUMLOOP_SVC', RESULT_LIMIT => 10000))
WHERE QUERY_TEXT NOT ILIKE 'USE %'
ORDER BY START_TIME DESC
LIMIT 10;

-- ── 3. The same question, both agents ───────────────────────────────────────
-- The whole argument in one result grid. One agent counts, then asks the same
-- question a second way to confirm it. The other counts once. Nine rows: six
-- from the grounded agent across three trials, three from the concise one.
--
-- Two details make it readable. It shows the WHERE clause rather than the head
-- of the statement, because the SELECT is identical on every row and the
-- filter is where the difference lives. And it orders by agent, not by time —
-- the runs were sequential, so newest-first would show one agent only.
--
-- Replace the two ids with the first 8 characters of your own, from each
-- agent's URL.

SELECT CASE LEFT(PARSE_JSON(QUERY_TAG):agent_id::string, 8)
            WHEN '<v1 id>' THEN 'v1-grounded'
            WHEN '<v2 id>' THEN 'v2-concise'
            ELSE LEFT(PARSE_JSON(QUERY_TAG):agent_id::string, 8)
       END AS agent,
       START_TIME::TIME AS at,
       SUBSTR(REGEXP_REPLACE(QUERY_TEXT, '\s+', ' '),
              POSITION('WHERE' IN UPPER(REGEXP_REPLACE(QUERY_TEXT, '\s+', ' '))),
              54) AS filter
FROM TABLE(JWST.INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER(
       USER_NAME => 'GUMLOOP_SVC', RESULT_LIMIT => 10000))
WHERE QUERY_TEXT ILIKE '%COUNT(*)%'
  AND QUERY_TEXT ILIKE '%2023%'
  AND QUERY_TEXT NOT ILIKE '%GALAXY%'   -- one question, not the ambiguous one
  AND QUERY_TEXT NOT ILIKE 'USE %'
  -- Scope to the eval run. Without this you also get every time you asked the
  -- question by hand while setting the agents up, and the timestamps jump
  -- between sessions in a way that reads as noise. Set it to the date you ran
  -- the comparison.
  AND START_TIME >= '2026-09-03'
ORDER BY agent, START_TIME;
