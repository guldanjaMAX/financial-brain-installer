/**
 * S10-R: policy violations hidden behind YAML spellings that GitHub accepts.
 *
 * Each entry is [name, mutate], where mutate turns the real workflow text into
 * a copy that GitHub would load with a policy violation: an unpinned action, an
 * extra repository checkout, a checkout that persists its token, or a widened
 * permission. The violation is spelled with a step dash followed by several
 * spaces, a quoted key, a comment in an unusual place, or a mixed-case action
 * name, so a reader that misses the spelling passes the mutated workflow.
 *
 * Shared by the installer-signing and machine-prep tests so both policy checks
 * are held to the same list.
 */

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const FIRST_STEPS = /^    steps:\n/m;
// The first unsigned checkout, exactly as the reviewed workflow spells it.
const UNSIGNED_CHECKOUT = new RegExp(
  `^      - uses: actions/checkout@${CHECKOUT_SHA} # v7\\.0\\.1\\n        with:\\n          persist-credentials: false\\n`, "m");

/** Insert `step` (already indented as a step item) as the first step of the first job. */
const firstStep = (step) => (text) => text.replace(FIRST_STEPS, (steps) => `${steps}${step}`);

/** Mutations that apply to either workflow: each adds a step that breaks the policy. */
const commonMutations = [
  ["a multi-space step dash hiding a double-quoted unpinned uses", firstStep(
    '      -   name: extra step\n          "uses": actions/setup-node@v7\n')],
  ["a three-space step dash with aligned keys hiding an unpinned uses", firstStep(
    "      -   name: extra step\n          uses: actions/setup-node@v7\n")],
  ["a multi-space step dash with a comment line between keys", firstStep(
    "      -   name: extra step  # looks harmless\n          # the next key is pinned elsewhere\n" +
      "          'uses': actions/setup-node@v7  # latest\n")],
  ["a multi-space step dash with a # inside a quoted unpinned uses", firstStep(
    '      -   name: extra step\n          "uses": "actions/setup-node@v7 # 820762786026740c76f36085b0efc47a31fe5020"\n')],
  ["comment lines between a step's keys and a quoted unpinned uses", firstStep(
    "      - name: extra step # note\n        # uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n" +
      "        'uses': 'actions/setup-node@v7' # trailing\n")],
  ["a single-quoted with key on a step that runs an unpinned action", firstStep(
    "      - uses: actions/setup-node@v7\n        'with':\n          node-version: 24\n")],
];

/** installer-signing.yml: no checkout at all, only the declared scopes. */
export const SIGNING_SPELLING_MUTATIONS = [
  ...commonMutations,
  ["a multi-space step dash hiding a single-quoted checkout", firstStep(
    `      -   name: fetch the repository\n          'uses': actions/checkout@${CHECKOUT_SHA}\n` +
      "          with:\n            persist-credentials: false\n")],
  ["a mixed-case checkout that persists its token", firstStep(
    `      - uses: Actions/Checkout@${CHECKOUT_SHA} # v7.0.1\n        with:\n          persist-credentials: true\n`)],
  ["an upper-case checkout with no with block", firstStep(`      - uses: ACTIONS/CHECKOUT@${CHECKOUT_SHA}\n`)],
  ["a commented, quoted permissions block widening contents", (text) => text.replace(
    /^    permissions:\n      contents: read\n      actions: read\n    steps:/m,
    "    permissions:  # read only\n      # contents stays read\n      'contents': write # read\n      \"actions\": read\n    steps:")],
];

/** machine-prep-installers.yml: exactly two checkouts, both non-persisting. */
export const UNSIGNED_SPELLING_MUTATIONS = [
  ...commonMutations,
  ["a multi-space step dash with quoted with and persist-credentials keys that persist the token",
    (text) => text.replace(UNSIGNED_CHECKOUT,
      `      -   name: check out\n          "uses": actions/checkout@${CHECKOUT_SHA}\n` +
        "          'with':\n            \"persist-credentials\": true\n")],
  // The plain added checkout keeps a case-sensitive count at two, so only a
  // case-insensitive reader notices the mixed-case one persists its token.
  ["a mixed-case checkout that persists its token beside an added plain checkout",
    (text) => text.replace(UNSIGNED_CHECKOUT,
      `      - uses: Actions/Checkout@${CHECKOUT_SHA} # v7.0.1\n        with:\n          persist-credentials: true\n` +
        `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1\n        with:\n          persist-credentials: false\n`)],
  ["an extra mixed-case checkout", firstStep(
    `      - uses: actions/CHECKOUT@${CHECKOUT_SHA}\n        with:\n          persist-credentials: false\n`)],
  ["a quoted persist-credentials key set to true", (text) => text.replace(
    /^          persist-credentials: false$/m, '          "persist-credentials": true')],
  ["a trailing comment claiming persist-credentials is false", (text) => text.replace(
    /^          persist-credentials: false$/m, "          persist-credentials: true # false")],
  ["a commented, quoted top-level permissions block widening contents", (text) => text.replace(
    /^permissions:\n  contents: read$/m, "\"permissions\":  # read only\n  # contents: read\n  'contents': write # read")],
];

// S11: characters YAML and GitHub read differently from this suite's parser. A
// line break other than LF (lone CR, CRLF, NEL, LS, PS) can split a line the
// parser sees as one, hiding a step; a Unicode space or U+FEFF that JavaScript's
// trim removes lets a spoofed key such as `permissions<NBSP>:` read as the real
// one here while GitHub loads a different key and falls back to its default
// token scopes. Rather than chase each spelling, every workflow file must be
// printable ASCII plus LF, and each entry below must fail that rule.
//
// Each entry is [name, code point the check must name, mutate]. Every mutate
// applies to both reviewed workflows.

// A trailing comment swallows the rest of what this parser reads as one line,
// while YAML breaks the line at the separator and loads the step after it.
const hiddenStep = (separator) => firstStep(
  `      - run: echo ready  # reviewed${separator}      - uses: actions/setup-node@v7\n`);
const spoofedPermissionsKey = (character) => (text) => text.replace(/^permissions:/m, `permissions${character}:`);

export const CHARACTER_MUTATIONS = [
  ["a lone CR hiding an unpinned step", 0x0d, hiddenStep("\r")],
  ["CRLF line endings", 0x0d, (text) => text.replaceAll("\n", "\r\n")],
  ["a NEL (U+0085) hiding an unpinned step", 0x85, hiddenStep("\u0085")],
  ["a line separator (U+2028) hiding an unpinned step", 0x2028, hiddenStep("\u2028")],
  ["a paragraph separator (U+2029) hiding an unpinned step", 0x2029, hiddenStep("\u2029")],
  ["a no-break space spoofing the top-level permissions key", 0xa0, spoofedPermissionsKey("\u00a0")],
  ["a U+FEFF spoofing the top-level permissions key", 0xfeff, spoofedPermissionsKey("\ufeff")],
  ["a leading byte-order mark", 0xfeff, (text) => `\ufeff${text}`],
  ["a tab separating a step's run key from its value", 0x09, firstStep("      - run:\techo ready\n")],
];
