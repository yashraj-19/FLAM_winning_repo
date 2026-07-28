/**
 * Streaming fallback for the dashboard route.
 *
 * Next renders this immediately while the Server Component above generates the
 * seed dataset, so the shell paints before the data exists rather than the
 * browser sitting on a blank document.
 */
export default function Loading() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100dvh',
        color: '#898781',
        fontSize: '0.875rem',
      }}
    >
      Generating seed dataset…
    </div>
  );
}
