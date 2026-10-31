'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type AiSettingsInput, type AiSettingsView } from '@/lib/api';

type Tone = 'professional' | 'friendly' | 'casual' | 'formal';
type AiForm = AiSettingsView & {
  apiKey: string;
  persona: string;
  tone: Tone;
  systemPrompt: string;
  fallback: string;
};

const EMPTY: AiForm = {
  mode: 'off',
  provider: 'openai_compatible',
  baseUrl: null,
  model: null,
  apiKeyLast4: null,
  instructions: {},
  temperature: 0.3,
  maxOutputTokens: 400,
  monthlyTokenCap: 200000,
  apiKey: '',
  persona: '',
  tone: 'friendly',
  systemPrompt: '',
  fallback: "I'm not sure about that. Let me connect you with a human agent.",
};

const PROVIDER_DEFAULTS: Record<AiSettingsView['provider'], string> = {
  openai_compatible: '',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

function getTraining(instructions: Record<string, unknown>) {
  const tone = instructions.tone;
  return {
    persona: typeof instructions.persona === 'string' ? instructions.persona : '',
    tone: (['professional', 'friendly', 'casual', 'formal'].includes(String(tone))
      ? tone
      : 'friendly') as Tone,
    systemPrompt: typeof instructions.systemPrompt === 'string' ? instructions.systemPrompt : '',
    fallback: typeof instructions.fallback === 'string'
      ? instructions.fallback
      : EMPTY.fallback,
  };
}

export default function AiSettingsPage() {
  const [settings, setSettings] = useState<AiForm>(EMPTY);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealKey, setRevealKey] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getAiSettings();
      setSettings({
        ...data,
        mode: data.mode === 'auto' ? 'auto' : 'off',
        apiKey: '',
        ...getTraining(data.instructions),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof AiForm>(key: K, value: AiForm[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSaved(false);
    if (settings.mode === 'auto') {
      if (!settings.apiKey && !settings.apiKeyLast4) {
        setError('Add an API key before enabling AI replies.');
        return;
      }
      if (!settings.baseUrl || !settings.model) {
        setError('Base URL and model are required to enable AI replies.');
        return;
      }
    }

    setBusy(true);
    try {
      const input: AiSettingsInput = {
        mode: settings.mode,
        provider: settings.provider,
        baseUrl: settings.baseUrl || undefined,
        model: settings.model || undefined,
        apiKey: settings.apiKey || undefined,
        instructions: {
          persona: settings.persona,
          tone: settings.tone,
          systemPrompt: settings.systemPrompt,
          fallback: settings.fallback,
        },
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        monthlyTokenCap: settings.monthlyTokenCap,
      };
      await api.updateAiSettings(input);
      setSettings((current) => ({ ...current, apiKey: '' }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AI settings');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      {error && <div className="alert error">{error}</div>}
      {saved && <div className="alert success">AI settings saved.</div>}

      <form className="card" onSubmit={(event) => void save(event)}>
        <h2>AI replies</h2>
        <p className="muted">
          Connect a model and let it reply to widget messages after giving your team time to respond.
        </p>

        <div className="field">
          <label htmlFor="mode">Reply mode</label>
          <select
            id="mode"
            value={settings.mode}
            onChange={(event) => set('mode', event.target.value as AiSettingsView['mode'])}
          >
            <option value="off">Off — human replies only</option>
            <option value="auto">Automatic — AI replies when no human has replied</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={settings.provider}
            onChange={(event) => {
              const provider = event.target.value as AiSettingsView['provider'];
              setSettings((current) => ({
                ...current,
                provider,
                baseUrl:
                  !current.baseUrl || current.baseUrl === PROVIDER_DEFAULTS[current.provider]
                    ? PROVIDER_DEFAULTS[provider] || null
                    : current.baseUrl,
              }));
              setSaved(false);
            }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai_compatible">OpenAI-compatible API</option>
          </select>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="baseUrl">API base URL</label>
            <input
              id="baseUrl"
              type="url"
              placeholder={settings.provider === 'anthropic'
                ? 'https://api.anthropic.com'
                : 'https://api.openai.com/v1'}
              value={settings.baseUrl ?? ''}
              onChange={(event) => set('baseUrl', event.target.value || null)}
              required={settings.mode === 'auto'}
            />
          </div>
          <div className="field">
            <label htmlFor="model">Model</label>
            <input
              id="model"
              placeholder={settings.provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'}
              value={settings.model ?? ''}
              onChange={(event) => set('model', event.target.value || null)}
              required={settings.mode === 'auto'}
            />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>
          The API URL must use HTTPS and a public host. Provider credentials are encrypted on the server.
        </p>

        <div className="field">
          <label htmlFor="apiKey">
            API key{settings.apiKeyLast4 ? ` (saved ••••${settings.apiKeyLast4})` : ''}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="apiKey"
              type={revealKey ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder={settings.apiKeyLast4 ? 'Leave blank to keep saved key' : 'Enter provider API key'}
              value={settings.apiKey}
              onChange={(event) => set('apiKey', event.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn s" type="button" onClick={() => setRevealKey((value) => !value)}>
              {revealKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {settings.mode === 'auto' && (
          <>
            <h2 style={{ marginTop: 24 }}>Agent instructions</h2>
            <p className="muted">
              Describe your business and how the AI should respond. It only uses the instructions and conversation history.
            </p>
            <div className="form-row">
              <div className="field">
                <label htmlFor="persona">Agent name</label>
                <input
                  id="persona"
                  maxLength={60}
                  placeholder="Support assistant"
                  value={settings.persona}
                  onChange={(event) => set('persona', event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="tone">Tone</label>
                <select
                  id="tone"
                  value={settings.tone}
                  onChange={(event) => set('tone', event.target.value as Tone)}
                >
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="formal">Formal</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="systemPrompt">Business information and instructions</label>
              <textarea
                id="systemPrompt"
                rows={7}
                maxLength={2000}
                placeholder="Describe your products, policies, support process, and what the AI should not do."
                value={settings.systemPrompt}
                onChange={(event) => set('systemPrompt', event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="fallback">Fallback when unsure</label>
              <input
                id="fallback"
                maxLength={300}
                value={settings.fallback}
                onChange={(event) => set('fallback', event.target.value)}
              />
            </div>

            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--mut)' }}>Advanced</summary>
              <div className="form-row" style={{ marginTop: 12 }}>
                <div className="field">
                  <label htmlFor="temperature">Temperature ({settings.temperature})</label>
                  <input
                    id="temperature"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={settings.temperature}
                    onChange={(event) => set('temperature', Number(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="maxOutputTokens">Maximum reply tokens</label>
                  <input
                    id="maxOutputTokens"
                    type="number"
                    min="50"
                    max="2000"
                    value={settings.maxOutputTokens}
                    onChange={(event) => set('maxOutputTokens', Number(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="monthlyTokenCap">Monthly token cap (0 = unlimited)</label>
                  <input
                    id="monthlyTokenCap"
                    type="number"
                    min="0"
                    value={settings.monthlyTokenCap}
                    onChange={(event) => set('monthlyTokenCap', Number(event.target.value))}
                  />
                </div>
              </div>
            </details>
          </>
        )}

        <button className="btn o" type="submit" disabled={busy} style={{ marginTop: 18 }}>
          {busy ? 'Saving…' : 'Save AI settings'}
        </button>
      </form>
    </div>
  );
}
