import { NextResponse } from 'next/server';
import { generateInitialDataset } from '@/lib/dataGenerator';

/** Guard rail: a caller asking for 10 million points should get a 400, not an OOM. */
const MAX_COUNT = 200_000;

/**
 * Dataset endpoint.
 *
 * GET /api/data?count=25000
 *
 * Returns the same columnar payload the Server Component embeds, for clients
 * that want a dataset without a navigation.
 *
 * This route is intentionally *not* `force-static`. That was the first version
 * and it was wrong: prerendering happens at build time, where there is no
 * request and therefore no query string, so every response came back baked with
 * the default count and `?count=3` was silently ignored.
 *
 * Caching still happens, just at the right layer. The generator is
 * deterministic and takes no wall-clock input, so a given URL always produces
 * the same bytes - which makes it safe to mark immutable and let the CDN cache
 * it per URL, query string included. Timestamps are offsets from zero and the
 * client rebases them, which is what lets a "live" feed be served from cache.
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('count');
  const parsed = raw === null ? 10_000 : Number(raw);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_COUNT) {
    return NextResponse.json(
      { error: `count must be a number between 1 and ${MAX_COUNT}` },
      { status: 400 },
    );
  }

  const count = Math.floor(parsed);
  const data = generateInitialDataset(count, 0);

  return NextResponse.json(
    { count, ...data },
    {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    },
  );
}
