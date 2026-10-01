/** The dashboard's pages. Each one reads, renders, and changes nothing. */
import {
  ads,
  approveLink,
  attempt,
  avatars,
  directory,
  federation,
  ownedWorlds,
  presence,
  runChecks,
  serviceChecks,
  toMillis,
  traffic,
  userSummary,
  users,
  views,
  type CheckResult,
  type DirectoryEntry,
  type Result,
  type RoomReport,
} from './data';
import { hubOrigin, now, type Env } from './env';
import {
  ago,
  bars,
  breakdown,
  bytes,
  esc,
  guarded,
  htmlResponse,
  layout,
  link,
  money,
  num,
  panel,
  pill,
  stat,
  stats,
  table,
} from './render';
import type { AdminSession } from './session';

type Page = (request: Request, env: Env, admin: AdminSession) => Promise<Response>;

function render(env: Env, admin: AdminSession, path: string, title: string, body: string, refresh?: number): Response {
  return htmlResponse(layout({ title, path, email: admin.email, body, refresh, hub: hubOrigin(env) }));
}

function value<T>(result: Result<T>): T | null {
  return result.ok ? result.value : null;
}

function liveTotal(rooms: RoomReport[] | null): number | null {
  if (!rooms) return null;
  return rooms.reduce((sum, room) => sum + (room.stats.ok ? room.stats.value.peers.length : 0), 0);
}

function adTone(status: string): 'good' | 'warn' | 'bad' | 'info' | 'plain' {
  if (status === 'active') return 'good';
  if (status === 'pending' || status === 'awaiting_payment') return 'warn';
  if (status === 'rejected' || status === 'failed') return 'bad';
  if (status === 'approved') return 'info';
  return 'plain';
}

function healthTable(results: CheckResult[]): string {
  return table(
    ['Service', 'Status'],
    results.map((check) => [
      `<span class="cell-main">${esc(check.name)}</span><div class="cell-sub">${esc(check.url)}</div>`,
      `${check.up ? pill('Up', 'good') : pill('Down', 'bad')}<div class="cell-sub mono">${
        check.status === null ? esc(check.error ?? 'no answer') : `${check.status} · ${num(check.ms)} ms`
      }</div>`,
    ]),
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

export const overview: Page = async (_request, env, admin) => {
  const at = now(env);
  const [summary, dir, adData, fed, health] = await Promise.all([
    attempt(() => userSummary(env)),
    attempt(() => directory(env)),
    attempt(() => ads(env)),
    attempt(() => federation(env)),
    attempt(() => runChecks(env, serviceChecks(env), 3000)),
  ]);
  const listed = value(dir)?.approved ?? [];
  const live = await attempt(() => presence(env, listed.filter((w) => w.url).map((w) => ({ name: w.name ?? w.id, url: w.url! }))));

  const s = value(summary);
  const d = value(dir);
  const a = value(adData);
  const f = value(fed);
  const h = value(health);
  const liveNow = liveTotal(value(live));
  const adCount = (status: string) => a?.byStatus.find((row) => row.status === status)?.n ?? 0;
  const down = h?.filter((check) => !check.up) ?? [];

  const tiles = stats(
    stat('Users', s ? num(s.total) : '—', s ? `+${num(s.new7d)} this week · +${num(s.new24h)} today` : ''),
    stat('Online now', liveNow === null ? '—' : `${liveNow > 0 ? '<span class="live-dot"></span>' : ''}${num(liveNow)}`, 'lobby + every world'),
    stat('Worlds listed', d ? num(d.approved.length) : '—', d ? `${num(d.pending.length)} waiting for review` : ''),
    stat('Active ads', a ? num(adCount('active')) : '—', a ? `${num(adCount('pending'))} to review` : ''),
    stat('Ad revenue', a ? (a.revenue.length ? a.revenue.map((r) => money(r.cents, r.currency)).join(' + ') : money(0, 'eur')) : '—', 'captured, all time'),
    stat('Fediverse followers', f ? num(f.followers) : '—', f ? `${num(f.deliveries)} deliveries queued` : ''),
    stat('Signed in', s ? num(s.activeUsers24h) : '—', s ? `active last 24 h · ${num(s.activeSessions)} live sessions` : ''),
    stat('Services', h ? (down.length ? `<span style="color:var(--red)">${down.length} down</span>` : 'All up') : '—', h ? `${h.length} checked` : ''),
  );

  const todo: string[] = [];
  for (const world of d?.pending ?? []) {
    const approve = approveLink(env, world);
    todo.push(
      `<li>World waiting: <strong>${esc(world.name ?? world.id)}</strong> ${link(world.url, '↗')} · ${approve ? `<a href="${esc(approve)}" target="_blank" rel="noopener noreferrer">Approve</a>` : 'no approve link'}</li>`,
    );
  }
  for (const ad of a?.recent.filter((row) => row.status === 'pending') ?? []) {
    todo.push(
      `<li>Ad waiting: <strong>${esc(ad.advertiser_name)}</strong> on <code>${esc(ad.billboard_id)}</code> · <a href="${esc(hubOrigin(env))}/api/ads/admin/review?id=${esc(ad.id)}" target="_blank" rel="noopener">Review</a></li>`,
    );
  }
  for (const check of down) todo.push(`<li><strong>${esc(check.name)}</strong> is not answering (${esc(check.status ?? check.error ?? '')}).</li>`);
  if (f && f.failing > 0) todo.push(`<li>${num(f.failing)} fediverse deliveries are retrying. <a href="/federation">See errors</a></li>`);
  const sources: [string, Result<unknown>][] = [
    ['users', summary],
    ['world directory', dir],
    ['who is online', live],
    ['ads', adData],
    ['fediverse', fed],
  ];
  for (const [name, result] of sources) {
    if (!result.ok) todo.push(`<li><span class="error">Could not read ${esc(name)}:</span> ${esc(result.error)}</li>`);
  }

  const body = `${tiles}
  ${panel('Needs your attention', todo.length ? `<ul class="todo">${todo.join('')}</ul>` : '<p class="muted">Nothing waiting. 🎉</p>')}
  <div class="grid">
    ${guarded('Sign-ups, last 30 days', summary, (v) => bars(v.signups.map((p) => ({ label: p.day, n: p.n }))), (v) => `${num(v.new30d)} new`)}
    ${guarded('How people sign in', summary, (v) => breakdown(v.providers.map((p) => ({ label: p.provider, n: p.n }))), (v) => `${num(v.withUsername)} claimed a username`)}
    ${guarded('Most viewed worlds', await attempt(async () => {
      const counts = await views(env);
      const names = new Map(listed.map((w) => [w.url, w.name ?? w.id]));
      return [...counts].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([url, n]) => ({ label: names.get(url) ?? url.replace(/^https?:\/\//, ''), n }));
    }), (rows) => breakdown(rows))}
    ${guarded('Service health', health, (v) => healthTable(v), () => `<a href="/system">All checks</a>`)}
  </div>
  <p class="muted" style="margin-top:20px">Updated ${esc(new Date(at).toISOString().replace('T', ' ').slice(0, 16))} UTC · reload for fresh numbers.</p>`;
  return render(env, admin, '/', 'Overview', body);
};

// ── Users ──────────────────────────────────────────────────────────────────

export const usersPage: Page = async (request, env, admin) => {
  const at = now(env);
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 100);
  const [summary, list] = await Promise.all([attempt(() => userSummary(env)), attempt(() => users(env, query))]);
  const s = value(summary);
  const tiles = s
    ? stats(
        stat('Total', num(s.total)),
        stat('Verified email', num(s.verified)),
        stat('Usernames', num(s.withUsername)),
        stat('New, 7 days', num(s.new7d)),
        stat('New, 30 days', num(s.new30d)),
        stat('Active, 24 h', num(s.activeUsers24h)),
      )
    : '';
  const search = `<form class="search" method="get" action="/users"><input type="search" name="q" value="${esc(query)}" placeholder="Search name, email or username" aria-label="Search users" /><button type="submit">Search</button></form>`;
  const body = `${tiles}${search}${guarded(
    query ? `Results for “${query}”` : 'Newest accounts',
    list,
    (rows) =>
      table(
        ['Account', 'Username', 'Sign-in', 'Joined', 'Last seen', 'Avatars', 'Followers'],
        rows.map((user) => {
          const image = typeof user.image === 'string' && /^https:\/\//.test(user.image) ? `<img class="avatar" src="${esc(user.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '';
          const verified = user.emailVerified === 1 || user.emailVerified === true || user.emailVerified === '1';
          return [
            `${image}<span class="cell-main">${esc(user.name)}</span><div class="cell-sub">${esc(user.email)} ${verified ? '' : pill('unverified', 'warn')}</div>`,
            user.username ? link(`${hubOrigin(env)}/@${user.username}`, `@${user.username}`) : '<span class="muted">—</span>',
            esc((user.providers ?? '').split(',').filter(Boolean).join(', ') || '—'),
            esc(ago(toMillis(user.createdAt), at)),
            esc(ago(toMillis(user.lastSeen), at)),
            `<span class="mono">${num(Number(user.avatars))}</span>`,
            `<span class="mono">${num(Number(user.followers))}</span>`,
          ];
        }),
        query ? 'No account matches.' : 'No accounts yet.',
      ),
    (rows) => `${num(rows.length)} shown${rows.length >= 200 ? ' (first 200)' : ''}`,
  )}`;
  return render(env, admin, '/users', 'Users', body);
};

// ── Worlds ─────────────────────────────────────────────────────────────────

function cover(entry: DirectoryEntry): string {
  if (!entry.cover || !/^https:\/\//.test(entry.cover)) return '<div class="cover"></div>';
  return `<img class="cover" src="${esc(entry.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
}

export const worldsPage: Page = async (_request, env, admin) => {
  const at = now(env);
  const [dir, counts, owned] = await Promise.all([attempt(() => directory(env)), attempt(() => views(env)), attempt(() => ownedWorlds(env))]);
  const listed = value(dir)?.approved ?? [];
  const rooms = value(await attempt(() => presence(env, listed.filter((w) => w.url).map((w) => ({ name: w.name ?? w.id, url: w.url! })))));
  const liveByOrigin = new Map<string, number>();
  for (const room of rooms ?? []) {
    if (room.room.startsWith('world:') && room.stats.ok) liveByOrigin.set(room.room.slice(6), room.stats.value.peers.length);
  }
  const viewMap = value(counts);
  const totalViews = viewMap ? [...viewMap.values()].reduce((a, b) => a + b, 0) : null;
  const originOf = (url?: string) => {
    try {
      return new URL(url ?? '').origin.toLowerCase();
    } catch {
      return '';
    }
  };

  const d = value(dir);
  const tiles = stats(
    stat('Listed', d ? num(d.approved.length) : '—'),
    stat('Waiting for review', d ? num(d.pending.length) : '—'),
    stat('Total views', totalViews === null ? '—' : num(totalViews), 'deduped per visitor, 30 min'),
    stat('People in worlds now', rooms ? num([...liveByOrigin.values()].reduce((a, b) => a + b, 0)) : '—'),
  );

  const pending = guarded('Waiting for review', dir, (v) =>
    table(
      ['', 'World', 'Creator', 'Submitted', ''],
      v.pending.map((world) => {
        const approve = approveLink(env, world);
        return [
          cover(world),
          `<span class="cell-main">${esc(world.name ?? world.id)}</span><div class="cell-sub">${link(world.url)}</div>${world.description ? `<div class="cell-sub">${esc(world.description)}</div>` : ''}`,
          `${esc(world.creator ?? '—')}<div class="cell-sub">${esc(world.email ?? '')}</div>${world.portfolio ? `<div class="cell-sub">${link(world.portfolio)}</div>` : ''}`,
          esc(ago(Date.parse(world.submittedAt ?? ''), at)),
          approve ? `<a class="button" href="${esc(approve)}" target="_blank" rel="noopener noreferrer">Approve</a>` : '',
        ];
      }),
      'No submissions waiting.',
    ),
  );

  const approved = guarded(
    'In the directory',
    dir,
    (v) =>
      table(
        ['', 'World', 'Creator', 'Listed', 'Views', 'Online'],
        v.approved.map((world) => {
          const live = liveByOrigin.get(originOf(world.url));
          return [
            cover(world),
            `<span class="cell-main">${esc(world.name ?? world.id)}</span> ${world.curatedBy ? pill('curated', 'info') : ''}<div class="cell-sub">${link(world.url)}</div>`,
            `${esc(world.creator ?? '—')}<div class="cell-sub">${esc(world.email ?? '')}</div>`,
            esc(ago(Date.parse(world.approvedAt ?? world.addedAt ?? ''), at)),
            `<span class="mono">${viewMap ? num(viewMap.get(world.url ?? '') ?? 0) : '—'}</span>`,
            live ? `<span class="live-dot"></span><span class="mono">${num(live)}</span>` : '<span class="muted">0</span>',
          ];
        }),
        'The directory is empty.',
      ),
    (v) => `${num(v.approved.length)} worlds`,
  );

  const accountWorlds = guarded('Worlds owned by accounts (D1)', owned, (v) =>
    v.rows.length
      ? `${breakdown(v.byStatus.map((row) => ({ label: row.status, n: row.n })))}${table(
          ['World', 'Owner', 'Status', 'Created'],
          v.rows.map((world) => [
            `<span class="cell-main">${esc(world.name)}</span><div class="cell-sub">${link(world.url)}</div>`,
            esc(world.owner ?? '—'),
            pill(world.status, world.status === 'published' ? 'good' : world.status === 'pending' ? 'warn' : 'plain'),
            esc(ago(Number(world.created_at), at)),
          ]),
        )}`
      : '<p class="muted">No account-owned worlds yet — the directory still lives in KV (above).</p>',
  );

  return render(env, admin, '/worlds', 'Worlds', `${tiles}${pending}${approved}${accountWorlds}`);
};

// ── Live ───────────────────────────────────────────────────────────────────

export const livePage: Page = async (_request, env, admin) => {
  const dir = await attempt(() => directory(env));
  const listed = value(dir)?.approved ?? [];
  const rooms = await attempt(() => presence(env, listed.filter((w) => w.url).map((w) => ({ name: w.name ?? w.id, url: w.url! }))));
  const total = liveTotal(value(rooms));

  const body = `${stats(stat('Online now', total === null ? '—' : `${total ? '<span class="live-dot"></span>' : ''}${num(total)}`, 'refreshes every 15 s'))}
  ${guarded('Rooms', rooms, (list) => {
    const sorted = [...list].sort((a, b) => (b.stats.ok ? b.stats.value.peers.length : -1) - (a.stats.ok ? a.stats.value.peers.length : -1));
    return table(
      ['Room', 'Walking', 'Connected', 'Who'],
      sorted.map((room) => {
        if (!room.stats.ok) return [`<span class="cell-main">${esc(room.label)}</span>`, '—', '—', `<span class="error">${esc(room.stats.error)}</span>`];
        const { peers, connections } = room.stats.value;
        const who = peers.length
          ? `<div class="peers">${peers
              .map((peer) => (peer.name ? pill(`@${peer.name}`, 'info') : peer.alias ? pill(peer.alias) : pill('guest')))
              .join('')}</div>`
          : '<span class="muted">empty</span>';
        return [
          `<span class="cell-main">${esc(room.label)}</span><div class="cell-sub">${esc(room.room)}</div>`,
          `<span class="mono">${num(peers.length)}</span>`,
          `<span class="mono">${num(connections)}</span>`,
          who,
        ];
      }),
    );
  })}
  <p class="muted">Names are self-reported by each visitor's client; guests and private-mode visitors show no account name. Nothing here is stored.</p>`;
  return render(env, admin, '/live', 'Live', body, 15);
};

// ── Ads ────────────────────────────────────────────────────────────────────

export const adsPage: Page = async (_request, env, admin) => {
  const at = now(env);
  const data = await attempt(() => ads(env));
  const hub = hubOrigin(env);
  const body = guarded(
    'Billboard ads',
    data,
    (v) => `${stats(
      ...v.byStatus.map((row) => stat(row.status.replace('_', ' '), num(row.n))),
      stat('Revenue', v.revenue.length ? v.revenue.map((r) => money(r.cents, r.currency)).join(' + ') : money(0, 'eur'), `${num(v.revenue.reduce((n, r) => n + r.n, 0))} paid ads`),
    )}${table(
      ['Advertiser', 'Billboard', 'Status', 'Price', 'Submitted', 'Ends', ''],
      v.recent.map((ad) => [
        `<span class="cell-main">${esc(ad.advertiser_name)}</span><div class="cell-sub">${link(ad.destination_url)}</div><div class="cell-sub">${esc(ad.contact_email)}</div>`,
        `<code>${esc(ad.billboard_id)}</code>`,
        pill(ad.status.replace('_', ' '), adTone(ad.status)),
        esc(money(Number(ad.amount_cents), ad.currency)),
        esc(ago(Number(ad.created_at), at)),
        ad.ends_at ? esc(ago(Number(ad.ends_at), at)) : '<span class="muted">—</span>',
        `<a href="${esc(hub)}/api/ads/admin/review?id=${esc(ad.id)}" target="_blank" rel="noopener">${ad.status === 'pending' ? '<strong>Review</strong>' : 'Open'}</a>`,
      ]),
      'No ads submitted yet.',
    )}`,
    () => `<a href="${esc(hub)}/api/ads/admin" target="_blank" rel="noopener">Moderation queue ↗</a>`,
  );
  return render(env, admin, '/ads', 'Ads', body);
};

// ── Fediverse and avatars ──────────────────────────────────────────────────

export const federationPage: Page = async (_request, env, admin) => {
  const at = now(env);
  const [fed, wallet] = await Promise.all([attempt(() => federation(env)), attempt(() => avatars(env))]);
  const f = value(fed);
  const tiles = f
    ? stats(
        stat('Followers', num(f.followers), 'remote accounts following creators'),
        stat('Known servers’ actors', num(f.remoteActors)),
        stat('Posts published', num(f.objects)),
        stat('Deliveries queued', num(f.deliveries), f.failing ? `${num(f.failing)} retrying` : 'none failing'),
        stat('Inbox, 24 h', num(f.inbox24h), 'activities received'),
        ...f.interactions.map((row) => stat(`${row.type}s`, num(row.n))),
      )
    : '';
  const body = `${tiles}<div class="grid">
  ${guarded('Most-followed creators', fed, (v) =>
    breakdown(v.topCreators.map((row) => ({ label: row.username ? `@${row.username}` : row.email, n: row.followers }))),
  )}
  ${guarded('Actors', fed, (v) => breakdown(v.actors.map((row) => ({ label: row.kind, n: row.n }))))}
  ${guarded(
    'Avatar Wallet',
    wallet,
    (v) =>
      `${breakdown(v.connections.map((row) => ({ label: `${row.provider}${row.status === 'reconnect' ? ' (needs reconnect)' : ''}`, n: row.n })))}<p class="muted">${num(v.total)} avatars picked · ${num(v.selected)} in use</p>`,
  )}
  ${guarded('Delivery errors', fed, (v) =>
    table(
      ['Inbox', 'Tries', 'Error', 'Next try'],
      v.errors.map((row) => [
        `<span class="cell-sub">${esc(row.inbox)}</span>`,
        `<span class="mono">${num(Number(row.attempts))}</span>`,
        `<span class="cell-sub">${esc(row.last_error ?? '')}</span>`,
        esc(ago(Number(row.next_attempt_at), at)),
      ]),
      'No delivery errors.',
    ),
  )}
  </div>`;
  return render(env, admin, '/federation', 'Fediverse & avatars', body);
};

// ── Traffic ────────────────────────────────────────────────────────────────

export const trafficPage: Page = async (_request, env, admin) => {
  const data = await attempt(() => traffic(env));
  if (!data.ok) {
    const body = panel(
      'Cloudflare traffic',
      `<p class="error">${esc(data.error)}</p><div class="callout" style="margin-top:12px">Create a Cloudflare API token with <strong>Zone › Analytics › Read</strong> for worldmesh.net (and <strong>Account › Account Analytics › Read</strong> for per-Worker numbers), then:<br><code>npx wrangler secret put CF_API_TOKEN --config workers/admin/wrangler.toml</code><br>and set <code>CF_ZONE_ID</code> / <code>CF_ACCOUNT_ID</code> in <code>workers/admin/wrangler.toml</code>.</div>`,
    );
    return render(env, admin, '/traffic', 'Traffic', body);
  }
  const v = data.value;
  const sum = (key: 'requests' | 'pageViews' | 'bytes' | 'threats' | 'uniques') => v.days.reduce((n, day) => n + day[key], 0);
  const last = v.days[v.days.length - 1];
  const body = `${stats(
    stat('Visitors, 30 d', num(sum('uniques')), 'sum of daily uniques'),
    stat('Page views, 30 d', num(sum('pageViews'))),
    stat('Requests, 30 d', num(sum('requests'))),
    stat('Bandwidth, 30 d', bytes(sum('bytes'))),
    stat('Threats blocked', num(sum('threats'))),
    stat('Today', last ? num(last.uniques) : '—', 'unique visitors so far'),
  )}<div class="grid">
    ${panel('Unique visitors per day', bars(v.days.map((day) => ({ label: day.date, n: day.uniques }))))}
    ${panel('Page views per day', bars(v.days.map((day) => ({ label: day.date, n: day.pageViews }))))}
    ${panel('Top countries (requests)', breakdown(v.countries.map((row) => ({ label: row.country, n: row.requests }))))}
    ${panel(
      'Workers, last 24 h',
      v.workers
        ? table(
            ['Worker', 'Requests', 'Errors'],
            v.workers.map((row) => [
              `<code>${esc(row.script)}</code>`,
              `<span class="mono">${num(row.requests)}</span>`,
              row.errors ? `<span style="color:var(--red)" class="mono">${num(row.errors)}</span>` : '<span class="mono muted">0</span>',
            ]),
          )
        : '<p class="muted">Set CF_ACCOUNT_ID (and give the token Account Analytics read) to see each Worker.</p>',
    )}
  </div><p class="muted">From Cloudflare for the worldmesh.net zone. Demo worlds on their own pages.dev hosts are not included.</p>`;
  return render(env, admin, '/traffic', 'Traffic', body);
};

// ── System ─────────────────────────────────────────────────────────────────

export const systemPage: Page = async (_request, env, admin) => {
  const dir = await attempt(() => directory(env));
  const worldChecks = (value(dir)?.approved ?? [])
    .filter((world) => world.url && /^https?:\/\//.test(world.url))
    .slice(0, 40)
    .map((world) => ({ name: world.name ?? world.id, url: world.url!, expect: [200] }));
  const [services, worlds] = await Promise.all([
    attempt(() => runChecks(env, serviceChecks(env))),
    attempt(() => runChecks(env, worldChecks)),
  ]);
  const flag = (on: boolean, text = on ? 'connected' : 'missing') => pill(text, on ? 'good' : 'warn');
  const config = table(
    ['Source', 'State', 'Used for'],
    [
      ['D1 <code>worldmesh</code>', flag(!!env.DB), 'users, sessions, ads, fediverse, avatars'],
      ['KV <code>WORLDS</code>', flag(!!env.WORLDS), 'world directory and submissions'],
      ['KV <code>VIEWS</code>', flag(!!env.VIEWS), 'world view counts'],
      ['Durable Objects <code>ROOMS</code>', flag(!!env.ROOMS), 'who is online'],
      ['Cloudflare API token', flag(!!env.CF_API_TOKEN, env.CF_API_TOKEN ? 'set' : 'not set'), 'traffic and Worker metrics'],
      ['Zone id', flag(!!env.CF_ZONE_ID, env.CF_ZONE_ID ? 'set' : 'not set'), 'traffic'],
      ['Account id', flag(!!env.CF_ACCOUNT_ID, env.CF_ACCOUNT_ID ? 'set' : 'not set'), 'per-Worker requests and errors'],
    ].map((row) => row.map(String)),
  );
  const body = `${guarded('Services', services, healthTable)}
  ${guarded('Listed worlds reachable', worlds, healthTable, (v) => `${num(v.filter((c) => c.up).length)} of ${num(v.length)} up`)}
  ${panel('Data sources', config)}
  ${panel('Admins', `<p>${[...new Set((env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean))].map((e) => pill(e)).join(' ')}</p><p class="muted">Set in <code>ADMIN_EMAILS</code> (workers/admin/wrangler.toml). Each needs a WorldMesh account with that verified email.</p>`)}`;
  return render(env, admin, '/system', 'System', body);
};
