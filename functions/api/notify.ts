interface Env {
  RESEND_API_KEY?: string;
  NOTIFICATION_EMAIL?: string;
  FROM_EMAIL?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// In-memory rate limiting map: ip -> timestamps[]
const rateLimits = new Map<string, number[]>();
const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimits.get(ip) || [];
  const valid = timestamps.filter((t) => now - t < WINDOW_MS);
  if (valid.length >= MAX_REQUESTS_PER_WINDOW) {
    rateLimits.set(ip, valid);
    return true;
  }
  valid.push(now);
  rateLimits.set(ip, valid);
  return false;
}

// Suspicious bot/crawler User-Agent fragments
const BLOCKED_UA_PATTERNS = [
  /curl\//i,
  /python-requests/i,
  /aiohttp/i,
  /scrapy/i,
  /wget\//i,
  /httpclient/i,
  /java\//i,
  /libwww/i,
  /postman/i,
  /insomnia/i,
  /go-http-client/i,
];

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  // 1. Bot check: Cloudflare Threat Score
  const threatScore = parseInt(request.headers.get('cf-threat-score') || '0', 10);
  if (threatScore > 20) {
    return new Response(JSON.stringify({ error: 'Blocked by security policy.' }), {
      status: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // 2. Bot check: User-Agent validation
  const userAgent = request.headers.get('user-agent') || '';
  if (!userAgent || BLOCKED_UA_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return new Response(JSON.stringify({ error: 'Automated agent request forbidden.' }), {
      status: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // 3. Bot check: Rate Limiting by Client IP
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  if (clientIp !== 'unknown' && isRateLimited(clientIp)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }), {
      status: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'RESEND_API_KEY environment variable is not configured.' }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  let body: {
    id?: string;
    name?: string;
    url?: string;
    description?: string;
    cover?: string;
    creator?: string;
    portfolio?: string;
    email?: string;
    submittedAt?: string;
    botTrap?: string;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON request body.' }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  // 4. Bot check: Honeypot trap (bots fill hidden fields, humans never do)
  if (body.botTrap && body.botTrap.trim().length > 0) {
    // Return a fake success so bots don't adapt, but silently discard the submission
    return new Response(JSON.stringify({ success: true, fake: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!body.url || !body.name) {
    return new Response(
      JSON.stringify({ error: 'Missing name or url in submission payload.' }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }
  body.email = body.email?.trim();
  if (!body.email || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return new Response(
      JSON.stringify({ error: 'A valid creator email is required.' }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  const toEmail = env.NOTIFICATION_EMAIL || 'elias.willnat@gmail.com';
  const fromEmail = env.FROM_EMAIL || 'WorldMesh <accounts@worldmesh.net>';
  const submissionId = body.id || `world-${Date.now().toString(36)}`;

  const allowlistEntry = {
    id: submissionId,
    name: body.name,
    url: body.url,
    description: body.description || undefined,
    cover: body.cover || undefined,
    creator: body.creator || undefined,
    portfolio: body.portfolio || undefined,
  };

  let coverAttachment: { filename: string; content: string; content_id: string; content_type: string } | null = null;
  let coverImgSrc: string | null = null;

  if (body.cover) {
    if (body.cover.startsWith('data:image/')) {
      const match = body.cover.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const contentType = match[1];
        const base64Data = match[2];
        const ext = contentType.includes('webp') ? 'webp' : (contentType.includes('png') ? 'png' : 'jpg');
        coverAttachment = {
          filename: `cover.${ext}`,
          content: base64Data,
          content_id: 'cover-image',
          content_type: contentType,
        };
        coverImgSrc = 'cid:cover-image';
      }
    } else {
      coverImgSrc = body.cover;
    }
  }

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #f0f0f0; border-radius: 8px;">
      <h2 style="margin-top: 0; color: #ffffff; font-size: 20px; border-bottom: 1px solid #222; padding-bottom: 12px;">New WorldMesh Submission</h2>
      
      <div style="background: #141414; padding: 14px 18px; border-radius: 8px; border: 1px solid #2a2a2a; margin: 16px 0;">
        <span style="color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; display: block; margin-bottom: 4px;">Submission ID</span>
        <code style="font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 16px; color: #70aaff; font-weight: 700; user-select: all;">${escapeHtml(submissionId)}</code>
      </div>

      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">World Name</span>
        <div style="font-size: 18px; font-weight: 600; color: #ffffff; margin-top: 4px;">${escapeHtml(body.name)}</div>
      </div>

      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">URL</span>
        <div style="margin-top: 4px;">
          <a href="${escapeHtml(body.url)}" style="color: #70aaff; text-decoration: underline; word-break: break-all;" target="_blank">${escapeHtml(body.url)}</a>
        </div>
      </div>

      ${body.creator ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Creator</span>
        <div style="color: #eee; margin-top: 4px;">${escapeHtml(body.creator)}</div>
      </div>` : ''}

      ${body.email ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Creator Email</span>
        <div style="margin-top: 4px;">
          <a href="mailto:${escapeHtml(body.email)}" style="color: #70aaff; text-decoration: underline;">${escapeHtml(body.email)}</a>
        </div>
      </div>` : ''}

      ${body.portfolio ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Portfolio</span>
        <div style="margin-top: 4px;">
          <a href="${escapeHtml(body.portfolio)}" style="color: #70aaff; text-decoration: underline; word-break: break-all;" target="_blank">${escapeHtml(body.portfolio)}</a>
        </div>
      </div>` : ''}

      ${body.description ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Description</span>
        <div style="color: #ccc; margin-top: 4px; line-height: 1.5;">${escapeHtml(body.description)}</div>
      </div>` : ''}

      ${coverImgSrc ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Cover Image</span>
        <div style="margin-top: 8px;">
          <img src="${escapeHtml(coverImgSrc)}" alt="Cover" style="max-width: 100%; border-radius: 6px; border: 1px solid #333;" />
        </div>
      </div>` : ''}

      <div style="margin: 20px 0 10px; padding-top: 16px; border-top: 1px solid #222;">
        <span style="color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; display: block; margin-bottom: 6px;">Allowlist JSON (for AI Agents)</span>
        <pre style="margin: 0; padding: 12px; background: #141414; border: 1px solid #262626; border-radius: 6px; font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 11px; color: #a0c0ff; overflow-x: auto; white-space: pre-wrap; word-break: break-all;">${escapeHtml(JSON.stringify(allowlistEntry, null, 2))}</pre>
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
        Submitted at ${escapeHtml(body.submittedAt || new Date().toISOString())} from IP ${escapeHtml(clientIp)}
      </div>
    </div>
  `;

  try {
    const resendPayload: Record<string, unknown> = {
      from: fromEmail,
      to: [toEmail],
      subject: `[WorldMesh] New World Submission: ${body.name} (${submissionId})`,
      html: htmlContent,
    };
    if (body.email) {
      resendPayload.reply_to = body.email;
    }
    if (coverAttachment) {
      resendPayload.attachments = [coverAttachment];
    }

    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!resendResponse.ok) {
      const errorText = await resendResponse.text();
      return new Response(
        JSON.stringify({ error: 'Resend API returned an error', details: errorText }),
        {
          status: resendResponse.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    const data = (await resendResponse.json()) as { id: string };
    return new Response(JSON.stringify({ success: true, id: data.id }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: 'Failed to send notification via Resend', details: err?.message }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
