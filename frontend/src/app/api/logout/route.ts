import { cookies } from 'next/headers';

export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get('s')?.value;
  let logoutError: string | null = null;
  if (token) {
    try {
      const response = await fetch(`${process.env.BACKEND_URL}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) logoutError = 'The session could not be revoked on the server.';
    } catch {
      logoutError = 'The server could not be reached, but this browser session was cleared.';
    }
  }
  cookieStore.delete('s');
  return Response.json(logoutError ? { ok: false, error: logoutError } : { ok: true });
}
