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
    name?: string;
    url?: string;
    description?: string;
    cover?: string;
    creator?: string;
    submittedAt?: string;
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

  if (!body.url || !body.name) {
    return new Response(
      JSON.stringify({ error: 'Missing name or url in submission payload.' }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  const toEmail = env.NOTIFICATION_EMAIL || 'elias.willnat@gmail.com';
  const fromEmail = env.FROM_EMAIL || 'WorldMesh <onboarding@resend.dev>';

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #f0f0f0; border-radius: 8px;">
      <h2 style="margin-top: 0; color: #ffffff; font-size: 20px; border-bottom: 1px solid #222; padding-bottom: 12px;">New WorldMesh Submission</h2>
      
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

      ${body.description ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Description</span>
        <div style="color: #ccc; margin-top: 4px; line-height: 1.5;">${escapeHtml(body.description)}</div>
      </div>` : ''}

      ${body.cover ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Cover Image</span>
        <div style="margin-top: 8px;">
          <img src="${escapeHtml(body.cover)}" alt="Cover" style="max-width: 100%; border-radius: 6px; border: 1px solid #333;" />
        </div>
      </div>` : ''}

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
        Submitted at ${escapeHtml(body.submittedAt || new Date().toISOString())} via worldmesh.net
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
        to: [toEmail],
        subject: `[WorldMesh] New World Submission: ${body.name}`,
        html: htmlContent,
      }),
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

    const data = await resendResponse.json() as { id: string };
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
