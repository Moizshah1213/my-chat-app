
/** Tables that carry workspace_id and therefore require RLS policies. */
export const TENANT_TABLES = [
  'memberships',
  'invitations',
  'widget_settings',
  'api_keys',
  'visitors',
  'conversations',
  'messages',
  'audit_logs',
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];
