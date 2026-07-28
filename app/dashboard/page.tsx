import { DataProvider } from '@/components/providers/DataProvider';
import { Dashboard } from '@/components/Dashboard';
import { generateInitialDataset } from '@/lib/dataGenerator';

/**
 * Server Component that produces the seed dataset.
 *
 * Two decisions worth stating.
 *
 * **Why the payload is columnar.** 10,000 points as `{timestamp, value,
 * category}` objects serialises to roughly 1.1MB of RSC payload; the same data
 * as three parallel arrays is about a third of that, and it unpacks straight
 * into the ring buffer's typed arrays without allocating 10,000 intermediate
 * objects that immediately become garbage.
 *
 * **Why this page is still static.** The seed is generated with timestamps
 * relative to zero and a fixed PRNG seed, so the output is deterministic and
 * contains no wall-clock time. That means it can be generated once at build
 * time and served from cache. The client rebases those offsets onto its own
 * clock when it fills the buffer, so the window still ends at "now" for every
 * visitor. Calling Date.now() here instead would have forced the route dynamic
 * and put dataset generation on the critical path of every single request.
 */
export default async function DashboardPage() {
  const initialData = generateInitialDataset(10_000, 0);

  return (
    <DataProvider initialData={initialData}>
      <Dashboard />
    </DataProvider>
  );
}
