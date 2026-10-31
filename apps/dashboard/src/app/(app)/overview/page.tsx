'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { api, type AuditEntry, type Conversation } from '@/lib/api';
import { auditActionLabel, auditDetails } from '@/lib/audit-format';
import { timeAgo } from '../components/inbox-list';

interface Data {
  convs: Conversation[];
  visitors: number;
  members: number;
  activeKeys: number;
  errors: string[];
  /** null = not allowed to read the audit log (agents) or failed to load. */
  audit: AuditEntry[] | null;
}

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const iv = (i: number) => ({ '--i': i }) as CSSProperties;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function CountUp({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [count, setCount] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    const from = current.current;
    const start = performance.now() + 250;
    let frame = 0;
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / 1400, 1);
      const eased = progress <= 0 ? 0 : progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const next = Math.round(from + (value - from) * eased);
      current.current = next;
      setCount(next);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{count.toLocaleString()}{suffix}</>;
}

/** Round a chart maximum up to a clean multiple of 4 so the y-axis has 4 even steps. */
function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(n / 4)));
  const m = [1, 2, 2.5, 5, 10].find((k) => k * step * 4 >= n) ?? 10;
  return m * step * 4;
}

/** Overview: live numbers computed from the same API the inbox uses. */
export default function OverviewPage() {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    let off = false;
    (async () => {
      const [c, v, m, k, a] = await Promise.allSettled([
        api.listConversations({ limit: 100 }),
        api.listVisitors(),
        api.listMembers(),
        api.listApiKeys(),
        api.listAuditLogs(6),
      ]);
      if (off) return;
      const errors: string[] = [];
      if (c.status === 'rejected') errors.push('conversations');
      if (v.status === 'rejected') errors.push('visitors');
      if (m.status === 'rejected') errors.push('team');
      if (k.status === 'rejected') errors.push('API keys');
      setData({
        convs: c.status === 'fulfilled' ? c.value.items : [],
        visitors: v.status === 'fulfilled' ? v.value.length : 0,
        members: m.status === 'fulfilled' ? m.value.length : 0,
        activeKeys: k.status === 'fulfilled' ? k.value.filter((x) => !x.revokedAt).length : 0,
        errors,
        audit: a.status === 'fulfilled' ? a.value : null,
      });
    })();
    return () => {
      off = true;
    };
  }, []);

  const s = useMemo(() => {
    const convs = data?.convs ?? [];
    const now = new Date();
    const open = convs.filter((c) => c.status === 'open').length;
    const pending = convs.filter((c) => c.status === 'pending').length;
    const closed = convs.filter((c) => c.status === 'closed').length;
    const queue = convs.filter((c) => c.status !== 'closed');
    const unassigned = queue.filter((c) => !c.assignedTo).length;
    const today = convs.filter((c) => sameDay(new Date(c.lastMessageAt), now)).length;
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (6 - i));
      const day = convs.filter((c) => sameDay(new Date(c.createdAt), d));
      const resolved = day.filter((c) => c.status === 'closed').length;
      return { letter: DAY_LETTERS[d.getDay()] ?? '', resolved, open: day.length - resolved };
    });
    const max = niceMax(Math.max(0, ...week.map((d) => d.resolved + d.open)));
    const total = convs.length;
    return {
      open, pending, closed, unassigned, today, week, max, total,
      resolvedPct: total ? Math.round((closed / total) * 100) : 0,
      assignedPct: queue.length ? Math.round(((queue.length - unassigned) / queue.length) * 100) : 100,
      queue: queue.length,
    };
  }, [data]);

  const loading = data === null;

  return (
    <div className="page">
      {data?.errors.length ? (
        <div className="alert" role="status">
          Could not load {data.errors.join(', ')}. Check your connection and refresh.
        </div>
      ) : null}
      <div className="grid g3 eq">
        {/* Open conversations */}
        <div className="card col">
          <h3>Open conversations</h3>
          {loading ? (
            <div className="skl" style={{ '--h': '230px', marginTop: 14 } as CSSProperties} />
          ) : (
            <>
              <div className="big rv" style={iv(0)}>
                <CountUp value={s.open} />
              </div>
              <div className="rv" style={iv(1)}>
                <span className={s.unassigned ? 'chip' : 'chip'}>
                  {s.unassigned} unassigned
                </span>{' '}
                <span className="m">in the queue</span>
              </div>
              <div className="acts rv" style={iv(2)}>
                <Link className="btn" href="/conversations">Reply now</Link>
                <Link className="btn s" href="/settings/members">Invite teammate</Link>
              </div>
              <div className="mini push rv" style={iv(3)}>
                <div>Open<b>{s.open}</b><span className="chip">Live</span></div>
                <div>Pending<b>{s.pending}</b><span className="chip n">Waiting</span></div>
                <div>Closed<b>{s.closed}</b><span className="chip n">Done</span></div>
              </div>
            </>
          )}
        </div>

        <div className="hero">
          {loading ? (
            <div className="skl d" style={{ '--h': '312px' } as CSSProperties} />
          ) : (
            <>
              <div className="hr">
                <span className="tag">Today</span>
                <span className="tag">{s.total} conversations loaded</span>
              </div>
              <div className="hn">
                <b><CountUp value={s.today} /></b>
                <span>conversations today</span>
              </div>
              <div className="prog w"><i style={{ width: `${s.resolvedPct}%` }} /></div>
              <div className="hl">
                <span>Resolution rate</span>
                <span>{s.closed} of {s.total} resolved</span>
              </div>
              <div className="glass push">
                <div><span>Visitors</span><b><CountUp value={data.visitors} /></b></div>
                <div><span>Pending</span><b><CountUp value={s.pending} /></b></div>
                <div><span>Resolved</span><b><CountUp value={s.resolvedPct} suffix="%" /></b></div>
              </div>
            </>
          )}
        </div>

        {/* Stacked chart */}
        <div className="card col">
          <div className="hr2">
            <div>
              <h3>Conversations this week</h3>
              <p className="m">Started per day · resolved vs open</p>
            </div>
            <div className="lgd">
              <span><i style={{ background: 'var(--on)' }} />Resolved</span>
              <span><i className="ho" />Open</span>
            </div>
          </div>
          {loading ? (
            <div className="skl" style={{ '--h': '250px', marginTop: 24 } as CSSProperties} />
          ) : (
            <div className="chart">
              <div className="ya" aria-hidden="true">
                {[4, 3, 2, 1, 0].map((k, i) => (
                  <span key={k} style={{ top: `${i * 25}%` }}>{Math.round((s.max / 4) * k)}</span>
                ))}
              </div>
              <div className="plot" role="img" aria-label="Conversations started per day for the last 7 days">
                {s.week.map((d, i) => {
                  const total = d.resolved + d.open;
                  return (
                    <div className="cl2" key={i} style={{ '--t': (total / s.max) * 100 } as CSSProperties}>
                      <div className="tip">
                        {total} {total === 1 ? 'chat' : 'chats'}
                        <small>{d.resolved} resolved · {d.open} open</small>
                      </div>
                      {d.open > 0 && (
                        <div className="sg o" style={{ height: `${(d.open / s.max) * 100}%`, animationDelay: `${0.35 + i * 0.09}s` }} />
                      )}
                      {d.resolved > 0 && (
                        <div className="sg r" style={{ height: `${(d.resolved / s.max) * 100}%`, animationDelay: `${0.35 + i * 0.09}s` }} />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="xl">{s.week.map((d, i) => <span key={i}>{d.letter}</span>)}</div>
            </div>
          )}
        </div>
      </div>

      <div className="grid g3 eq" style={{ marginTop: 18 }}>
        <div className="dark">
          {loading ? (
            <div className="skl d" style={{ '--h': '280px' } as CSSProperties} />
          ) : (
            <>
              <div className="hr">
                <h3>Team workload</h3>
                <span className="tag">{data.members} {data.members === 1 ? 'member' : 'members'}</span>
              </div>
              <div className="hn">
                <b><CountUp value={s.queue} /></b>
                <span>conversations in queue</span>
              </div>
              <div className="prog w"><i style={{ width: `${s.assignedPct}%` }} /></div>
              <div className="hl">
                <span>{s.assignedPct}% assigned</span>
                <span>{s.unassigned} unassigned</span>
              </div>
              <div className="glass push">
                <div><span>Members</span><b><CountUp value={data.members} /></b></div>
                <div><span>Active keys</span><b><CountUp value={data.activeKeys} /></b></div>
                <div><span>Visitors</span><b><CountUp value={data.visitors} /></b></div>
              </div>
            </>
          )}
        </div>

        {/* Recent activity */}
        <div className="card span2">
          <h3>Recent activity</h3>
          {loading ? (
            <div className="skl" style={{ '--h': '200px', marginTop: 14 } as CSSProperties} />
          ) : data.audit === null ? (
            <p className="muted">Activity is visible to workspace owners and admins.</p>
          ) : data.audit.length === 0 ? (
            <p className="muted">No activity recorded yet.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Activity</th><th>Details</th><th>When</th></tr>
                </thead>
                <tbody>
                  {data.audit.map((e) => (
                    <tr key={e.id}>
                      <td>{auditActionLabel(e.action)}</td>
                      <td className="muted">{auditDetails(e)}</td>
                      <td className="muted">{timeAgo(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
