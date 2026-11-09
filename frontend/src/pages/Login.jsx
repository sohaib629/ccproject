import { useState } from "react";
import { useAuth } from "../auth";
import { errorMessage } from "../api";
import { Alert } from "../components/ui";

const DEMO_ACCOUNTS = [
  ["admin@stocksync.dev", "Admin"],
  ["manager.dt@stocksync.dev", "Manager · Downtown"],
  ["staff.dt@stocksync.dev", "Staff · Downtown"],
  ["manager.ny@stocksync.dev", "Manager · North York"],
  ["staff.ny@stocksync.dev", "Staff · North York"],
];

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand big">
          <img src="/favicon.svg" alt="" width="36" height="36" />
          <span>StockSync</span>
        </div>
        <p className="muted">Inventory for StockSync Downtown and North York</p>

        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <Alert>{error}</Alert>
        <button className="btn primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>

        <details className="demo">
          <summary>Demo accounts</summary>
          <p className="muted small">Password for all: <code>StockSync!2026</code></p>
          <div className="demo-list">
            {DEMO_ACCOUNTS.map(([addr, label]) => (
              <button type="button" key={addr} className="btn ghost small" onClick={() => { setEmail(addr); setPassword("StockSync!2026"); }}>
                {label}
              </button>
            ))}
          </div>
        </details>
      </form>
    </div>
  );
}
