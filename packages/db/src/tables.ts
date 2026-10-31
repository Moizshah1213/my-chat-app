
/** Tables that carry workspace_id and therefore require RLS policies. */
export const TENANT_TABLES = [
  'memberships',
  'invitations',
  'widget_settings',
  'api_keys',
  'visitors',
  'conversations',
  'messages',
  'conversation_read_cursors',
  'audit_logs',
  'email_settings',
  'ai_settings',
  'ai_usage',

] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];
