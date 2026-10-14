import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const callbackUrl = new URL('/admin', request.url);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || url.searchParams.has('error')) {
    callbackUrl.searchParams.set('gmail', 'denied');
    return NextResponse.redirect(callbackUrl);
  }

  const token = (await cookies()).get('s')?.value;
  if (!token) {
    callbackUrl.pathname = '/login';
    callbackUrl.searchParams.set('gmail', 'session-expired');
    return NextResponse.redirect(callbackUrl);
  }

  try {
    const response = await fetch(`${process.env.BACKEND_URL}/auth/gmail/callback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code, state }),
      cache: 'no-store',
    });
    if (!response.ok) {
      callbackUrl.searchParams.set('gmail', 'error');
      return NextResponse.redirect(callbackUrl);
    }
    callbackUrl.searchParams.set('gmail', 'connected');
    return NextResponse.redirect(callbackUrl);
  } catch (error) {
    console.error('Gmail OAuth callback could not reach the backend', error);
    callbackUrl.searchParams.set('gmail', 'error');
    return NextResponse.redirect(callbackUrl);
  }
}
