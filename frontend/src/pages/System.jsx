// System (admin only): live view of the infrastructure behind StockSync.
// Refreshes every few seconds. Each refresh may be answered by a different API
// replica; the "Replicas seen" panel records them, which makes Kubernetes load
// balancing and HPA scaling visible during a demo.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, dateTime, errorMessage } from "../api";
import { Alert, Spinner } from "../components/ui";

const REFRESH_MS = 3000;

function duration(seconds) {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`, !d && !h && `${seconds % 60}s`].filter(Boolean).join(" ");
}

export default function System() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(true);
  const [replicas, setReplicas] = useState({}); // instance -> { count, lastSeen }
  const [lastInstance, setLastInstance] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { data, instance } = await api("/system", { meta: true });
      setData(data);
      setError(null);
      setLastInstance(instance);
      setReplicas((r) => ({ ...r, [instance]: { count: (r[instance]?.count ?? 0) + 1, lastSeen: Date.now() } }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!live) return undefined;
    timer.current = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, [live, refresh]);

  if (!data) return <section><h1>System</h1><Alert>{error}</Alert>{!error && <Spinner />}</section>;
  const { api: a, kubernetes: k, database: db, integrity, auth, routes } = data;
  const now = Date.now();

  return (
    <section className="system">
      <div className="page-head">
        <h1>System</h1>
        <div className="toolbar">
          <span className={`live-dot ${live ? "on" : ""}`} />
          <span className="muted small">{live ? `Live, every ${REFRESH_MS / 1000}s` : "Paused"} · updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
          <button className="btn small" onClick={() => setLive((v) => !v)}>{live ? "Pause" : "Resume"}</button>
          <button className="btn small ghost" onClick={() => setReplicas({})}>Reset replicas</button>
        </div>
      </div>
      <Alert>{error}</Alert>

      <div className="cards">
        <Card title="API instance" hint="The replica that answered this refresh">
          <KV k="Instance" v={<code>{a.instance}</code>} />
          <KV k="Environment" v={a.environment} />
          <KV k="Version" v={a.version} />
          <KV k="Commit" v={a.commitUrl
            ? <a href={a.commitUrl} target="_blank" rel="noreferrer"><code>{a.gitSha}</code></a>
            : <code>{a.gitSha}</code>} />
          <KV k="Deployed" v={a.deployedAt ? new Date(a.deployedAt).toLocaleString() : "— (not deployed by deploy.sh)"} />
          <KV k="Runtime" v={`Node ${a.node} · ${a.platform}`} />
          <KV k="Uptime" v={duration(a.uptimeSeconds)} />
          <KV k="Memory" v={`${a.memoryMb.rss} MB RSS · ${a.memoryMb.heapUsed} MB heap`} />
        </Card>

        <Card title="Replicas seen" hint="Each refresh can hit a different pod">
          {Object.entries(replicas).sort().map(([name, r]) => (
            <div key={name} className={`replica ${name === lastInstance ? "current" : ""} ${now - r.lastSeen > 30000 ? "stale" : ""}`}>
              <code>{name}</code><span>{r.count} responses</span>
            </div>
          ))}
          <p className="muted small">{Object.keys(replicas).length} distinct replica(s). On Kubernetes with several pods, more names appear here.</p>
        </Card>

        <Card title="Kubernetes" hint="From the Downward API (Day 4+)">
          <KV k="Running in Kubernetes" v={k.detected ? "Yes" : "No"} />
          <KV k="Pod" v={k.podName ?? "—"} />
          <KV k="Namespace" v={k.namespace ?? "—"} />
          <KV k="Node" v={k.nodeName ?? "—"} />
          <KV k="Pod IP" v={k.podIp ?? "—"} />
        </Card>

        <Card title="Database" hint="Live queries against PostgreSQL">
          <KV k="Engine" v={`${db.engine} ${db.version}`} />
          <KV k="Database / host" v={`${db.name} @ ${db.host}`} />
          <KV k="Round-trip" v={`${db.latencyMs} ms`} />
          <KV k="Size" v={`${db.sizeMb} MB`} />
          <KV k="Connections" v={`${db.connections.thisDatabase} open (server max ${db.connections.serverMax})`} />
          <KV k="Server uptime" v={duration(db.serverUptimeSeconds)} />
          <KV k="Schema migrations" v={db.migrations?.length
            ? <span title={db.migrations.map((m) => `${m.version} · ${new Date(m.appliedAt).toLocaleString()}`).join("\n")}>
                {db.migrations.length} applied · latest <code>{db.migrations.at(-1).version}</code>
              </span>
            : "none"} />
        </Card>

        <Card title="Connection pool" hint="This replica's pool">
          <Meter label="Open" value={db.pool.open} max={db.pool.max} />
          <KV k="Idle" v={db.pool.idle} />
          <KV k="Waiting for a connection" v={db.pool.waiting} />
          <KV k="Max per replica" v={db.pool.max} />
        </Card>

        <Card title="Data integrity" hint="Checked live on every refresh">
          {integrity.map((c) => (
            <div key={c.check} className="check">
              <span className={c.ok ? "ok" : "bad"}>{c.ok ? "✓" : "✗"}</span>
              <span>{c.check}</span>
              {!c.ok && <span className="bad small">{c.violations} violation(s)</span>}
            </div>
          ))}
        </Card>
      </div>

      <div className="cards two">
        <Card title="Tables" hint="Row counts">
          <table className="compact">
            <tbody>{db.tables.map((t) => <tr key={t.table}><td className="mono">{t.table}</td><td className="num">{t.rows.toLocaleString()}</td></tr>)}</tbody>
          </table>
        </Card>

        <Card title="Authentication" hint="No secret values are ever shown">
          <KV k="Token" v={auth.tokenType} />
          <KV k="Algorithm / lifetime" v={`${auth.algorithm} · ${auth.tokenLifetime}`} />
          <KV k="Signing key" v={`${auth.signingKey.lengthChars} chars, loaded from ${auth.signingKey.source}`} />
          <KV k="DB password" v={`loaded from ${auth.databasePassword.source}`} />
          <KV k="Passwords" v={auth.passwordHashing} />
          <KV k="Login rate limit" v={auth.loginRateLimit} />
          <KV k="Your token expires" v={dateTime(auth.yourToken.expiresAt)} />
        </Card>
      </div>

      <Card title="Roles and permissions" hint="Enforced by the API on every request">
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Action</th>{auth.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
            <tbody>
              {auth.permissions.map((p) => (
                <tr key={p.action}>
                  <td>{p.action}</td>
                  {auth.roles.map((r) => <td key={r} className="perm">{p[r] === true ? "✓" : p[r] === false ? <span className="muted">—</span> : p[r]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`API routes (${routes.length})`} hint="Every endpoint and who may call it">
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Method</th><th>Path</th><th>Access</th><th>Purpose</th></tr></thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.method + r.path}>
                  <td><span className={`method m-${r.method}`}>{r.method}</span></td>
                  <td className="mono">{r.path}</td>
                  <td className="small">{r.access}</td>
                  <td className="small muted">{r.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

function Card({ title, hint, children }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3>{hint && <span className="muted small">{hint}</span>}</div>
      {children}
    </div>
  );
}

function KV({ k, v }) {
  return <div className="kv"><span className="muted">{k}</span><span>{v}</span></div>;
}

function Meter({ label, value, max }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="meter">
      <div className="kv"><span className="muted">{label}</span><span>{value} / {max}</span></div>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
