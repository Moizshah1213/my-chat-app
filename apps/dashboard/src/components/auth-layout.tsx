'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BRAND } from '@/config/brand';
import { WidgetPreviewOrb, type WidgetOrbMood } from '@/components/widget-preview-orb';
import { X } from 'lucide-react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const [orbMood, setOrbMood] = useState<WidgetOrbMood>('idle');

  useEffect(() => {
    const moods: WidgetOrbMood[] = ['listening', 'thinking', 'happy', 'idle'];
    let index = 0;
    const timer = window.setInterval(() => {
      index = (index + 1) % moods.length;
      setOrbMood(moods[index]);
    }, 2400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="auth-page">
      <div className="auth-layout">
        <section className="auth-main">
          <div className="auth-main-brand" aria-label={BRAND.product}>
            <img
              className="brand-logo brand-logo-light"
              src={BRAND.logoOnLight}
              alt={BRAND.product}
            />
            <img
              className="brand-logo brand-logo-dark"
              src={BRAND.logoOnDark}
              alt=""
              aria-hidden="true"
            />
          </div>
          <div className="auth-content">{children}</div>
        </section>

        <aside className="auth-visual" aria-label={`${BRAND.product} widget preview`}>
          <div className="auth-visual-heading">
            <div className="auth-brand" aria-label={BRAND.product}>
              <img
                className="brand-logo brand-logo-light"
                src={BRAND.logoOnLight}
                alt={BRAND.product}
              />
              <img
                className="brand-logo brand-logo-dark"
                src={BRAND.logoOnDark}
                alt=""
                aria-hidden="true"
              />
            </div>
          </div>

          <div className="auth-widget-stage">
            <div className="auth-widget-window" aria-label="Animated chat widget preview">
              <div className="auth-widget-header">
                <div className="auth-widget-presence">
                  <strong>{BRAND.product} support</strong>
                  <span> Online now</span>
                </div>
                <span className="auth-widget-menu x-icon" aria-hidden="true">
                  <X size={18} />
                </span>
              </div>
              <div className="auth-widget-hero">
                <WidgetPreviewOrb className="auth-orb-canvas" radius={0.36} mood={orbMood} />
                <h2>Hi there.</h2>
                <p>How can we help today?</p>
              </div>
              <div className="auth-chat-stream" aria-hidden="true">
                <div className="auth-chat-message auth-chat-visitor">
                  Hi! Can you help me with my order?
                </div>
                <div className="auth-chat-message auth-chat-typing">
                  <span>{BRAND.product} AI is typing</span>
                  <i />
                  <i />
                  <i />
                </div>
                <div className="auth-chat-message auth-chat-agent">
                  <span className="auth-chat-sender">{BRAND.product} AI</span>
                  Of course — I can help you with that.
                </div>
                <div className="auth-chat-message auth-chat-followup">
                  Thank you! That helps a lot.
                </div>
              </div>
              <div className="auth-widget-composer" aria-hidden="true">
                <span>Write a message...</span>
                <span className="auth-widget-send">↑</span>
              </div>
            </div>
            <div className="auth-widget-launcher" aria-hidden="true">
              <WidgetPreviewOrb className="auth-launcher-orb" radius={0.4} mood="listening" />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
