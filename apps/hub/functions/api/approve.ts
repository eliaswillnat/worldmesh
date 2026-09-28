interface Env {
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  APPROVE_SECRET?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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

  const authHeader = request.headers.get('Authorization');
  if (env.APPROVE_SECRET) {
    if (authHeader !== `Bearer ${env.APPROVE_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'RESEND_API_KEY is not configured.' }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  let body: {
    name?: string;
    url?: string;
    email?: string;
    creator?: string;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!body.email || !body.name || !body.url) {
    return new Response(
      JSON.stringify({ error: 'Missing email, name, or url.' }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  const fromEmail = env.FROM_EMAIL || 'WorldMesh <onboarding@resend.dev>';
  const worldUrl = body.url;
  const creatorName = body.creator || 'there';

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #f0f0f0; border-radius: 8px;">
      <h2 style="margin-top: 0; color: #ffffff; font-size: 20px; border-bottom: 1px solid #222; padding-bottom: 12px;">Your world is live!</h2>

      <p style="color: #ccc; line-height: 1.6; margin: 16px 0;">
        Hey ${escapeHtml(creatorName)}, great news — <strong style="color: #fff;">${escapeHtml(body.name)}</strong> has been approved and is now live on WorldMesh!
      </p>

      <div style="margin: 24px 0; text-align: center;">
        <a href="https://worldmesh.net" style="display: inline-block; padding: 12px 28px; background: #70aaff; color: #000; font-weight: 600; text-decoration: none; border-radius: 6px;">View on WorldMesh</a>
      </div>

      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">World URL</span>
        <div style="margin-top: 4px;">
          <a href="${escapeHtml(worldUrl)}" style="color: #70aaff; text-decoration: underline; word-break: break-all;" target="_blank">${escapeHtml(worldUrl)}</a>
        </div>
      </div>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
        You're receiving this because you submitted ${escapeHtml(body.name)} to WorldMesh.
      </div>
    </div>
  `;

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [body.email],
        subject: `Your world "${body.name}" is now live on WorldMesh!`,
        html: htmlContent,
      }),
    });

    if (!resendResponse.ok) {
      const errorText = await resendResponse.text();
      return new Response(
        JSON.stringify({ error: 'Resend API error', details: errorText }),
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
      JSON.stringify({ error: 'Failed to send approval email', details: err?.message }),
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
