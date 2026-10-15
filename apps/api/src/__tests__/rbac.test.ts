import '../load-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { roleCan, ROLE_CAPABILITIES, ROLES, type Role, type Capability } from '@livechat/shared';

/**
 * Role permission matrix tests (blueprint §8.9).
 * Pure unit tests over the single source of truth for authorization. This
 * complements the HTTP-level guard tests.
 */

const CAPABILITIES = Object.keys(ROLE_CAPABILITIES) as Capability[];

// Expected matrix (from blueprint §7 Authorization table + workspace settings).
const EXPECTED: Record<Capability, Role[]> = {
  'workspace:read': ['owner', 'admin', 'agent'],
  'workspace:update': ['owner', 'admin'],
  'workspace:delete': ['owner'],
  'billing:manage': ['owner'],
  'members:read': ['owner', 'admin'],
  'members:invite': ['owner', 'admin'],
  'members:update-role': ['owner'],
  'members:remove': ['owner', 'admin'],
  'apikeys:read': ['owner', 'admin'],
  'apikeys:manage': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
  'conversations:read': ['owner', 'admin', 'agent'],
  'conversations:write': ['owner', 'admin', 'agent'],
  'settings:update': ['owner', 'admin'],
};

describe('RBAC permission matrix', () => {
  it('agents have the least privilege (no admin/owner actions)', () => {
    const denied: Capability[] = [
      'workspace:delete',
      'billing:manage',
      'members:read',
      'members:invite',
      'members:update-role',
      'members:remove',
      'apikeys:read',
      'apikeys:manage',
      'settings:update',
      'workspace:update',
    ];
    for (const cap of denied) {
      assert.equal(roleCan('agent', cap), false, `agent must NOT have ${cap}`);
    }
    // but agents CAN read + write conversations
    assert.equal(roleCan('agent', 'conversations:read'), true);
    assert.equal(roleCan('agent', 'conversations:write'), true);
    assert.equal(roleCan('agent', 'workspace:read'), true);
  });

  it('admins cannot delete workspace, manage billing, or change roles', () => {
    for (const cap of ['workspace:delete', 'billing:manage', 'members:update-role'] as Capability[]) {
      assert.equal(roleCan('admin', cap), false, `admin must NOT have ${cap}`);
    }
    // admins CAN invite + remove members, update settings, manage api keys
    for (const cap of ['members:invite', 'members:remove', 'settings:update', 'apikeys:manage'] as Capability[]) {
      assert.equal(roleCan('admin', cap), true, `admin SHOULD have ${cap}`);
    }
  });

  it('owner can do everything', () => {
    for (const cap of CAPABILITIES) {
      assert.equal(roleCan('owner', cap), true, `owner must have ${cap}`);
    }
  });

  it('matches the expected matrix exactly (no accidental grants)', () => {
    for (const cap of CAPABILITIES) {
      for (const role of ROLES) {
        const expected = EXPECTED[cap]?.includes(role) ?? false;
        assert.equal(
          roleCan(role, cap),
          expected,
          `roleCan(${role}, ${cap}) should be ${expected}`,
        );
      }
    }
  });

  it('every capability lists at least one role (no dead capabilities)', () => {
    for (const cap of CAPABILITIES) {
      assert.ok((EXPECTED[cap]?.length ?? 0) > 0, `${cap} should grant to at least one role`);
    }
  });
});
