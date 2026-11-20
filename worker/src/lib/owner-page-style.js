/** Shared light styles for owner task pages. No scripts or external assets. */
export const OWNER_PAGE_CSS = `
:root {
  color-scheme: light;

  --color-paper: #faf9f6;
  --color-card: #ffffff;
  --color-ink: #1a1a1a;
  --color-ink-soft: #5c6472;
  --color-line: #e6e2da;
  --color-line-strong: #cfc9bd;
  --color-accent: #3b5bdb;
  --color-accent-ink: #ffffff;
  --color-accent-soft: #eef1fd;

  --color-good: #166534;      --color-good-bg: #ecfdf3;   --color-good-line: #bbe5c8;
  --color-wait: #1e4f7a;      --color-wait-bg: #eff6fc;   --color-wait-line: #c7def2;
  --color-act: #8a4b08;       --color-act-bg: #fff8eb;    --color-act-line: #f3d9a6;
  --color-bad: #a1251b;       --color-bad-bg: #fdf1f0;    --color-bad-line: #f1c2bd;
  --color-neutral-bg: #f4f2ee;

  --gutter: 16px;
  --container: 72rem;
  --container-task: 40rem;
  --measure: 42rem;

  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px;

  --font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-xs: 0.78125rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.0625rem;
  --text-lg: 1.25rem;
  --text-xl: clamp(1.65rem, 3vw, 2.2rem);
  --leading-tight: 1.2;  --leading-body: 1.55;  --leading-prose: 1.65;
  --weight-medium: 500;  --weight-semibold: 600;

  --radius-sm: 8px;
  --radius-control: 10px;
  --radius-card: 16px;
  --border: 1px;
  --shadow-card: 0 1px 2px rgba(26, 26, 26, 0.04);

  --control-h: 44px;
  --control-pad-x: 16px;
  --control-gap: 8px;
  --action-gap: 12px;
}

@media (min-width: 640px)  { :root { --gutter: 24px; } }
@media (min-width: 1024px) { :root { --gutter: 32px; } }

*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--color-paper); color: var(--color-ink);
  font: var(--text-base)/var(--leading-body) var(--font-sans); -webkit-text-size-adjust: 100%; }
a { color: var(--color-accent); text-underline-offset: 3px; }
h1, h2, h3, p { margin: 0; }

.task { max-width: var(--container-task); margin: 0 auto; padding: var(--space-6) var(--gutter) var(--space-12); }
.back { font-size: var(--text-sm); color: var(--color-ink-soft); text-decoration: none; display: inline-block; margin-bottom: var(--space-4); }
.back:hover { color: var(--color-accent); }
.h1 { font-size: var(--text-xl); font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; }
.lede { color: var(--color-ink-soft); font-size: var(--text-sm); line-height: var(--leading-prose); margin-top: var(--space-2); max-width: var(--measure); }

.card { background: var(--color-card); border: var(--border) solid var(--color-line); border-radius: var(--radius-card);
  box-shadow: var(--shadow-card); padding: var(--space-4); }
@media (min-width: 640px) { .card { padding: var(--space-5); } }
.stack > * + * { margin-top: var(--space-3); }
.rows { margin: var(--space-4) calc(-1 * var(--space-4)) calc(-1 * var(--space-4)); border-top: 1px solid var(--color-line); }
@media (min-width: 640px) { .rows { margin: var(--space-4) calc(-1 * var(--space-5)) calc(-1 * var(--space-5)); } }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-line); }
@media (min-width: 640px) { .row { padding: var(--space-3) var(--space-5); } }
.row:last-child { border-bottom: 0; }
.row-main { min-width: 0; flex: 1 1 14rem; }
.row-title { font-size: var(--text-base); font-weight: var(--weight-medium); }
.meta { font-size: var(--text-sm); color: var(--color-ink-soft); }
.mono { font-family: var(--font-mono); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--control-h);
  padding: 0 var(--control-pad-x); border-radius: var(--radius-control); font: var(--weight-semibold) 0.9375rem/1 var(--font-sans);
  border: var(--border) solid transparent; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn-primary { background: var(--color-accent); color: var(--color-accent-ink); }
.btn-secondary { background: var(--color-card); color: var(--color-ink); border-color: var(--color-line-strong); }
.btn-quiet { background: transparent; color: var(--color-accent); padding: 0 var(--space-2); margin: 0 calc(-1 * var(--space-2)); font-weight: var(--weight-medium); }
.btn-quiet.danger { color: var(--color-bad); }
.btn[disabled] { opacity: .5; cursor: default; }
.actions { display: flex; flex-wrap: wrap; gap: var(--action-gap); align-items: center; margin-top: var(--space-4); }
select, input[type=text] { min-height: var(--control-h); padding: 0 var(--space-3); border-radius: var(--radius-control);
  border: var(--border) solid var(--color-line-strong); background: var(--color-card); color: var(--color-ink); font: inherit; }
.control-row { display: flex; gap: var(--control-gap); align-items: center; flex-wrap: wrap; }
.control-row select { flex: 1 1 11rem; min-width: 0; }

.chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); font-weight: var(--weight-medium);
  padding: 2px 9px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.chip.good { color: var(--color-good); background: var(--color-good-bg); border-color: var(--color-good-line); }
.chip.wait { color: var(--color-wait); background: var(--color-wait-bg); border-color: var(--color-wait-line); }
.chip.act  { color: var(--color-act);  background: var(--color-act-bg);  border-color: var(--color-act-line); }
.chip.bad  { color: var(--color-bad);  background: var(--color-bad-bg);  border-color: var(--color-bad-line); }

.notice { display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-control);
  border: 1px solid; font-size: var(--text-sm); line-height: var(--leading-body); }
.notice.wait { color: var(--color-wait); background: var(--color-wait-bg); border-color: var(--color-wait-line); }
.notice.bad  { color: var(--color-bad);  background: var(--color-bad-bg);  border-color: var(--color-bad-line); }
.code { font-size: var(--text-xs); color: var(--color-ink-soft); margin-top: var(--space-1); }

.steps { list-style: none; padding: 0; margin: var(--space-6) 0 0; }
.step { display: grid; grid-template-columns: 32px minmax(0,1fr); column-gap: var(--space-3); }
.step + .step { margin-top: var(--space-3); }
.dot { width: 32px; height: 32px; border-radius: 999px; display: grid; place-items: center; font-weight: 700; font-size: var(--text-sm);
  background: var(--color-neutral-bg); color: var(--color-ink-soft); }
.step.done .dot { background: var(--color-good-bg); color: var(--color-good); border: 1px solid var(--color-good-line); }
.step.current .dot { background: var(--color-accent); color: var(--color-accent-ink); }
.step-label { font-size: var(--text-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-ink-soft); }
.step.current .step-label { color: var(--color-accent); }
.step-title { font-size: var(--text-base); font-weight: var(--weight-semibold); }
.step.current .step-title { font-size: var(--text-lg); letter-spacing: -0.01em; }
.step.done .step-title { font-weight: var(--weight-medium); }
.step.done .step-body, .step.later .step-body { display: none; }
.step.later .step-title { color: var(--color-ink-soft); font-weight: var(--weight-medium); }
.step-body { grid-column: 2; margin-top: var(--space-3); }
@media (max-width: 479px) { .step-body { grid-column: 1 / -1; } }
.step-head { min-height: 32px; display: flex; flex-direction: column; justify-content: center; }

.choices { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
.choice { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); background: var(--color-card); cursor: pointer; }
.choice input { margin-top: 4px; accent-color: var(--color-accent); width: 18px; height: 18px; flex: none; }
.choice.selected { border-color: var(--color-accent); background: var(--color-accent-soft); box-shadow: 0 0 0 1px var(--color-accent) inset; }
.choice b { display: block; font-weight: var(--weight-semibold); }

.chip.neutral { color: var(--color-ink-soft); background: var(--color-neutral-bg); border-color: var(--color-line); }
.notice.act { color: var(--color-act); background: var(--color-act-bg); border-color: var(--color-act-line); }
.notice.good { color: var(--color-good); background: var(--color-good-bg); border-color: var(--color-good-line); }
.notice.inset { margin: var(--space-4); }
.code a { color: inherit; }
.task { overflow-wrap: anywhere; }
select, input:not([type=checkbox]):not([type=radio]), textarea { min-height: var(--control-h); font-size: var(--text-base); max-width: 100%; }
.btn { white-space: normal; text-align: center; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

// Escaping keeps attributes intact; this check also keeps links navigational.
function navigationHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  return /^(?:https?:\/\/|\/(?!\/)|#|\?)/i.test(value) ? value : null;
}

export function ownerMessagePage({ title, line, code, help, action } = {}) {
  const helpHref = navigationHref(help);
  const actionHref = action && !Array.isArray(action) && navigationHref(action.href);
  const codeLine = code ? `<p class="code">Code ${escapeHtml(code)} · ${helpHref
    ? `<a href="${escapeHtml(helpHref)}">What this means</a>` : "What this means"}</p>` : "";
  const actionLine = actionHref ? `<div class="actions"><a class="btn btn-primary" href="${escapeHtml(actionHref)}">${escapeHtml(action.label)}</a></div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${OWNER_PAGE_CSS}</style>
</head>
<body><main class="task"><h1 class="h1">${escapeHtml(title)}</h1><p class="lede">${escapeHtml(line)}</p>${codeLine}${actionLine}</main></body>
</html>`;
}
