import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
// NOTE: intentionally no @ts-expect-error here — Next.js types allow this
// global CSS import, and an UNUSED @ts-expect-error fails typecheck (TS2578).
import './globals.css';

export const metadata: Metadata = {
  title: 'LiveChat Dashboard',
  description: 'Agent dashboard for the live chat platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
