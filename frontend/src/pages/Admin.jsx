// Administration (admin only): the product catalogue and user accounts.
// Products are never deleted (history must stay meaningful): they are
// deactivated. Account changes take effect at once: a deactivated user or a
// reset password ends that user's existing sessions on every API replica.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, dateTime, errorMessage, money, session } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Modal, Spinner } from "../components/ui";

const PAGE_SIZE = 20;

export default function Admin() {
  const [tab, setTab] = useState("products");
  return (
    <section>
      <div className="page-head">
        <h1>Admin</h1>
        <div className="toolbar tabs">
          <button className={`btn ${tab === "products" ? "primary" : "ghost"}`} onClick={() => setTab("products")}>Products</button>
          <button className={`btn ${tab === "users" ? "primary" : "ghost"}`} onClick={() => setTab("users")}>Users</button>
        </div>
      </div>
      {tab === "products" ? <Products /> : <Users />}
    </section>
  );
}

// --- Products ----------------------------------------------------------------------
function Products() {
  const [products, setProducts] = useState(null);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(null); // product, or {} for a new one
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ includeInactive: "true" });
      if (q.trim()) params.set("q", q.trim());
      setProducts((await api(`/products?${params}`)).products);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => setPage(0), [q, showInactive]);

  const shown = useMemo(() => (products ?? []).filter((p) => showInactive || p.isActive), [products, showInactive]);
  const categories = useMemo(() => [...new Set((products ?? []).map((p) => p.category))].sort(), [products]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const visible = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function toggle(p) {
    setError(null);
    try {
      await api(`/products/${p.id}/${p.isActive ? "deactivate" : "reactivate"}`, { method: "POST" });
      setNotice(`${p.name} ${p.isActive ? "deactivated: no longer sold or transferred" : "reactivated"}.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="toolbar spaced">
        <input placeholder="Search name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated</label>
        <button className="btn primary" onClick={() => setEditing({})}>Add product</button>
      </div>
      <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>
      <Alert onClose={() => setError(null)}>{error}</Alert>
      {!products ? <Spinner /> : shown.length === 0 ? <Empty>No products match.</Empty> : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>SKU</th><th>Product</th><th>Category</th><th className="num">Price</th><th className="num">Reorder at</th><th className="num">Units</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id} className={p.isActive ? "" : "inactive"}>
                    <td className="mono">{p.sku}</td>
                    <td>{p.name}</td>
                    <td>{p.category}</td>
                    <td className="num">{money(p.priceCents)}</td>
                    <td className="num">{p.reorderThreshold}</td>
                    <td className="num">{p.totalQuantity}</td>
                    <td>{p.isActive ? <span className="badge badge-received">Active</span> : <span className="badge badge-cancelled">Deactivated</span>}</td>
                    <td className="actions">
                      <button className="btn small" onClick={() => setEditing(p)}>Edit</button>
                      <button className="btn small ghost" onClick={() => toggle(p)}>{p.isActive ? "Deactivate" : "Reactivate"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted small">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, shown.length)} of {shown.length}</span>
            <button className="btn small ghost" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>‹ Previous</button>
            <span className="small">Page {page + 1} / {pages}</span>
            <button className="btn small ghost" disabled={page >= pages - 1} onClick={() => setPage((n) => n + 1)}>Next ›</button>
          </div>
        </>
      )}
      {editing && (
        <ProductModal product={editing} categories={categories} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); setNotice(msg); load(); }} />
      )}
    </>
  );
}

function ProductModal({ product, categories, onClose, onSaved }) {
  const isNew = !product.id;
  const [form, setForm] = useState({
    sku: product.sku ?? "",
    name: product.name ?? "",
    category: product.category ?? "",
    price: product.priceCents != null ? (product.priceCents / 100).toFixed(2) : "",
    reorderThreshold: product.reorderThreshold ?? 3,
  });
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!isNew) api(`/products/${product.id}/history`).then((d) => setHistory(d.history)).catch(() => setHistory([]));
  }, [isNew, product.id]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      category: form.category.trim(),
      priceCents: Math.round(Number(form.price) * 100),
      reorderThreshold: Number(form.reorderThreshold),
    };
    try {
      const res = isNew
        ? await api("/products", { method: "POST", body: { sku: form.sku.trim(), ...body } })
        : await api(`/products/${product.id}`, { method: "PATCH", body });
      onSaved(isNew ? `${res.product.sku} created with 0 units; receive a supplier delivery at the distribution centre to stock it.`
                    : `${res.product.sku} saved.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={isNew ? "Add product" : `Edit ${product.sku}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {isNew && (
          <label>SKU (cannot be changed later)
            <input value={form.sku} onChange={set("sku")} placeholder="e.g. ACC-USBC-1M" required pattern="[A-Za-z0-9-]{3,32}" autoFocus />
          </label>
        )}
        <label>Name<input value={form.name} onChange={set("name")} required minLength={2} maxLength={120} autoFocus={!isNew} /></label>
        <label>Category
          <input value={form.category} onChange={set("category")} list="categories" required minLength={2} maxLength={50} />
          <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <div className="row">
          <label>Price (CAD)<input type="number" min="0" step="0.01" value={form.price} onChange={set("price")} required /></label>
          <label>Reorder at<input type="number" min="0" max="1000" value={form.reorderThreshold} onChange={set("reorderThreshold")} required /></label>
        </div>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : isNew ? "Create product" : "Save changes"}</button>
        </div>
        {!isNew && <ChangeHistory history={history} />}
      </form>
    </Modal>
  );
}

// --- Users -------------------------------------------------------------------------
function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [stores, setStores] = useState([]);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ users }, { stores }] = await Promise.all([api("/users"), api("/stores")]);
      setUsers(users);
      setStores(stores);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(u) {
    setError(null);
    try {
      await api(`/users/${u.id}/${u.isActive ? "deactivate" : "reactivate"}`, { method: "POST" });
      setNotice(u.isActive ? `${u.fullName} deactivated: cannot log in, and existing sessions have ended.` : `${u.fullName} can log in again.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="toolbar spaced">
        <span className="muted small">Deactivating an account or resetting its password ends that user's sessions immediately.</span>
        <button className="btn primary" onClick={() => setCreating(true)}>Add user</button>
      </div>
      <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>
      <Alert onClose={() => setError(null)}>{error}</Alert>
      {!users ? <Spinner /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Location</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.isActive ? "" : "inactive"}>
                  <td>{u.fullName}{u.id === me.id && <span className="muted small"> (you)</span>}</td>
                  <td>{u.email}</td>
                  <td><span className={`role role-${u.role}`}>{u.role}</span></td>
                  <td>{u.storeName ?? "All locations"}</td>
                  <td>{u.isActive ? <span className="badge badge-received">Active</span> : <span className="badge badge-cancelled">Deactivated</span>}</td>
                  <td className="small">{dateTime(u.createdAt)}</td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setResetting(u)}>Reset password</button>
                    {u.id !== me.id && (
                      <button className="btn small ghost" onClick={() => toggle(u)}>{u.isActive ? "Deactivate" : "Reactivate"}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewUserModal stores={stores} onClose={() => setCreating(false)}
          onSaved={(msg) => { setCreating(false); setNotice(msg); load(); }} />
      )}
      {resetting && (
        <ResetPasswordModal user={resetting} isMe={resetting.id === me.id} onClose={() => setResetting(null)}
          onSaved={(msg) => { setResetting(null); setNotice(msg); load(); }} />
      )}
    </>
  );
}

function NewUserModal({ stores, onClose, onSaved }) {
  const [form, setForm] = useState({ fullName: "", email: "", role: "staff", storeId: stores.find((s) => s.kind === "store")?.id ?? "", password: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api("/users", {
        method: "POST",
        body: {
          fullName: form.fullName.trim(), email: form.email.trim(), role: form.role, password: form.password,
          ...(form.role === "admin" ? {} : { storeId: Number(form.storeId) }),
        },
      });
      onSaved(`${user.fullName} (${user.role}${user.storeCode ? `, ${user.storeCode}` : ""}) can now log in as ${user.email}.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Full name<input value={form.fullName} onChange={set("fullName")} required minLength={2} autoFocus /></label>
        <label>Email<input type="email" value={form.email} onChange={set("email")} required /></label>
        <div className="row">
          <label>Role
            <select value={form.role} onChange={set("role")}>
              <option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option>
            </select>
          </label>
          {form.role !== "admin" && (
            <label>Location
              <select value={form.storeId} onChange={set("storeId")} required>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <label>Initial password (at least 10 characters)
          <input type="password" value={form.password} onChange={set("password")} required minLength={10} autoComplete="new-password" />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create user"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, isMe, onClose, onSaved }) {
  const [password, setPassword] = useState("");
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/users/${user.id}/history`).then((d) => setHistory(d.history)).catch(() => setHistory([]));
  }, [user.id]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${user.id}/password`, { method: "POST", body: { password } });
      if (isMe) {
        session.clear(); // own sessions ended too
        window.dispatchEvent(new Event("stocksync:logout"));
        return;
      }
      onSaved(`Password reset for ${user.fullName}; their existing sessions have ended.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password: ${user.fullName}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {isMe && <p className="muted small">This is your own account: you will be logged out and must log in with the new password.</p>}
        <label>New password (at least 10 characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus autoComplete="new-password" />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Reset password"}</button>
        </div>
        <ChangeHistory history={history} />
      </form>
    </Modal>
  );
}

// --- Shared ------------------------------------------------------------------------
const ACTION_LABELS = {
  created: "Created", updated: "Updated", deactivated: "Deactivated", reactivated: "Reactivated", password_reset: "Password reset",
};

function describe(changes) {
  return Object.entries(changes ?? {})
    .filter(([, v]) => v && typeof v === "object" && "from" in v)
    .map(([k, v]) => `${k}: ${k === "priceCents" ? `${money(v.from)} → ${money(v.to)}` : `${v.from} → ${v.to}`}`)
    .join(", ");
}

function ChangeHistory({ history }) {
  if (!history) return null;
  return (
    <div className="history">
      <h3 className="small">Change history</h3>
      {history.length === 0 ? <p className="muted small">No recorded changes.</p> : (
        <ul className="small">
          {history.map((e) => (
            <li key={e.id}>
              <strong>{ACTION_LABELS[e.action] ?? e.action}</strong> by {e.byName} · {dateTime(e.createdAt)}
              {describe(e.changes) && <span className="muted"> · {describe(e.changes)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
