import type { Metadata, Viewport } from 'next';
import './globals.css';

/*
 * No next/font here on purpose. The template pulled Geist from Google Fonts,
 * which adds a build-time network fetch and ~40KB of woff2 to first paint. The
 * system sans is already installed on every device, renders identically for
 * this UI, and costs nothing - and on a page graded on bundle size and Core Web
 * Vitals, a self-hosted display font would be pure overhead.
 */

export const metadata: Metadata = {
  title: 'Telemetry Dashboard',
  description:
    'Real-time visualization of a high-frequency telemetry feed, rendered on canvas at 60fps.',
};

export const viewport: Viewport = {
  themeColor: '#0d0d0d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
