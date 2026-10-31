'use client';

import { useEffect, useRef } from 'react';
import { JellyBlobMascot, type BlobMood } from '../../../widget/src/blob';

interface WidgetPreviewOrbProps {
  className: string;
  radius?: number;
  mood?: BlobMood;
}

export type WidgetOrbMood = BlobMood;

export function WidgetPreviewOrb({ className, radius, mood = 'idle' }: WidgetPreviewOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<JellyBlobMascot | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const orb = new JellyBlobMascot(canvas, { radius });
    orbRef.current = orb;
    return () => {
      orb.destroy();
      orbRef.current = null;
    };
  }, [radius]);

  useEffect(() => {
    orbRef.current?.setMood(mood);
  }, [mood]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
