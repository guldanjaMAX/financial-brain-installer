# FIELD-DEFAULT-SLUG-ADOPTION: a second install adopts the first brain

**Observed:** 2026-09-08, on a disposable provider account, running the published
macOS runbook against `brain-installer-0.4.1.tgz`, sha256
`a62cabaf7d50cdda2bd1048fda9865c1fa481b263374d81733e3521923fe5c62`, from the
published kit sha256
`68d9c40c3bbb367da4b5d23c694fe75eeaa85fc5933421f4943d205b2b642023`.

**What happened.** Two independent installs, each with its own manifest in its own
directory, both resolved to one brain. The second reported adopting the first and
reusing its durable admin key, and from the second manifest the first install's
corpus was listable.

## The reproduction, exactly

Both runs used `setup <manifest> --path <folder> --cloudflare-account existing`
with the provider token in the environment and standard input closed, which is
how an agent-driven install runs.

**Install one.** Created a worker, a database and a vector index. The manifest it
wrote records the client identity as slug `my-brain`, display name `My Brain`,
which is a default; the shipped template carries a placeholder instead. One
document, sixty chunks, drained to query-ready.

**Install two.** A fresh manifest path, a fresh smoke folder, nothing shared with
the first except the provider account. Its log reports `adopting it` and
`reusing this brain's verified durable admin key`. It created no new database.

**The result.** Both manifests carry the same brain domain. Listing sources
through the SECOND manifest returns the FIRST install's corpus: one source, one
document, sixty chunks, ingested at the first install's timestamp.

## Why the guard did not stop it

`assertAdoptable` exists precisely for this and refuses when a database already
belongs to another client:

> D1 "<name>" (<uuid>) is already the brain for "<owner>", not "<slug>".

It compares the recorded owner against the incoming client slug. Both runs took
the same default, so owner and slug matched and the check passed. The guard is
correct; it is defeated by the default that reaches it. A guard whose input is a
value neither party chose cannot distinguish two parties.

## Scope, stated honestly

This needs two installs inside ONE provider account. The product's normal shape
is a client-owned account per client, and nothing here suggests brains in
separate accounts can reach each other. The reachable cases are the ones where an
operator holds the account: a bench, a demo, a trial for several prospects, or an
operator standing up more than one brain before handing each over. Those are
ordinary things to do, and in them the second party receives the first party's
corpus and durable admin key.

## What this does not prove

Nothing about separate accounts. Nothing about the update path; both runs were
fresh installs. Nothing about whether an interactive run, where a person is asked
for the client identity, is exposed, because both runs here had standard input
closed. That last one is worth checking: if the prompt is skipped only when there
is no terminal, the exposure is specific to agent-driven installs, which is now
the main path.

## The design question this leaves

Three ways out, and the choice is a product decision rather than a bug fix.
Refuse to proceed when no client identity is supplied, which is consistent with
how this product refuses elsewhere but would stop an agent-driven install that
today succeeds. Or make the default unique per install so two runs cannot
collide, which preserves the flow and removes the collision without asking
anything of the owner. Or require adoption to be explicit, so that reusing an
existing brain is something a person asks for rather than something a matching
name causes.

Recorded rather than fixed, because choosing between those changes what every
future install does and that is not a decision to take unattended.
