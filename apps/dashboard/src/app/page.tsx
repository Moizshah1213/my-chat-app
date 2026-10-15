'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

/** Root route: bounce to the inbox when signed in, else to login. */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/conversations' : '/login');
  }, [loading, user, router]);

  return <div className="loading">Loading…</div>;
}
