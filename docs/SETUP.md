# Setup

About 30 minutes. Steps 1–3 cost nothing; Gumloop credits are only spent in
step 5.

Steps marked **(confirm in the UI)** are written from Gumloop's documentation
rather than from having clicked through them. Everything either side is verified
locally.

---

## 1 · Snowflake (10 min)

[Sign up for a trial](https://signup.snowflake.com) — $400 of credits for 30
days, no credit card. Any cloud or region.

In a Snowsight worksheet, as `ACCOUNTADMIN` (already your role on a fresh
trial). Starting over from a state you do not trust? Run
[`sql/00_reset.sql`](../sql/00_reset.sql) first — it drops everything this
project created.

1. Paste [`sql/01_schema.sql`](../sql/01_schema.sql) and **Run All** — the
   database, an XSMALL warehouse that auto-suspends after 60s, the tables, the
   two views, the `GUMLOOP_ANALYST` role, and its grants. It grants the role to
   whoever runs it, so there is nothing to edit.
2. Paste [`sql/02_load.sql`](../sql/02_load.sql) and **Run All** — 979
   observations, 4,317 tags, 11 categories. ~500 KB, about 30 seconds.

> **Both files are safe to re-run.** The schema uses `CREATE TABLE IF NOT
> EXISTS` so it never empties your data, and the loader truncates before
> inserting so it never doubles it. Re-run either as often as you like.

> **Use Run All, not Run.** The Run button executes only the statement under
> your cursor. Running one statement from the middle of either file fails with
> `Database 'JWST' does not exist or not authorized`, because the
> `CREATE DATABASE` above it never ran. Run All is in the dropdown beside the
> Run button.

Then verify the boundary actually holds — the demo depends on it. Run these by
hand, as a separate step, because the last one is *supposed* to fail:

```sql
USE ROLE GUMLOOP_ANALYST;
SELECT CURRENT_ROLE();                                   -- MUST be GUMLOOP_ANALYST
USE WAREHOUSE JWST_WH;
SELECT COUNT(*) FROM JWST.ANALYTICS.V_OBSERVATIONS;      -- 979
SELECT COUNT(*) FROM JWST.ANALYTICS.OBSERVATION_EMBARGO; -- must FAIL
```

The last must error with *object does not exist or not authorized*.

> **Switch role with Snowsight's role selector, not with `USE ROLE`.** The
> worksheet's dropdown governs the session and can override a `USE ROLE`
> statement, leaving you on `ACCOUNTADMIN` — which reads every table. The
> embargo query then returns a count and the boundary looks broken when the
> grants are fine. `SELECT CURRENT_ROLE()` is how you tell.

If you are unsure, this settles it without switching role at all:

```sql
USE ROLE ACCOUNTADMIN;
SHOW GRANTS TO ROLE GUMLOOP_ANALYST;
```

Exactly five rows: `USAGE` on the warehouse, database, and schema, and `SELECT`
on the two views. If `OBSERVATION_EMBARGO` is not in that list, the role cannot
read it, and any count you saw came from a session that was not in the role.

This whole workload is a few hundred queries over ~5k rows on an XSMALL
warehouse — a rounding error against $400.

## 2 · Regenerate and verify (2 min, optional)

```bash
npm install
npm run build:warehouse
```

Rebuilds the SQL and the questions from `data/corpus.json`, then loads the
generated SQL into DuckDB and re-derives all 14 expected answers with real
queries. It should report no differences. Run this if you change the corpus, the
schema, or a question.

## 3 · Connect Gumloop to Snowflake **(confirm in the UI)** (5 min)

Collect what the connector will ask for:

```sql
SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS account_identifier,
       CURRENT_ACCOUNT() AS legacy_locator,
       CURRENT_REGION()  AS region;
```

Use `account_identifier`, the `org-account` form. **Not** `CURRENT_ACCOUNT()` —
that returns the legacy account locator (a short code like `AB12345`), which is a
different identifier and will not authenticate here. Cross-check it in the
browser: Snowsight's URL is `app.snowflake.com/<org>/<account_name>/…`, and
those two segments joined by a hyphen are what the connector wants.

| Field | Value |
|---|---|
| Account | `account_identifier` from the query above |
| User | **`GUMLOOP_SVC`** — the agent's identity, not yours |
| Warehouse | `JWST_WH` |
| Database | `JWST` |
| Schema | `ANALYTICS` |

Settings → Connectors → Snowflake. The connector offers **Key-Pair**, **PAT**,
and two OAuth configs. **Choose Key-Pair.**

PAT looks simpler but Snowflake requires a network policy for token auth by
default, so it means either allow-listing Gumloop's egress IPs or relaxing
`NETWORK_POLICY_EVALUATION` — extra setup, and a poor look on a project about
governance. Key-pair needs neither, works with MFA enforced on your human
login, and is the right answer for a service identity.

Generate the pair, keeping it outside the repo:

```bash
mkdir -p ~/.snowflake-jwst && chmod 700 ~/.snowflake-jwst
cd ~/.snowflake-jwst
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
chmod 600 rsa_key.p8
```

Unencrypted PKCS#8, because Gumloop uses the key unattended and cannot answer a
passphrase prompt. Register the public half:

```bash
# prints the ALTER USER statement with the key body already inlined
PUB=$(grep -v 'PUBLIC KEY' ~/.snowflake-jwst/rsa_key.pub | tr -d '\n')
echo "ALTER USER IDENTIFIER(\$me) SET RSA_PUBLIC_KEY='$PUB';"
```

Register it on the **service user**, `GUMLOOP_SVC`, which `01_schema.sql`
created:

```sql
USE ROLE ACCOUNTADMIN;
-- paste the generated ALTER USER line here, targeting GUMLOOP_SVC
DESC USER GUMLOOP_SVC;        -- RSA_PUBLIC_KEY_FP must now have a value
SHOW GRANTS TO USER GUMLOOP_SVC;   -- exactly one role, GUMLOOP_ANALYST
```

> **The connector has no role field.** That is why the agent gets its own user.
> Without a role to specify, the connection runs as the user's `DEFAULT_ROLE` —
> and on a trial your own account defaults to `ACCOUNTADMIN`. Connect as
> yourself and the agent silently becomes an admin: every grant still correct,
> and completely bypassed. `GUMLOOP_SVC` has one role and cannot hold a
> password at all.

Then put the private key on your clipboard and paste it into Gumloop:

```bash
pbcopy < ~/.snowflake-jwst/rsa_key.p8
```

Connect as **user `GUMLOOP_SVC`** — not your own username.

Once the agent has answered one question, confirm which identity it actually
used:

```sql
SELECT START_TIME, USER_NAME, ROLE_NAME, WAREHOUSE_NAME, QUERY_TEXT
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER('GUMLOOP_SVC'))
ORDER BY START_TIME DESC
LIMIT 10;
```

`GUMLOOP_SVC` / `GUMLOOP_ANALYST` / `JWST_WH`. Anything else — an empty result
especially — means the connector is authenticating as someone other than the
service user.

## 4 · Create the two agents **(confirm in the UI)** (10 min)

Both prompts are in [`prompts.md`](../prompts.md), each one a
complete block — copy a whole block per agent, do not assemble it from the
preamble and rules separately. If an agent starts a run by exploring which
databases exist, it is missing the preamble, and the comparison is measuring
what the agents know rather than how they behave. For each agent:

- Model: **Claude Sonnet 4.6**
- Tools: the Snowflake connector with **Describe Table** and **Execute Query**
  enabled, and **Stage Data disabled**
- Paste the system prompt, save, and copy the `gummie_id` from the URL

Sanity-check each by hand before spending a run:

> How many observations were taken in 2023?

v1 should answer **217** after running an explicit `COUNT`. If it answers
without querying, the connector is not attached to that agent.

## 5 · Run the experiments

```bash
cp .env.example .env
```

Two values to fill in, and they live on different pages:

| | |
|---|---|
| `GUMLOOP_API_KEY` | [Connectors](https://www.gumloop.com/settings/profile/connectors?view=connected) — not Profile. Pro plan or above. |
| `GUMLOOP_USER_ID` | [Profile → General](https://www.gumloop.com/settings/profile/general), under your email |

Leave `GUMLOOP_GUMMIE_ID` blank; it is passed per run.

Smoke-test first — 4 questions, 1 trial, a few cents:

```bash
GUMLOOP_GUMMIE_ID=<v1 id> RUN_NAME=smoke EVAL_LIMIT=4 TRIAL_COUNT=1 npm run experiment
```

Open `runs/smoke.json` and check the `trajectory` on each row. **Every row
showing an empty trajectory means the transcript is not being parsed** — check
the `toolName` in the raw response against `isQueryTool` in
[`evals/gumloop.ts`](../evals/gumloop.ts) before running the full set. Catching
that at 4 interactions instead of 84 is the difference between a few cents and
most of an afternoon's credits.

Then the comparison, baseline first:

```bash
GUMLOOP_GUMMIE_ID=<v1 id> RUN_NAME=v1-grounded npm run experiment
GUMLOOP_GUMMIE_ID=<v2 id> RUN_NAME=v2-concise  npm run experiment

npm run gate -- --baseline v1-grounded --candidate v2-concise --by case_type
```

## 6 · Set the floors from the baseline

The floors in [`evals/thresholds.json`](../evals/thresholds.json) are starting
positions, not measurements. Once `v1-grounded` has run, set each from what the
baseline actually scored. A floor guessed before any run tests the fixture
rather than the agent.

---

## What it costs

14 questions × 3 trials × 2 versions = 84 interactions. Measured from the
credit counter on real runs, an interaction costs **30–80 credits** — a single
clean question with one query came to 32, a nine-step exploratory one to 101.
Credits are $0.005 each.

| | interactions | ≈ credits | ≈ |
|---|---|---|---|
| Smoke run | 4 | 200 | $1 |
| One version | 42 | 2,000 | $10 |
| Full comparison | 84 | 4,000 | $20 |

That is a fifth to a third of the Pro trial's 20,000, so it fits comfortably —
but it is not pocket change, and it is roughly three times what a per-token
estimate suggests. The gap is the compute charge (5 credits per session-minute)
plus 1 credit per tool call and the 8% orchestration fee, none of which scale
with tokens. Check the counter on a conversation before committing to a full
run.

Model inference bills through credits, so no separate Anthropic key is needed.
