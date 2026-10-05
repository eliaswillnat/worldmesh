/**
 * HTML building blocks. Server-rendered, no scripts at all: the CSP below
 * forbids them, so nothing on a page can run even if a world's name, an
 * advertiser's text or a fediverse error message contains markup (all of it
 * is escaped anyway).
 */
import type { Result } from './data';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Only http(s) links leave the dashboard; anything else renders as text. */
export function link(url: unknown, text?: unknown): string {
  const value = String(url ?? '');
  if (!/^https?:\/\//i.test(value)) return esc(text ?? value);
  return `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(text ?? value)}</a>`;
}

export function num(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** "3 min ago", "2 d ago", or the date for anything older than a month. */
export function ago(time: number, at: number): string {
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.round((at - time) / 1000);
  if (seconds < 0) return `in ${ago(at, time).replace(' ago', '')}`;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)} d ago`;
  return new Date(time).toISOString().slice(0, 10);
}

export function stat(label: string, value: string, note = ''): string {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;
}

export function stats(...tiles: string[]): string {
  return `<div class="stats">${tiles.join('')}</div>`;
}

export function panel(title: string, body: string, aside = ''): string {
  return `<section class="panel"><header><h2>${esc(title)}</h2>${aside ? `<div class="aside">${aside}</div>` : ''}</header>${body}</section>`;
}

/** A panel for a source that may have failed: its own error, never the whole page's. */
export function guarded<T>(title: string, result: Result<T>, body: (value: T) => string, aside?: (value: T) => string): string {
  if (!result.ok) return panel(title, `<p class="error">${esc(result.error)}</p>`);
  return panel(title, body(result.value), aside ? aside(result.value) : '');
}

export function table(headers: string[], rows: string[][], empty = 'Nothing here yet.'): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

/** Vertical bars, one per day; CSS only. */
export function bars(points: { label: string; n: number }[], format: (n: number) => string = num): string {
  const max = Math.max(1, ...points.map((point) => point.n));
  const total = points.reduce((sum, point) => sum + point.n, 0);
  const first = points[0]?.label ?? '';
  const last = points[points.length - 1]?.label ?? '';
  return `<div class="bars" role="img" aria-label="${esc(`${format(total)} in total`)}">${points
    .map(
      (point) =>
        `<div class="bar" title="${esc(`${point.label}: ${format(point.n)}`)}"><span style="height:${Math.max(point.n ? 3 : 0, Math.round((point.n / max) * 100))}%"></span></div>`,
    )
    .join('')}</div><div class="bars-axis"><span>${esc(first)}</span><span>max ${esc(format(max))}/day</span><span>${esc(last)}</span></div>`;
}

/** Horizontal breakdown: label, bar, value. */
export function breakdown(rows: { label: string; n: number }[], format: (n: number) => string = num): string {
  if (!rows.length) return '<p class="muted">Nothing here yet.</p>';
  const max = Math.max(1, ...rows.map((row) => row.n));
  return `<div class="breakdown">${rows
    .map(
      (row, i) =>
        `<div class="row"><span class="row-label">${esc(row.label)}</span><span class="row-bar"><span class="c${i % 5}" style="width:${Math.max(2, Math.round((row.n / max) * 100))}%"></span></span><span class="row-value">${esc(format(row.n))}</span></div>`,
    )
    .join('')}</div>`;
}

export function pill(text: string, tone: 'good' | 'warn' | 'bad' | 'info' | 'plain' = 'plain'): string {
  return `<span class="pill ${tone}">${esc(text)}</span>`;
}

const NAV: { href: string; label: string }[] = [
  { href: '/', label: 'Overview' },
  { href: '/users', label: 'Users' },
  { href: '/worlds', label: 'Worlds' },
  { href: '/live', label: 'Live' },
  { href: '/ads', label: 'Ads' },
  { href: '/federation', label: 'Fediverse' },
  { href: '/traffic', label: 'Traffic' },
  { href: '/system', label: 'System' },
];

export function layout(options: { title: string; path: string; email: string; body: string; refresh?: number; hub: string }): string {
  const nav = NAV.map(
    (item) => `<a href="${item.href}"${item.href === options.path ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />${options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}" />` : ''}
<title>${esc(options.title)} · WorldMesh admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;600;800&display=swap" />
<style>${CSS}</style></head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span>WorldMesh <span class="muted">admin</span></div>
  <nav>${nav}</nav>
  <div class="who"><span class="muted">${esc(options.email)}</span>
    <a href="${esc(options.hub)}/" target="_blank" rel="noopener">Open hub ↗</a>
    <form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></div>
</header>
<main><h1>${esc(options.title)}</h1>${options.body}</main>
</body></html>`;
}

export function messagePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" /><title>${esc(title)} · WorldMesh admin</title><style>${CSS}</style></head>
<body><main class="narrow"><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy':
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #0a0a0a; --muted: #6b6b6b; --line: #e6e6e6; --card: #f6f6f6; --hover: #efefef;
  --blue: #3f8fe0; --green: #2f9e5b; --purple: #7b61d6; --pink: #d0558f; --orange: #d9822b; --red: #d64545; --bar: #0a0a0a; }
@media (prefers-color-scheme: dark) { :root { --bg: #000000; --fg: #f4f4f4; --muted: #8a8a8a; --line: #1f1f1f; --card: #0d0d0d; --hover: #161616;
  --blue: #8ec8ff; --green: #9ee6b0; --purple: #c4b0ff; --pink: #f0a8cc; --orange: #ffc48a; --red: #ff8f8f; --bar: #f4f4f4; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Urbanist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: inherit; text-underline-offset: 3px; }
code, .mono { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.muted { color: var(--muted); }
.top { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 20px; padding: 10px 24px; flex-wrap: wrap; }
.brand { font-weight: 800; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
.brand .muted { font-weight: 400; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--fg); display: inline-block; }
nav { display: flex; gap: 2px; overflow-x: auto; flex: 1; scrollbar-width: none; }
nav a { text-decoration: none; padding: 6px 12px; border-radius: 999px; color: var(--muted); white-space: nowrap; font-weight: 600; }
nav a:hover { background: var(--hover); color: var(--fg); }
nav a[aria-current] { background: var(--fg); color: var(--bg); }
.who { display: flex; align-items: center; gap: 14px; font-size: 13px; }
.who form { margin: 0; }
button { font: inherit; font-size: 13px; background: none; color: var(--fg); border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; cursor: pointer; }
button:hover { background: var(--hover); }
main { max-width: 1200px; margin: 0 auto; padding: 28px 24px 64px; }
main.narrow { max-width: 520px; padding-top: 12vh; }
h1 { font-size: 34px; font-weight: 800; letter-spacing: -.02em; margin: 0 0 24px; }
h2 { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin: 0; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; }
.stat-label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.stat-value { font-size: 30px; font-weight: 800; letter-spacing: -.02em; line-height: 1.2; margin-top: 4px; font-variant-numeric: tabular-nums; }
.stat-note { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.grid .wide { grid-column: 1 / -1; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 18px; margin-bottom: 16px; min-width: 0; }
.grid > .panel { margin-bottom: 0; }
.panel > header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.aside { font-size: 13px; color: var(--muted); }
.error { color: var(--red); margin: 0; }
.table-wrap { overflow-x: auto; margin: 0 -4px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.cell-main { font-weight: 600; }
.cell-sub { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 8px; background: var(--line); }
td:has(> .cover) { width: 88px; }
.cover { width: 72px; height: 54px; border-radius: 8px; object-fit: cover; background: var(--line); display: block; }
.pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--line); white-space: nowrap; }
.pill.good { color: var(--green); border-color: currentColor; }
.pill.warn { color: var(--orange); border-color: currentColor; }
.pill.bad { color: var(--red); border-color: currentColor; }
.pill.info { color: var(--blue); border-color: currentColor; }
.bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; }
.bar { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.bar span { display: block; width: 100%; background: var(--bar); border-radius: 3px 3px 0 0; min-height: 0; }
.bar:hover span { background: var(--blue); }
.bars-axis { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 6px; }
.breakdown .row { display: grid; grid-template-columns: minmax(80px, 160px) 1fr auto; align-items: center; gap: 12px; padding: 5px 0; font-size: 14px; }
.row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-bar { height: 10px; background: var(--hover); border-radius: 999px; overflow: hidden; }
.row-bar span { display: block; height: 100%; border-radius: 999px; }
.row-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.c0 { background: var(--blue); } .c1 { background: var(--green); } .c2 { background: var(--purple); } .c3 { background: var(--pink); } .c4 { background: var(--orange); }
.search { display: flex; gap: 8px; margin-bottom: 16px; }
.search input { flex: 1; font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 999px; padding: 9px 16px; }
.search button { padding: 9px 18px; font-size: 14px; }
.todo { margin: 0; padding: 0; list-style: none; }
.todo li { padding: 9px 0; border-bottom: 1px solid var(--line); }
.todo li:last-child { border-bottom: 0; }
.callout { border: 1px dashed var(--line); border-radius: 14px; padding: 14px 16px; color: var(--muted); font-size: 14px; }
.peers { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 6px; box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 25%, transparent); }
.button { display: inline-block; background: var(--fg); color: var(--bg); text-decoration: none; padding: 10px 20px; border-radius: 999px; font-weight: 700; }
@media (max-width: 640px) {
  .top { padding: 10px 16px; gap: 10px; } nav { order: 3; flex-basis: 100%; } .who { margin-left: auto; }
  .who .muted { display: none; } main { padding: 20px 16px 48px; } h1 { font-size: 28px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .stat-value { font-size: 24px; }
}
.notice { padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); } .notice.bad { color: var(--red); }
.edit { display: grid; gap: 14px; max-width: 640px; }
.edit .field { display: grid; gap: 6px; border: 0; padding: 0; margin: 0; }
.edit .field > span, .edit legend { font-weight: 600; font-size: 13px; }
.edit input:not([type=checkbox]):not([type=file]), .edit textarea { font: inherit; font-size: 16px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; width: 100%; box-sizing: border-box; }
.edit .check { display: inline-flex; gap: 6px; align-items: center; margin-right: 14px; }
.cover-row { display: flex; gap: 14px; align-items: flex-start; } .cover-row > div { display: grid; gap: 8px; flex: 1; min-width: 0; }
.edit-cover { width: 96px; aspect-ratio: 3 / 4; border-radius: 10px; object-fit: cover; background: var(--line); flex: none; }
.edit-actions { display: flex; gap: 10px; flex-wrap: wrap; } .edit-actions button { padding: 9px 18px; font-size: 14px; }
.edit-actions .primary { background: var(--fg); color: var(--bg); } .edit-actions .danger { color: var(--red); margin-left: auto; }
`;
