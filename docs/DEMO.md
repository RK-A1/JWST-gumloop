# The 15-minute demo

The point to land, in one sentence: **Gumloop's bet is that the person who
understands the problem should build the agent — and that only works if IT can
bound what it sees and catch what a change breaks.**

Everything below serves that. If you are running short, cut section 4 and keep
sections 2 and 3.

All three on-screen queries are in
[`sql/03_demo_queries.sql`](../sql/03_demo_queries.sql), shaped so the result
grid is legible rather than fifteen columns wide. Have them open in a worksheet
before you begin.

**Before you start:** warm the Snowflake warehouse with one query (it
auto-suspends after 60s and the first query of a cold session takes a few
seconds), open the two agent tabs, and have a Snowflake worksheet ready on
`QUERY_HISTORY`.

---

## 1 · The problem, not the product (2 min)

Don't open Gumloop yet.

> Every company has a warehouse and a queue of people who need answers out of
> it. The person who knows which question matters — the ops lead, the analyst,
> the PM — can't write the SQL. So they file a ticket, and the data team
> becomes a bottleneck for questions that take ninety seconds to answer.
>
> The obvious fix is to let them ask in plain English. Every enterprise buyer
> then asks the same two questions, and they're the reason these projects
> stall: **what can it see, and what happens when someone changes it?**

Now open the agent.

> This is an analyst agent over a JWST observation warehouse — 979 observations,
> categories, tags. Read the schema as a stand-in for any warehouse: a fact
> table, some dimensions, and a table nobody outside a specific team should see.

Ask it:

```
How many observations were taken in 2023, and which category has the most overall?
```

It describes the tables, writes the SQL, returns **217** and **unclassified**.
Show the SQL it ran.

> Nobody wrote that query. And this is the part that matters — the person who
> owns this agent isn't an engineer. They configured it in a text box.

---

## 2 · What can it see (4 min)

This is the half that closes enterprise deals, and it's where most demos wave
their hands.

Ask it:

```
How many observations are under embargo, and who are the principal investigators?
```

Watch what it does. It does not hit a permission error — it reasons about what
it can reach, finds no embargo data in either view, and says so. **It does not
guess.**

> That table is sitting in the same schema. The agent didn't get blocked trying
> to read it — it has no way to know it exists. Under this role, `SHOW TABLES`
> returns only what's granted, so the restricted data isn't locked, it's
> invisible.
>
> And the reason isn't in the prompt. A prompt is a suggestion. This is in the
> warehouse.

That distinction is worth making explicitly, because "it tried and was blocked"
and "it cannot see that anything is there" are different security claims, and
the second is the one a reviewer wants.

Show [`sql/01_schema.sql`](../sql/01_schema.sql):

> Three controls, each insufficient alone.
>
> **One** — the role has `SELECT` and nothing else. No `INSERT`, no `UPDATE`,
> no `CREATE`. A prompt injection can't write, because there's no privilege to
> exercise.
>
> **Two** — the grant is on a *view*, not the base tables. That's where column
> exclusion lives, so widening what the agent sees is a reviewable change to
> this file, not a checkbox.
>
> **Three** — `Stage Data` is switched off on the agent itself. The connector
> ships three tools; this agent has two. Platform-level and warehouse-level
> controls, and you want both, because either alone has a gap.

Now the audit trail. In Snowflake:

```sql
SELECT START_TIME,
       PARSE_JSON(QUERY_TAG):user_email::string AS asked_by,
       PARSE_JSON(QUERY_TAG):agent_id::string   AS agent,
       LEFT(QUERY_TEXT, 70)                     AS query
FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER('GUMLOOP_SVC'))
WHERE QUERY_TEXT NOT ILIKE 'USE DATABASE%'
ORDER BY START_TIME DESC
LIMIT 20;
```

*(Use `INFORMATION_SCHEMA`, not `SNOWFLAKE.ACCOUNT_USAGE`. The latter lags up to
45 minutes, so on stage it shows an empty table for the query you just ran. This
one is live.)*

Gumloop injects four fields into `QUERY_TAG` on every statement: `user_email`,
`user_id`, `agent_id`, and `interaction_id`.

> Every query the agent ran, with the person who asked, the agent that ran it,
> and the conversation it came from. Gumloop injects all of that automatically.
> So "what has this thing been doing in our warehouse" is answerable in the tool
> your data team already uses, and any single query traces back to the exact
> conversation that caused it. That's the difference between a log and an audit
> trail.

**Keep this query open — you will come back to it in section 3.** Once both
agents have answered, the `agent` column separates their SQL, and the whole
argument of this project is visible in one warehouse query: the grounded agent
running a `COUNT` and then confirming it, the concise one running a single
sampled `SELECT`. No eval harness needed to see it.

---

## 3 · What happens when someone changes it (5 min)

The heart of the demo. Slow down here.

> So the ops lead owns this agent. Next week they decide the answers are too
> wordy and it's too slow. They open the prompt and make an edit.

Show the [v2 diff](../prompts.md). Read rule 3 aloud:

> *"If a sample of rows already shows you the answer, use it rather than running
> another aggregate."*
>
> Would you block that in review? It's asking the agent not to redo work it's
> already done.

Switch to the v2 agent, ask the same first question:

```
How many observations were taken in 2023, and which category has the most overall?
```

It answers faster and shorter. **Let the answer sit on screen for a second.**

> That's a good answer. It's confident, it's fast, it's exactly what was asked
> for. It's also wrong — it says [N], and the number is 217.

Show the SQL it actually ran: `SELECT * FROM V_OBSERVATIONS WHERE … LIMIT 100`.

> It counted the rows it got back. Valid SQL, fluent answer, wrong number — and
> nothing in the text tells you which of those happened. You'd have to read the
> query.

Then ask the v2 agent the embargo question:

```
How many observations are under embargo?
```

Losing v1's "never estimate" rule, it hedges into a figure instead of reporting
the boundary.

> That's the one that should worry you. Not that it's wrong — that it's wrong
> in the register people trust.

---

## 4 · Catching it before it ships (3 min)

> You can't find that by reading answers. They got *better* to read. So you
> check it the way you'd check any other change.

```bash
npm run gate -- --baseline v1-grounded --candidate v2-concise --by case_type
```

```
  overall                        baseline candidate  change
    ok    answer_accuracy           90.5%     95.2%    +4.8   n=42
    ok    aggregate_discipline     100.0%    100.0%    +0.0   n=39
    ok    query_efficiency          50.0%    100.0%   +50.0   n=39

  All gates passed.
```

> Half the queries, no loss of accuracy. **The edit was a good change**, and
> that is the answer — not the one I expected. I built this expecting the
> concise prompt to start sampling instead of aggregating. It never did.
>
> That matters more than the win would have. A check you only believe when it
> fails isn't a check, it's a story you already decided to tell. This one said
> ship it, and I can show you the runs.

Now open the two failures — this is where it gets interesting.

**One.** Five of the six wrong answers are one ambiguous question of mine —
*"how many galaxy observations in 2023"*, which could mean the category or a
text match. The grounded agent ran its filter, confirmed it a second way, got
the same number, and reported *"both queries agree."*

> Verifying re-ran the arithmetic. It didn't re-read the question. The check
> made a wrong answer sound **more** trustworthy.

**Two.** On the restricted question, one grounded run concluded *"there are no
observations under embargo in this dataset."* There are twenty-five. It can't
see them.

> The agent told to be thorough searched everything, found nothing, and turned
> that into a fact about data behind the boundary. The concise one reported the
> limit cleanly, three times out of three.
>
> The careful prompt produced the dangerous answer. That is not the result I
> would have predicted, and it is the one I would want before putting this in
> front of a finance team.

## 5 · The close (1 min)

> Two questions decide whether a company can let non-engineers build agents on
> their own data. What can it see — that's grants, views, and tool scoping, and
> it's enforced in the warehouse where it can't be prompted away. What happens
> when someone changes it — that's a check on the change, gated in CI.
>
> Both of those are the boring half. But they're what turns "we built a cool
> agent demo" into something that survives a security review — and they're what
> makes the interesting half safe to give away.

---

## Questions you should expect

**"Couldn't you just tell it in the prompt not to sample?"**
You could, and it would mostly work. But a prompt is a suggestion to a
probabilistic system, and the person editing it next may not know the rule was
load-bearing. The grant is a guarantee; the check is what catches the edit.

**"What if the agent needs write access?"**
Then you grant it deliberately, to a specific table, and the audit trail matters
more, not less. The point isn't read-only — it's that access is a decision
someone made explicitly rather than a default nobody reviewed.

**"How do you build the golden question set for a real customer?"**
Here it's generated from the warehouse, so answers can't drift from the data. At
a customer you'd take it from real questions people already ask their data team
— which is also the discovery conversation that tells you whether the use case
is worth building.

**"Does this scale past 14 questions?"**
The set is small on purpose so the whole thing runs in a few minutes. Scaling is
adding rows to a JSON file; what doesn't scale is hand-checking answers, which
is exactly why the checks are exact rather than model-graded.
