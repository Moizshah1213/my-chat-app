'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type AuditEntry } from '@/lib/api';
import { auditActionLabel, auditDetails } from '@/lib/audit-format';

const WHEN = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Recent privileged activity for the workspace (owner/admin). */
export default function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listAuditLogs(100));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      {error && <div className="alert">{error}</div>}
        <div className="card">
          <h2>Recent activity</h2>
          {loading && <div className="muted">Loading…</div>}
          {!loading && entries.length === 0 && !error && (
            <div className="muted">No activity recorded yet.</div>
          )}
          {entries.length > 0 && (
            <table className="list">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Activity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{WHEN.format(new Date(e.createdAt))}</td>
                    <td>{auditActionLabel(e.action)}</td>
                    <td className="muted">{auditDetails(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
  );
}
