import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { BRAND } from '@/config/brand';
// @ts-ignore -- Next.js processes global CSS imports during the build.
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: `${BRAND.product} Dashboard`,
  description: 'Agent dashboard for the live chat platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
   return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('lc_theme');document.documentElement.dataset.theme=t==='dark'?'dark':'light'}catch(e){}`,
          }}
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
