-- Start over: delete everything this project created.
--
-- Run All, as ACCOUNTADMIN. Then run 01_schema.sql and 02_load.sql again.
--
-- Use this when the warehouse is in a state you no longer trust and you would
-- rather rebuild than work out what happened. It takes about a minute.

USE ROLE ACCOUNTADMIN;

DROP DATABASE IF EXISTS JWST;
DROP ROLE     IF EXISTS GUMLOOP_ANALYST;
DROP WAREHOUSE IF EXISTS JWST_WH;

-- Confirm the role is gone. This should return no rows.
SHOW ROLES LIKE 'GUMLOOP_ANALYST';
