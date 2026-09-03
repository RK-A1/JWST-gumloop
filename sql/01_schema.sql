-- JWST observation warehouse: schema, roles, and grants.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  USE "RUN ALL", NOT "RUN".                                               │
-- │                                                                          │
-- │  In a Snowsight worksheet the Run button executes only the statement     │
-- │  under your cursor. Running one statement from the middle of this file   │
-- │  fails with "Database 'JWST' does not exist or not authorized", because  │
-- │  the CREATE DATABASE above it never ran. Use the Run All option in the   │
-- │  dropdown beside the Run button.                                         │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Run this first, as ACCOUNTADMIN. On a fresh trial that is already your role;
-- if not, pick it in the worksheet's role selector before running.
--
-- Safe to re-run: tables are IF NOT EXISTS, so a second run leaves data alone.
-- (CREATE OR REPLACE silently emptied them — queries kept working, returning 0.)
-- Views stay CREATE OR REPLACE: no data, and they are the access boundary.
-- Changing a table's columns means dropping it by hand first.
--
-- An agent anyone can ask anything needs its blast radius set in the warehouse,
-- not in a prompt. Three controls, none sufficient alone:
--
--   1. SELECT and nothing else. A prompt injection has no write privilege.
--   2. Granted on views, not tables, so widening access is a diff in this file.
--   3. OBSERVATION_EMBARGO never granted, so the boundary can be demonstrated.

USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS JWST;
CREATE SCHEMA   IF NOT EXISTS JWST.ANALYTICS;
USE SCHEMA JWST.ANALYTICS;

-- Smallest warehouse, auto-suspending fast. The whole demo is a few hundred
-- queries over ~5k rows; this keeps the trial credits essentially untouched.
CREATE WAREHOUSE IF NOT EXISTS JWST_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- Without this the session has no compute and every SELECT below fails.
USE WAREHOUSE JWST_WH;

CREATE TABLE IF NOT EXISTS CATEGORIES (
  CATEGORY_ID    NUMBER      PRIMARY KEY,
  CATEGORY_NAME  VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS OBSERVATIONS (
  OBSERVATION_ID  VARCHAR(16)  PRIMARY KEY,
  TITLE           VARCHAR(512) NOT NULL,
  DESCRIPTION     VARCHAR(512),
  OBSERVED_AT     TIMESTAMP_NTZ,
  CATEGORY_ID     NUMBER       REFERENCES CATEGORIES(CATEGORY_ID),
  IMAGE_URL       VARCHAR(512)
);

CREATE TABLE IF NOT EXISTS OBSERVATION_TAGS (
  OBSERVATION_ID  VARCHAR(16) REFERENCES OBSERVATIONS(OBSERVATION_ID),
  TAG             VARCHAR(64)
);

-- Restricted. Deliberately never granted to the analyst role.
CREATE TABLE IF NOT EXISTS OBSERVATION_EMBARGO (
  OBSERVATION_ID  VARCHAR(16),
  EMBARGO_UNTIL   DATE,
  PRINCIPAL_INVESTIGATOR VARCHAR(128)
);

-- What the agent actually sees. IMAGE_URL is excluded to make the point that
-- the view is the access boundary: the agent can reason about observations
-- without being handed every column the table holds.
CREATE OR REPLACE VIEW V_OBSERVATIONS AS
SELECT
  o.OBSERVATION_ID,
  o.TITLE,
  o.DESCRIPTION,
  o.OBSERVED_AT,
  c.CATEGORY_NAME
FROM OBSERVATIONS o
LEFT JOIN CATEGORIES c ON c.CATEGORY_ID = o.CATEGORY_ID;

CREATE OR REPLACE VIEW V_OBSERVATION_TAGS AS
SELECT OBSERVATION_ID, TAG FROM OBSERVATION_TAGS;

-- ── The analyst role ────────────────────────────────────────────────────────

CREATE ROLE IF NOT EXISTS GUMLOOP_ANALYST;

GRANT USAGE ON WAREHOUSE JWST_WH   TO ROLE GUMLOOP_ANALYST;
GRANT USAGE ON DATABASE  JWST      TO ROLE GUMLOOP_ANALYST;
GRANT USAGE ON SCHEMA JWST.ANALYTICS TO ROLE GUMLOOP_ANALYST;

-- SELECT on the two views. Nothing on the base tables, nothing on the embargo
-- table, and no write privilege anywhere.
GRANT SELECT ON VIEW JWST.ANALYTICS.V_OBSERVATIONS     TO ROLE GUMLOOP_ANALYST;
GRANT SELECT ON VIEW JWST.ANALYTICS.V_OBSERVATION_TAGS TO ROLE GUMLOOP_ANALYST;

-- Attach the role to whoever is running this, so there is nothing to edit.
-- This is for you, to test what the agent can see.
SET running_user = CURRENT_USER();
GRANT ROLE GUMLOOP_ANALYST TO USER IDENTIFIER($running_user);

-- ── The agent's identity ────────────────────────────────────────────────────
--
-- The connector has no role field, so a connection runs as the user's
-- DEFAULT_ROLE. Point it at a human account and the agent silently inherits
-- ACCOUNTADMIN — every grant above correct, and bypassed. TYPE = SERVICE cannot
-- sign in to Snowsight or hold a password at all.
-- Every default here is load-bearing. The connector form asks only for account,
-- username, and private key — no role, no warehouse, no database, no schema —
-- so all four come from this user, and a missing one fails at query time rather
-- than at connect time.
CREATE USER IF NOT EXISTS GUMLOOP_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = GUMLOOP_ANALYST
  DEFAULT_WAREHOUSE = JWST_WH
  DEFAULT_NAMESPACE = 'JWST.ANALYTICS'
  COMMENT = 'Service identity for the Gumloop analyst agent. One role, read-only.';

GRANT ROLE GUMLOOP_ANALYST TO USER GUMLOOP_SVC;

-- New users default to DEFAULT_SECONDARY_ROLES = ('ALL'): a session carries
-- every role granted to the user, not just its primary. Empty means granting a
-- second role later is deliberate rather than a silent widening.
ALTER USER GUMLOOP_SVC SET DEFAULT_SECONDARY_ROLES = ();

-- Register the public half of the key pair on it. See docs/SETUP.md — the key
-- is generated per install, so the statement is not written out here:
--   ALTER USER GUMLOOP_SVC SET RSA_PUBLIC_KEY='<your public key body>';

-- ── Verify ──────────────────────────────────────────────────────────────────

-- What the analyst role can touch, in one list. The two views are here;
-- OBSERVATION_EMBARGO and the base tables are not. This is the artifact to put
-- on screen when someone asks what the agent can see — it is the grant itself,
-- not a description of it.
SHOW GRANTS TO ROLE GUMLOOP_ANALYST;

-- Every role the agent's identity holds. Exactly one, and not an admin. This
-- is the second half of the answer to "what can it see" — the grants above say
-- what the role reaches, this says the agent has nothing else to fall back to.
SHOW GRANTS TO USER GUMLOOP_SVC;

-- So an empty warehouse announces itself here, rather than later as an agent
-- that answers every question with zero.
SELECT 'OBSERVATIONS' AS TABLE_NAME, COUNT(*) AS ROWS_LOADED, 979 AS EXPECTED FROM OBSERVATIONS
UNION ALL SELECT 'OBSERVATION_TAGS', COUNT(*), 4317 FROM OBSERVATION_TAGS
UNION ALL SELECT 'CATEGORIES',       COUNT(*),   11 FROM CATEGORIES;

-- Run these by hand afterwards, as a separate step. The last one is meant to
-- fail, so it is kept out of the script above — an error mid-run would stop
-- everything after it.
--
--   USE ROLE GUMLOOP_ANALYST;
--   SELECT CURRENT_ROLE();                                    -- MUST say GUMLOOP_ANALYST
--   USE WAREHOUSE JWST_WH;
--   SELECT COUNT(*) FROM JWST.ANALYTICS.V_OBSERVATIONS;       -- expect 979
--   SELECT COUNT(*) FROM JWST.ANALYTICS.OBSERVATION_EMBARGO;  -- must FAIL
--
-- Check CURRENT_ROLE() first. If USE ROLE failed the session stays on
-- ACCOUNTADMIN, which reads everything — the embargo query then returns a count
-- and a working boundary looks broken. Snowsight's role selector can override
-- a USE ROLE statement.
--
-- If the role is right and the last query still succeeds, the grants are wrong.
