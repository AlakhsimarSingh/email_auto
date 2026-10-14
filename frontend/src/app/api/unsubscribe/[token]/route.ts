import { NextResponse } from 'next/server';

async function handle(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, '');
  if (!backendUrl) return NextResponse.json({ error: 'unsubscribe_unavailable' }, { status: 503 });
  try {
    const response = await fetch(`${backendUrl}/unsubscribe/${encodeURIComponent(token)}`, {
      method: request.method,
      headers: request.method === 'POST' ? { 'content-type': request.headers.get('content-type') ?? 'application/x-www-form-urlencoded' } : undefined,
      body: request.method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    console.error('[unsubscribe] backend request failed:', error);
    return NextResponse.json({ error: 'unsubscribe_unavailable' }, { status: 503 });
  }
}

export { handle as GET, handle as POST };
