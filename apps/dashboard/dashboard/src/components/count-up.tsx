'use client';

import { useEffect, useState } from 'react';

/** Number that eases up to `value` (expo-out). Respects reduced-motion. */
export function CountUp({
  value,
  suffix = '',
  delay = 250,
  duration = 1400,
}: {
  value: number;
  suffix?: string;
  delay?: number;
  duration?: number;
}) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0 - delay) / duration));
      setShown(k >= 1 ? value : Math.round(value * (k === 0 ? 0 : 1 - Math.pow(2, -10 * k))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delay, duration]);

  return (
    <>
      {shown.toLocaleString()}
      {suffix}
    </>
  );
}
