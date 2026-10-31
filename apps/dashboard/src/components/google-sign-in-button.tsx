'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdentityApi {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
      }) => void;
      renderButton: (
        element: HTMLElement,
        options: { theme: 'outline'; size: 'large'; text: 'continue_with'; shape: 'rectangular'; width: number },
      ) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

export default function GoogleSignInButton({
  disabled = false,
  onCredential,
  onError,
}: {
  disabled?: boolean;
  onCredential: (credential: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    const element = containerRef.current;
    const identity = window.google?.accounts.id;
    if (!clientId || !element || !identity || !scriptReady) return;

    identity.initialize({
      client_id: clientId,
      callback: ({ credential }) => {
        if (!credential) {
          onError('Google did not return a sign-in credential.');
          return;
        }
        void onCredential(credential);
      },
    });

    const render = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width > 0) {
        element.replaceChildren();
        identity.renderButton(element, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width,
        });
      }
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clientId, onCredential, onError, scriptReady]);

  if (!clientId) {
    return <p className="google-signin-unavailable">Google sign-in needs OAuth client configuration.</p>;
  }

  return (
    <>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => onError('Could not load Google sign-in. Check your connection and try again.')}
      />
      <div
        ref={containerRef}
        className="google-signin-button"
        aria-disabled={disabled}
        style={disabled ? { pointerEvents: 'none', opacity: 0.55 } : undefined}
      />
    </>
  );
}
