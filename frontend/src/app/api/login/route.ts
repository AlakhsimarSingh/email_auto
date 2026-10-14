import { cookies } from 'next/headers';
export async function POST(req: Request) {
  const r = await fetch(`${process.env.BACKEND_URL}/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await req.text() });
  if (!r.ok) return Response.json({ error: 'denied' }, { status: r.status });
  const { token, expiresIn } = await r.json();
  (await cookies()).set('s', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: expiresIn ?? 14 * 86400, path: '/' });
  return Response.json({ ok: true });
}
