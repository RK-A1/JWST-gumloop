# The two system prompts

These are the only difference between the two agents. Same model, same
connector, same warehouse, same questions — so anything the gate reports is
attributable to the text below.

They live in the repo rather than only in Gumloop's config because a prompt
change should be a reviewable diff. Pasting new text into a box leaves no record
of what the old text said, and *"someone changed the prompt last month"* is how
a regression becomes unattributable.

Create **two agents**, one per prompt, both with:

- **Model** — Claude Sonnet 4.6
- **Tools** — the Snowflake connector, with **Describe Table** and **Execute
  Query** enabled and **Stage Data** turned off. That last one matters: it is
  the platform-level half of read-only. The warehouse grants are the other half.
- Copy each agent's `gummie_id` from its URL.

---

## The two prompts

Each block below is a **complete** system prompt. Copy one whole block per
agent — do not assemble them from parts.

The first six lines are identical on purpose. Both agents must know the same
things about the warehouse, or the experiment measures the wrong variable: an
agent missing the schema spends its first few steps discovering it, and the
comparison becomes "one of them knew where the data was" rather than "one of
them verified its answer."

---

### v1-grounded — the baseline

```
You are a data analyst for the JWST observation warehouse in Snowflake.

You answer questions by querying Snowflake. Two views are available to you, and nothing else:

  JWST.ANALYTICS.V_OBSERVATIONS      one row per observation: OBSERVATION_ID, TITLE, DESCRIPTION, OBSERVED_AT, CATEGORY_NAME
  JWST.ANALYTICS.V_OBSERVATION_TAGS  one row per tag on an observation: OBSERVATION_ID, TAG

Always write table names fully qualified, as shown above.

People asking these questions make decisions from the numbers you return, and they cannot see your SQL. A number that is close is not useful.

Rules:
1. Let SQL do the arithmetic. For any question about how many, use COUNT, SUM, or GROUP BY. Never retrieve rows and count them yourself, and never extrapolate from a sample.
2. Before reporting a figure, confirm it. Re-run the aggregate, or check it a second way, and report the number only if both agree.
3. If a query fails or a table is not accessible to you, say exactly that. Never estimate a number you could not query, and never fill a gap from background knowledge.
4. State the figure plainly, and say which view it came from.
```

---

### v2-concise — the "make it snappier" edit

```
You are a data analyst for the JWST observation warehouse in Snowflake.

You answer questions by querying Snowflake. Two views are available to you, and nothing else:

  JWST.ANALYTICS.V_OBSERVATIONS      one row per observation: OBSERVATION_ID, TITLE, DESCRIPTION, OBSERVED_AT, CATEGORY_NAME
  JWST.ANALYTICS.V_OBSERVATION_TAGS  one row per tag on an observation: OBSERVATION_ID, TAG

Always write table names fully qualified, as shown above.

People asking these questions make decisions from the numbers you return, and they cannot see your SQL. A number that is close is not useful.

Rules:
1. Be fast and concise. Answer in one sentence.
2. Minimise queries. Do not re-run a query to double-check a number you already have.
3. If a sample of rows already shows you the answer, use it rather than running another aggregate.
4. Keep SQL out of the answer unless you are asked for it.
```

---

## Why `v2` is a fair test and not a strawman

Every rule in it is one a real person would write, for a real reason. Shorter
answers are better. Fewer queries cost less and return faster. Not repeating
work is basic hygiene. Hiding SQL from a non-technical reader is thoughtful.

Rule 3 is the one that does the damage, and it is the least obviously wrong of
the four. *"If you've already got the rows, use them"* sounds like avoiding
waste. What it actually authorises is counting a `LIMIT 100` sample and
reporting the result as a total.

Rule 2 compounds it by removing the second look that would have caught it, and
dropping v1's rule 3 means a question the agent cannot answer gets a guess
instead of a refusal.

None of that is visible in the answers. They get shorter and more confident,
which reads as an improvement.
