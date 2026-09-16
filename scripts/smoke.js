import 'dotenv/config';
const base = process.env.GOTIT_SMOKE_BASE_URL;
try {
  if (!base) throw new Error('SMOKE_BASE_URL_REQUIRED');
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('SMOKE_BASE_URL_INVALID');
  const requests = [
    ['/health', 200],
    ['/ready', 200],
    ['/api/v1', 200],
    ['/api/v1/profile', 401],
  ];
  for (const [path, status] of requests) {
    const response = await fetch(`${url.origin}${path}`, { signal: AbortSignal.timeout(20000) }),
      body = await response.json();
    if (response.status !== status || !body.requestId)
      throw new Error('SMOKE_HTTP_CONTRACT_FAILED');
    if (path === '/api/v1' && (!Array.isArray(body.routes) || body.routes.length < 30))
      throw new Error('SMOKE_CURRENT_API_CATALOG_MISSING');
    process.stdout.write(`${JSON.stringify({ path, status: response.status, requestId: true })}\n`);
  }
  if (process.env.GOTIT_SMOKE_ACCESS_TOKEN) {
    for (const path of [
      '/api/v1/capabilities',
      '/api/v1/profile',
      '/api/v1/learning-items?limit=1',
      '/api/v1/practice/sessions?limit=1',
      '/api/v1/dashboard',
      '/api/v1/gamification',
      '/api/v1/reading?limit=1',
      '/api/v1/export?limit=1',
      '/api/v1/learning/config',
      '/api/v1/learning/queue?limit=1',
    ]) {
      const response = await fetch(`${url.origin}${path}`, {
          headers: { authorization: `Bearer ${process.env.GOTIT_SMOKE_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(20000),
        }),
        body = await response.json();
      if (!response.ok || !body.requestId) throw new Error('SMOKE_AUTHENTICATED_CONTRACT_FAILED');
      process.stdout.write(
        `${JSON.stringify({ path: path.split('?')[0], status: response.status, requestId: true })}\n`,
      );
    }
  } else
    process.stdout.write(
      'Authenticated smoke pending: configure GOTIT_SMOKE_ACCESS_TOKEN locally\n',
    );
} catch (error) {
  const code =
    error instanceof Error && /^SMOKE_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'SMOKE_UNAVAILABLE';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
