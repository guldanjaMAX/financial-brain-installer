# Fix-loop test picker

This developer tool selects a section of the ordered test chain. A section run
never certifies a release, even when a conservative fallback selects every
command. The final build still needs MAIN's full host gate.

Preview a selection without running any tests:

```sh
node ci/pick-tests.mjs --root . --changed worker/src/lib/example.js
node scripts/run-test-chain-parallel.mjs --changed-since HEAD~1 --plan
```

Run the selected commands through the parallel runner:

```sh
node scripts/run-test-chain-parallel.mjs --changed-since HEAD~1 --out section-out
```

The runner prints `section run, not a release verdict`. Its `results.json` has
`mode: "section"`, `certifies: false`, and a `selection` containing chain-ordered
commands, original chain indices, reasons, changed paths, and fallback notes.
`--only` and compare-only `--against` cannot be combined with `--changed-since`.
When keeping the runner outside the checkout, preserve the relative `scripts/`
and `ci/` directories to use the picker. Ordinary runner use without the new
flag still works as a standalone file.

The map follows literal static/dynamic imports, require calls, URL references,
and source-path strings through two levels. It also checks fixture/text
basenames and has default folder areas for docs, templates, skills, onboarding,
frontend and dynamic Worker loaders. The two monoliths use zero-context diff
ranges to identify named functions and their in-file callers; tests and helpers
that mention those names are selected. A whole-file `--changed brain.mjs` has
no function diff, so it falls back to the full chain. Unsupported function
shapes, removed definitions and ambiguous ranges also fall back.

Computed import/require arguments, missing local imports, and symlink components
in mapped or changed paths select the full chain. Symlinks are checked before
reading through them, including dangling links and directory aliases. A known
import in another test or a matching folder area cannot override this uncertainty.
The textual mapper can also widen for loader syntax inside comments or strings;
this costs extra work rather than dropping an uncertain consumer.

The 14 mandatory smoke commands come from the fix-loop audit list, including
`test/test-chain-complete.test.mjs`. They are matched by test path so their
existing Node flags are preserved. The API's optional `smoke` list only adds to
this set. No checked-in `test/areas.json` is needed.

An optional `--areas areas.json` replaces the default area table:

```json
[
  { "prefix": "docs/", "tests": ["test/*contract*.test.mjs"] }
]
```

The same array is accepted by `pickTests({root, changedFiles, areas, smoke})`.
The async API returns `{commands, picked, notes, total, fullChain, changedFiles,
mode, certifies}`. Changed entries may be relative paths or
`{path, oldPath, diff}` records. The `diff` must have zero context. Both sides
of a rename are considered. A supplied area rule that maps nothing cannot
justify dropping a changed path.

Changes under `migrations/` or `ci/`, package manifest/lock changes, and changes
to either chain runner refuse to narrow. Git errors, unregistered tests, missing
smoke entries, unreadable or empty dependency maps, unknown kinds and unmapped
paths also select the full chain and say why. An unreadable chain itself is a
configuration error, never an empty success. An empty diff selects only smoke
and explicitly says so.

The git path compares the supplied ref directly with the working tree, covering
committed, staged and unstaged changes. A filesystem inventory adds untracked
files without Git writes. It handles ordinary nested ignore rules and
negations; unsupported ignore syntax and global excludes can add extra
candidates and cause a full fallback. It skips Git metadata and dependency
installation directories. This conservative inventory can cost precision but
cannot certify a release.

The mapper is a heuristic, not proof of all dynamic dependencies. Recall against
four historical failures is a bounded check. No five-minute runtime claim has
been measured. The new `ci/` directory is outside the package allowlist.

Direct developer-tool tests:

```sh
node --test test/parallel-chain/pick-tests.test.mjs
node --test test/parallel-chain/picker-cli.test.mjs
node --test test/parallel-chain/picker-safety.test.mjs
node --test test/parallel-chain/run-test-chain-parallel.test.mjs
```

In a quiet-gated lane, apply that lane's wait, scratch HOME and offline
constraints before each command.
