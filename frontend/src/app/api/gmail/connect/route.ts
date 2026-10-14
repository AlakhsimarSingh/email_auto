import { cookies } from 'next/headers';

export async function POST() {
  const token = (await cookies()).get('s')?.value;
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const response = await fetch(`${process.env.BACKEND_URL}/auth/gmail/connect-url`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const body = await response.json();
  return Response.json(body, { status: response.status });
}
