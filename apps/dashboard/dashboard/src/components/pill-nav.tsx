'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui';

export interface PillItem {
  href: string;
  label: string;
  active: boolean;
  Icon?: ComponentType<{ size?: number }>;
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Pill navigation with a sliding "active" indicator (spring-animated).
 * Renders text tabs by default, or icon-only buttons when items carry an Icon
 * and `iconOnly` is set (the left rail).
 */
export function PillNav({
  items,
  label,
  className,
  iconOnly = false,
  id,
}: {
  items: PillItem[];
  label: string;
  className?: string;
  iconOnly?: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const activeKey = items.find((i) => i.active)?.href ?? '';

  const place = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const on = root.querySelector<HTMLElement>('.pi.on');
    const ind = root.querySelector<HTMLElement>('.ind');
    if (!ind) return;
    if (!on) {
      ind.style.opacity = '0';
      return;
    }
    ind.style.opacity = '1';
    ind.style.left = `${on.offsetLeft}px`;
    ind.style.top = `${on.offsetTop}px`;
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.height = `${on.offsetHeight}px`;
  }, []);

  useIsoLayoutEffect(() => {
    place();
  }, [activeKey, place]);

  useEffect(() => {
    window.addEventListener('resize', place);
    void document.fonts?.ready.then(place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  return (
    <nav ref={ref} id={id} className={className} aria-label={label}>
      <span className="ind" aria-hidden="true" />
      {items.map(({ href, label: text, active, Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn('pi', active && 'on')}
          aria-current={active ? 'page' : undefined}
          aria-label={iconOnly ? text : undefined}
          title={iconOnly ? text : undefined}
        >
          {iconOnly && Icon ? <Icon size={19} /> : text}
        </Link>
      ))}
    </nav>
  );
}
