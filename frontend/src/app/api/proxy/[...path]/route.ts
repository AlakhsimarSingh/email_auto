import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const token = (await cookies()).get('s')?.value;
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let r: Response;
  try {
    const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, '');
    if (!backendUrl) throw new Error('BACKEND_URL is not configured');
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    r = await fetch(`${backendUrl}/${path.join('/')}${new URL(req.url).search}`, {
      method: req.method,
      // The backend rejects an empty body that claims to be JSON, so only declare JSON when there is a body.
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body || undefined,
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[api/proxy] backend request failed:', error);
    return Response.json({ error: 'backend_unavailable' }, { status: 503 });
  }
  const response = new NextResponse(await r.text(), {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
  });
  const refreshedToken = r.headers.get('x-session-token');
  if (refreshedToken) {
    const expiresIn = Number(r.headers.get('x-session-expires-in'));
    response.cookies.set('s', refreshedToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 14 * 86400,
      path: '/',
    });
  }
  return response;
}
// PUT and PATCH were missing, so deal updates, device/notification preferences and portfolio settings returned 405.
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
