# UPDATE-032: adoption now requires that this manifest already owned the resource

**Proved:** 2026-09-08, on a disposable provider account, against commit
`8393c20` of `release/0.4.2` packaged from a clean tree as
`brain-installer-0.4.2.tgz`, sha256
`5f5ea46b2ffd0d7c5a26220f5b4017f654aae7e3c9ce841ef3263a25b3d936a9`, installed
into an isolated prefix and run with the provider token in the environment and
standard input closed, which is how an agent-driven install runs.

The defect this closes was observed end to end on the same account earlier the
same day and is recorded in `FIELD-DEFAULT-SLUG-ADOPTION-2026-09-08.md`: two
independent manifests both took the default client identity, both resolved to
one brain, and the second reported adopting it, reused its durable admin key,
and could list the first install's corpus.

## What was run, and what happened

**Install one.** A manifest written by `brain init` with every default accepted,
so the client identity is slug `my-brain`, display name `My Brain`. It created
the database `my-brain-brain` (`5ef3bbf8-3c00-441a-9e3b-440ffcade749`), the
vector index `my-brain-brain`, six metadata indexes, thirty-one migrations and
the worker at `my-brain-brain.financialbrainai.workers.dev`.

**Install two, from a fresh manifest.** A second `brain init`, its own
directory, its own manifest, the same defaults, the same account. Nothing shared
with the first except the provider account. It was refused:

> D1 "my-brain-brain" (5ef3bbf8-3c00-441a-9e3b-440ffcade749) is already a brain,
> and this manifest has never owned it. Refusing to adopt it. A matching name is
> not proof that it is yours.

It created nothing. Its manifest recorded no database id, no vector index and no
domain, and an account inventory taken immediately afterwards held exactly the
same three databases and three vector indexes as before it ran.

**Install two, after taking the repair the refusal offers.** The refusal names
the exact manifest line to add and says that adding it is a claim of ownership,
which is why the installer will not add it. That line was added by hand and the
same command was run again. The database was then adopted, and the run was
refused a second time, one layer further in:

> Vectorize index "my-brain-brain" already exists, and this manifest did not name
> it. Refusing to adopt it. The name was derived from the client slug, so another
> install that accepted the same default would land on this exact index and the
> two would share one vector store.

So claiming the database is not enough to reach the vector store. Each resource
is guarded on its own record of ownership.

**The owning manifest still works.** Re-running install one adopted both its own
resources and reported the vector index query-ready:

> D1 "my-brain-brain" already exists (5ef3bbf8-...), adopting it
> Vectorize "my-brain-brain" already exists and this manifest names it, adopting it

## Interruption no longer strands the owner

The same run proves the second half of the fix. Ownership of the database and of
the vector index is written to the manifest at the moment each is created, before
the metadata-index wait, which ran for roughly nine minutes across six indexes.
Read mid-install, the manifest already carried both. Previously that write
happened after the wait, so an install interrupted during it left resources on
the account that its own manifest had no record of owning, and every retry was
then refused. That case was reproduced accidentally during this session: an
aborted attempt left an orphaned database and index, and the retry was refused
with the message above. The refusal was correct, and it is now recoverable
because it leads with the exact repair.

## What this does not prove

Nothing about separate provider accounts, which were never the exposure. Nothing
about the update path; every run here was a fresh install. The AI-tool
registration step failed on this machine for an unrelated reason and setup
reported so rather than claiming the connection worked, which is the intended
behaviour but means the final step of the journey was not exercised here.

## Cleanup

Every resource created for this proof was removed by exact name afterwards. The
account's pre-existing brains were verified healthy before and after.
