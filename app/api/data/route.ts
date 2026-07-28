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
 * that want to reseed without a navigation - the "Reseed" control uses this.
 *
 * Marked force-static: the generator is deterministic and takes no wall-clock
 * input, so for a given `count` the response never changes and can be cached
 * indefinitely. Timestamps are offsets relative to zero; the client rebases
 * them, which is what makes caching safe for a feed that is nominally "live".
 */
export const dynamic = 'force-static';

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
