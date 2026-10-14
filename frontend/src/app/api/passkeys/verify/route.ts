import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const response = await fetch(`${process.env.BACKEND_URL}/auth/passkeys/authenticate/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await request.text(),
  });
  const body = await response.json();
  if (!response.ok) return Response.json(body, { status: response.status });

  (await cookies()).set('s', body.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: body.expiresIn ?? 90 * 86400,
    path: '/',
  });
  return Response.json({ ok: true });
}
