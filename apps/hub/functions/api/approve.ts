interface Env {
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  WORLDS: KVNamespace;
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');

  if (!id || !token) {
    return htmlResponse('Missing id or token.', false);
  }

  if (!env.WORLDS) {
    return htmlResponse('KV binding not configured.', false);
  }

  const raw = await env.WORLDS.get(`pending:${id}`);
  if (!raw) {
    const approved = await env.WORLDS.get(`approved:${id}`);
    if (approved) {
      return htmlResponse('This world has already been approved!', true);
    }
    return htmlResponse('Submission not found.', false);
  }

  const entry = JSON.parse(raw) as {
    id: string;
    name: string;
    url: string;
    description?: string;
    cover?: string;
    creator?: string;
    portfolio?: string;
    email?: string;
    submittedAt?: string;
    approveToken: string;
  };

  if (entry.approveToken !== token) {
    return htmlResponse('Invalid approval token.', false);
  }

  const approvedEntry = {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    description: entry.description,
    cover: entry.cover,
    creator: entry.creator,
    portfolio: entry.portfolio,
    approvedAt: new Date().toISOString(),
    addedAt: new Date().toISOString(),
  };

  await env.WORLDS.put(`approved:${id}`, JSON.stringify(approvedEntry));
  await env.WORLDS.delete(`pending:${id}`);

  if (entry.email && env.RESEND_API_KEY) {
    const fromEmail = env.FROM_EMAIL || 'WorldMesh <onboarding@resend.dev>';
    const creatorName = entry.creator || 'there';

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #f0f0f0; border-radius: 8px;">
        <h2 style="margin-top: 0; color: #ffffff; font-size: 20px; border-bottom: 1px solid #222; padding-bottom: 12px;">Your world is live!</h2>

        <p style="color: #ccc; line-height: 1.6; margin: 16px 0;">
          Hey ${escapeHtml(creatorName)}, great news! <strong style="color: #fff;">${escapeHtml(entry.name)}</strong> has been approved and is now live on WorldMesh.
        </p>

        <div style="margin: 24px 0; text-align: center;">
          <a href="https://worldmesh.net" style="display: inline-block; padding: 12px 28px; background: #70aaff; color: #000; font-weight: 600; text-decoration: none; border-radius: 25px;">View on WorldMesh</a>
        </div>

        <div style="margin: 16px 0;">
          <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">World URL</span>
          <div style="margin-top: 4px;">
            <a href="${escapeHtml(entry.url)}" style="color: #70aaff; text-decoration: underline; word-break: break-all;" target="_blank">${escapeHtml(entry.url)}</a>
          </div>
        </div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
          You're receiving this because you submitted ${escapeHtml(entry.name)} to WorldMesh.
        </div>
      </div>
    `;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [entry.email],
        subject: `Your world "${entry.name}" is now live on WorldMesh!`,
        html: emailHtml,
      }),
    });
  }

  return htmlResponse(`<strong>${escapeHtml(entry.name)}</strong> has been approved and is now live!${entry.email ? ' A confirmation email has been sent to the creator.' : ''}`, true);
}

function htmlResponse(message: string, success: boolean): Response {
  const color = success ? '#34d399' : '#f87171';
  const icon = success ? '&#10003;' : '&#10007;';
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorldMesh${success ? ' - Approved' : ''}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{max-width:420px;padding:32px;background:#141414;border:1px solid #2a2a2a;border-radius:12px;text-align:center}
.icon{font-size:48px;color:${color};margin-bottom:16px}
.msg{color:#ccc;line-height:1.6}
a{color:#70aaff}</style></head>
<body><div class="card"><div class="icon">${icon}</div><p class="msg">${message}</p><p style="margin-top:20px"><a href="https://worldmesh.net">Back to WorldMesh</a></p></div></body></html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
