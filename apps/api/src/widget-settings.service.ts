import { eq } from 'drizzle-orm';
import { widgetSettings } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import {
  AppError,
  forbidden,
  roleCan,
  updateWidgetSettingsSchema,
  type Role,
  type UpdateWidgetSettingsInput,
} from '@livechat/shared';
import { parse } from './validation.js';
import { apiKeyService } from './api-keys.service.js';

/**
 * WidgetSettingsService — widget customization (blueprint §10).
 *
 * Two surfaces:
 *  1. Agent-facing GET/PATCH /v1/widget/settings (settings:update capability) —
 *     the full settings row, including allowedDomains (the site allowlist).
 *  2. PUBLIC GET /widget/v1/settings?key=qvse_… — the bootstrap config the
 *     embeddable widget fetches. Resolves the key to a workspace (revocation
 *     + liveness checked by apiKeyService), enforces the Origin allowlist, and
 *     returns ONLY the public projection (never allowedDomains or aiInstructions).
 */

const DB_URL = () => process.env.DATABASE_URL!;

/** Full settings view (agent-facing). Mirrors the widget_settings row shape. */
export interface WidgetSettingsView {
  color: string;
  theme: 'dark' | 'light';
  backgroundColor: string;
  backgroundGradient: boolean;
  backgroundGradientColor: string;
  buttonColor: string;
  agentBubbleColor: string;
  logoUrl: string | null;
  position: string;
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: unknown[];
  prechatEnabled: boolean;
  workingHours: Record<string, unknown>;
  quickReplies: string[];
  aiEnabled: boolean;
  aiInstructions: string | null;
  allowedDomains: string[];
  language: string;
}

/** Public projection — everything the widget needs to render, nothing sensitive. */
export interface PublicWidgetSettings {
  color: string;
  theme: 'dark' | 'light';
  backgroundColor: string;
  backgroundGradient: boolean;
  backgroundGradientColor: string;
  buttonColor: string;
  agentBubbleColor: string;
  logoUrl: string | null;
  position: string;
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: unknown[];
  prechatEnabled: boolean;
  workingHours: Record<string, unknown>;
  quickReplies: string[];
  aiEnabled: boolean;
  language: string;
}

/** Defaults applied when the workspace has no widget_settings row yet. */
const DEFAULT_SETTINGS: WidgetSettingsView = {
  color: '#303033',
  theme: 'dark',
  backgroundColor: '#000000',
  backgroundGradient: false,
  backgroundGradientColor: '#19191d',
  buttonColor: '#f4f4f5',
  agentBubbleColor: '#1b1b1c',
  logoUrl: null,
  position: 'right',
  greeting: null,
  offlineMessage: null,
  prechatFields: [],
  prechatEnabled: true,
  workingHours: {},
  quickReplies: [],
  aiEnabled: false,
  aiInstructions: null,
  allowedDomains: [],
  language: 'en',
};

type SettingsRow = {
  color: string;
  theme: string;
  backgroundColor: string;
  backgroundGradient: boolean;
  backgroundGradientColor: string;
  buttonColor: string;
  agentBubbleColor: string;
  logoUrl: string | null;
  position: string;
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: unknown;
  prechatEnabled: boolean;
  workingHours: unknown;
  quickReplies: unknown;
  aiEnabled: boolean;
  aiInstructions: string | null;
  allowedDomains: string[];
  language: string;
};

function toView(row: SettingsRow): WidgetSettingsView {
  return {
    color: row.color,
    theme: row.theme === 'light' ? 'light' : 'dark',
    backgroundColor: row.backgroundColor,
    backgroundGradient: row.backgroundGradient,
    backgroundGradientColor: row.backgroundGradientColor,
    buttonColor: row.buttonColor,
    agentBubbleColor: row.agentBubbleColor,
    logoUrl: row.logoUrl,
    position: row.position,
    greeting: row.greeting,
    offlineMessage: row.offlineMessage,
    prechatFields: (row.prechatFields as unknown[]) ?? [],
    prechatEnabled: row.prechatEnabled,
    workingHours: (row.workingHours as Record<string, unknown>) ?? {},
    quickReplies: Array.isArray(row.quickReplies)
      ? row.quickReplies.filter((reply): reply is string => typeof reply === 'string')
      : [],
    aiEnabled: row.aiEnabled,
    aiInstructions: row.aiInstructions,
    allowedDomains: row.allowedDomains,
    language: row.language,
  };
}

/** Match Origin host against allowlist entries ("example.com" or "*.example.com"). */
function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h.endsWith('.' + base) && h !== base;
    }
    return h === p;
  });
}

export const widgetSettingsService = {
  /** Agent-facing full settings (defaults when no row exists yet). */
  async getSettings(workspaceId: string, role: Role): Promise<WidgetSettingsView> {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role for this action');
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.workspaceId, workspaceId));
      return row ? toView(row) : DEFAULT_SETTINGS;
    });
  },

  /**
   * Update settings. Upsert: a workspace with no row yet gets one; existing
   * rows are patched with only the provided fields (undefined = untouched,
   * null = cleared). Mass-assignment is blocked by the strict zod schema.
   */
  async updateSettings(
    workspaceId: string,
    role: Role,
    body: unknown,
  ): Promise<WidgetSettingsView> {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role for this action');
    const input: UpdateWidgetSettingsInput = parse(updateWidgetSettingsSchema, body);

    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .insert(widgetSettings)
        .values({ workspaceId, ...input })
        .onConflictDoUpdate({
          target: widgetSettings.workspaceId,
          set: input,
        })
        .returning();
      if (!row) throw new AppError('internal_error', 'Failed to update settings', 500);
      return toView(row);
    });
  },

  /**
   * PUBLIC: widget bootstrap config for a qvse_… key. Resolves + verifies the
   * key (404 for unknown/revoked/forged), enforces the workspace's Origin
   * allowlist when configured (403), then returns the public projection.
   */
  async publicSettings(publicKey: string, origin?: string): Promise<PublicWidgetSettings> {
    const workspaceId = await apiKeyService.resolveWorkspaceByPublicKey(publicKey);
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.workspaceId, workspaceId));
      const settings = row ? toView(row) : DEFAULT_SETTINGS;

      if (settings.allowedDomains.length > 0 && origin) {
        let host = '';
        try {
          host = new URL(origin).hostname;
        } catch {
          throw forbidden('Origin not allowed');
        }
        if (!host || !hostAllowed(host, settings.allowedDomains)) {
          throw forbidden('Origin not allowed');
        }
      }

      return {
        color: settings.color,
        theme: settings.theme,
        backgroundColor: settings.backgroundColor,
        backgroundGradient: settings.backgroundGradient,
        backgroundGradientColor: settings.backgroundGradientColor,
        buttonColor: settings.buttonColor,
        agentBubbleColor: settings.agentBubbleColor,
        logoUrl: settings.logoUrl,
        position: settings.position,
        greeting: settings.greeting,
        offlineMessage: settings.offlineMessage,
        prechatFields: settings.prechatFields,
        prechatEnabled: settings.prechatEnabled,
        workingHours: settings.workingHours,
        quickReplies: settings.quickReplies,
        aiEnabled: settings.aiEnabled,
        language: settings.language,
      };
    });
  },
  /**
   * Generate a self-contained embeddable JS snippet for a public key.
   */
  embedScript(publicKey: string): string {
    var safeKey = publicKey.replace(/[^a-zA-Z0-9_]/g, '');
    var bundleUrl = process.env.WIDGET_BUNDLE_URL || '/widget/v1/bundle.js';
    var js = '(function(){var d=document;var s=d.createElement(\'script\');';
    js += 's.src=\'' + bundleUrl + '\';';
    js += 's.dataset.publicKey=\'' + safeKey + '\';';
    js += 's.async=true;d.head.appendChild(s);})();';
    return js;
  },
};
