export async function POST(request: Request) {
  const response = await fetch(`${process.env.BACKEND_URL}/auth/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await request.text(),
  });
  return Response.json(await response.json(), { status: response.status });
}
