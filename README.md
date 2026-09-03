# JWST × Gumloop: Letting non-engineers build data analyst agents, safely

This is a working example of how Gumloop lets non-technical teams build AI
agents that query a data warehouse safely, and get their own answers out of it.

Most BI vendors sell a version of this. However, these pilots commonly die for
two reasons, and neither is the model. First, IT has no way to limit which
tables the agent can read, and "it has access to the warehouse" does not pass a
security review. Second, when the agent starts getting answers wrong, nothing
errors: the numbers still arrive in confident prose, so nobody notices.

This project addresses both. It runs on Gumloop over a Snowflake warehouse of
979 James Webb Space Telescope observations, and every number below came out of
a real run.

![The same question under two agent versions, then the governance boundary holding](assets/demo.gif)

## The situation

An ops lead has built an agent that queries a data warehouse, giving a
non-technical team the answers they need without filing a ticket. The whole
agent is a system prompt, a model and two Snowflake tools, configured in a form.
Nobody wrote a line of code, and nothing was deployed.

Which is exactly why the team can decide the agent is too slow and too wordy and
edit the prompt themselves:

> *Minimise queries. Do not re-run a query to double-check a number you already
> have. If a sample of rows already shows you the answer, use it rather than
> running another aggregate.*

But did the team break something? Are they getting the wrong answers now, or
bypassing a safeguard? Should they feel free to do this at all?

In this project, two prompts differing only in that rules block run 14 questions
three times against each. Both the questions and their correct answers are
generated from the warehouse, so nothing is graded against a number I typed in
by hand.

## What I found

Handing the prompt to the team is only defensible if a bad edit would show up
somewhere before anyone acts on it.

```
  overall                        baseline candidate  change
    ok    answer_accuracy           90.5%     95.2%    +4.8   n=42
    ok    aggregate_discipline     100.0%    100.0%    +0.0   n=39
    ok    query_efficiency          50.0%    100.0%   +50.0   n=39

  All gates passed.
```

**The edit was a good change.** It halved the queries and lost no accuracy.

That is not the result I expected. I wrote the concise prompt to push the agent
into counting a `LIMIT 100` sample instead of asking SQL for the count, and
Sonnet 4.6 counted properly every time. I went looking for a regression and did
not find one, which turned out to be the more useful outcome. A pass is what
lets the team keep their change.

All three checks behind those numbers are exact, and none of them calls a model
to grade. Ask a judge whether "roughly 90" matches "92" and it will sometimes
say yes, which for a data agent is the exact failure you are trying to catch.
The limits live in [one small file](evals/thresholds.json), so raising one is a
decision somebody signs off on rather than a number buried in code.

## The six wrong answers

That settles the first question: nothing broke, and the agent got cheaper. The
second was whether the team is getting wrong answers now. Six times out of 84
they were, and the two causes taught me more than the pass did.

**Verifying confirmed the arithmetic and missed the misreading.** Five came from
one ambiguous question of mine. The grounded agent ran its filter, ran it a
second way, got the same number, and reported *"Both queries agree"*. That made
a wrong answer sound more trustworthy than an unverified one would have. The
double-check validated the arithmetic, and the mistake was in reading the
question.

**The careful agent produced the dangerous answer.** The sixth was a grounded run
on the restricted question, concluding *"there are no observations under embargo
in this dataset."* There are twenty-five, and it can't see them. Told to be
thorough, it searched everything, found nothing, and turned that into a claim
about data behind a security boundary. The concise agent said it could not see
the data, three times out of three: **66.7% against 100%** on that question.

## What the worst edit could have done

The last question was whether the team should feel free to edit the agent at
all. That depends on what a bad edit could actually reach.

The limits are enforced by Snowflake grants rather than by instructions in the
prompt, because the model can ignore an instruction and cannot ignore a grant.

![Five grants, none of them the embargo table](assets/grants.png)

The role holds `SELECT` and nothing else, granted on views rather than tables,
so a prompt injection has no write privilege to exercise and widening access is
a reviewable diff in [`sql/01_schema.sql`](sql/01_schema.sql).
`OBSERVATION_EMBARGO` is never granted at all, so the agent does not hit a
permission error. It cannot see that the table exists, which is the boundary the
sixth wrong answer ran into above. It reaches all of this as `GUMLOOP_SVC`, a
service identity with one role, key-pair authentication and no password.

Whatever the agent does inside those limits is on the record. Every statement
lands in `QUERY_HISTORY`, tagged with the user who asked, the agent that ran it
and the conversation it came from:

![Every query, with who asked and which agent](assets/audit.png)

The same log is where a prompt edit shows up in production. This is one person
asking the same question of both versions of the agent:

![Six queries from the grounded agent, three from the concise one](assets/two-agents.png)

The grounded version counts, then asks the same question a second way. The
concise version counts once. The data team can watch the shape of the SQL
change, grouped by agent, in a tool they already use every day.

So the worst a bad edit can do is produce a wrong answer, drawn from data the
agent was already allowed to read, with a record of every query it ran on the
way there. That is why the team can be left to edit the agent themselves, and
it is the answer to both objections at the top: what the agent sees is scoped
by IT, and a quiet break has two places to show up before anyone gets hurt.

## Why Gumloop

Most of what this project leans on would otherwise be work a team has to fund.

**The people with the questions build and change the agent themselves.** The
prompt, the model and the tools are set in a form, and there is no repository to
clone or deploy. That takes the data team off the critical path, which is where
the return comes from.

**The integration and its governance arrive together.** The Snowflake connector
is native, so I did not have to write a client, handle authentication or define
tool schemas. `Stage Data` is switched off per agent, which means read-only
holds at the platform level as well as in the warehouse grants. A security
review wants to see two independent controls like that.

**The audit trail took no work at all.** Gumloop tags every statement it runs
with the user, the agent and the conversation. The screenshots above are
Snowflake reading its own log.

**It ships where people already work.** Slack and Teams are settings on the
agent rather than a separate piece of work. I did not do that here, but adoption
is the half of self-serve analytics that usually fails. Every company has a BI
tool nobody opens, and the reason is rarely that the queries were wrong.

**Where it fell short.** The connector form takes an account, a username and a
key, but it does not ask for a role, a warehouse, a database or a schema. All
four come from the user object, so pointing it at a human account will hand the
agent `ACCOUNTADMIN` while still appearing to work. The fix is the right
architecture anyway: a `TYPE = SERVICE` identity with one role and no password.
I would rather find that before a security review than during one. Gumloop's
Evaluations also grade one conversation at a time, so they cannot answer whether
a new version is worse than the one already in production, which is the gap
[`evals/gate.ts`](evals/gate.ts) fills.

## Running it

```bash
npm install && npm test     # 29 unit tests, no accounts needed
npm run fixtures            # see the gate work, no credits spent
npm run gate -- --baseline demo-baseline --candidate demo-candidate
```

[`docs/SETUP.md`](docs/SETUP.md) is the full build. It takes about 30 minutes
and roughly 4,000 of a Gumloop trial's 20,000 credits.
[`docs/DEMO.md`](docs/DEMO.md) is a 15-minute walkthrough.

```
prompts.md   the two prompts, the only difference between the runs
sql/         schema, grants and the service identity
evals/       3 checks, 14 questions, and the gate
data/        generates the SQL and the questions from one corpus file
runs/        the 84 interactions behind every number above
```

Fourteen questions is demo scale. At real scale they would come from the
questions people already send the data team, and the checks would run against
sampled production traffic rather than only in CI. What carries over is the
mechanism: bound what the agent can reach in the warehouse, and measure a change
before it ships.

Same corpus and the same argument on Braintrust, where the agent is a
tool-calling loop rather than a warehouse client:
[JWST-braintrust](https://github.com/RK-A1/JWST-braintrust).
