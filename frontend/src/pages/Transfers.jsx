// Transfers: request units from the other store, and move each transfer through
// requested -> in transit -> received (or cancelled). Buttons appear only for the
// person allowed to press them; the API enforces the same rules.
import { useCallback, useEffect, useState } from "react";
import { api, dateTime, errorMessage } from "../api";
import { can, useAuth } from "../auth";
import { Alert, Empty, Modal, Spinner, StatusBadge } from "../components/ui";

export default function Transfers() {
  const { user } = useAuth();
  const [transfers, setTransfers] = useState(null);
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { transfers } = await api(`/transfers${status ? `?status=${status}` : ""}`);
      setTransfers(transfers);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  async function act(t, step) {
    setBusyId(t.id);
    setError(null);
    try {
      let body;
      if (step === "cancel") {
        const reason = window.prompt("Reason for cancelling (optional):") ?? undefined;
        body = reason?.trim() ? { reason: reason.trim() } : {};
      }
      await api(`/transfers/${t.id}/${step}`, { method: "POST", body });
      setNotice(`Transfer #${t.id} ${step === "dispatch" ? "dispatched" : step === "receive" ? "received" : "cancelled"}.`);
      await load();
    } catch (err) {
      setError(`Transfer #${t.id}: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="page-head">
        <h1>Transfers</h1>
        <div className="toolbar">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="requested">Requested</option>
            <option value="in_transit">In transit</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button className="btn primary" onClick={() => setCreating(true)}>New transfer</button>
        </div>
      </div>

      <p className="muted small flow">Requested → <b>Dispatch</b> (source manager, units leave) → In transit → <b>Receive</b> (destination store, units arrive) → Received</p>
      <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>
      <Alert onClose={() => setError(null)}>{error}</Alert>

      {!transfers ? <Spinner /> : transfers.length === 0 ? <Empty>No transfers yet.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Product</th><th>Route</th><th className="num">Qty</th><th>Status</th><th>Requested</th><th>Note</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td><span className="mono small">{t.sku}</span><br />{t.productName}</td>
                  <td>{t.fromStoreCode} → {t.toStoreCode}</td>
                  <td className="num">{t.quantity}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="small">{dateTime(t.requestedAt)}</td>
                  <td className="small muted">{t.note}</td>
                  <td className="actions">
                    {t.status === "requested" && can.dispatch(user, t) && (
                      <button className="btn small primary" disabled={busyId === t.id} onClick={() => act(t, "dispatch")}>Dispatch</button>
                    )}
                    {t.status === "in_transit" && can.receive(user, t) && (
                      <button className="btn small primary" disabled={busyId === t.id} onClick={() => act(t, "receive")}>Receive</button>
                    )}
                    {["requested", "in_transit"].includes(t.status) && can.cancel(user, t) && (
                      <button className="btn small ghost" disabled={busyId === t.id} onClick={() => act(t, "cancel")}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewTransferModal user={user} onClose={() => setCreating(false)}
          onCreated={(t) => { setCreating(false); setNotice(`Transfer #${t.id} requested.`); load(); }} />
      )}
    </section>
  );
}

function NewTransferModal({ user, onClose, onCreated }) {
  const [stores, setStores] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ productId: "", fromStoreId: "", toStoreId: "", quantity: 1, note: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api("/stores"), api("/products")]).then(([{ stores }, { products }]) => {
      setStores(stores);
      setProducts(products);
      // Default: my store asks the other store for units.
      const mine = user.store?.id ?? stores[1]?.id;
      const other = stores.find((s) => s.id !== mine)?.id;
      setForm((f) => ({ ...f, toStoreId: mine, fromStoreId: other, productId: products[0]?.id }));
    }).catch((err) => setError(errorMessage(err)));
  }, [user]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const product = products.find((p) => p.id === Number(form.productId));
  const fromStore = stores.find((s) => s.id === Number(form.fromStoreId));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { transfer } = await api("/transfers", {
        method: "POST",
        body: {
          productId: Number(form.productId),
          fromStoreId: Number(form.fromStoreId),
          toStoreId: Number(form.toStoreId),
          quantity: Number(form.quantity),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      });
      onCreated(transfer);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New transfer" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Product
          <select value={form.productId} onChange={set("productId")} required>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
          </select>
        </label>
        <div className="row">
          <label>
            From
            <select value={form.fromStoreId} onChange={set("fromStoreId")} required>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            To
            <select value={form.toStoreId} onChange={set("toStoreId")} required>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        {product && fromStore && (
          <p className="muted small">{fromStore.name} has {product.stock[fromStore.code] ?? 0} of this product right now.</p>
        )}
        <label>
          Quantity
          <input type="number" min="1" max="1000" value={form.quantity} onChange={set("quantity")} required />
        </label>
        <label>
          Note (optional)
          <input value={form.note} onChange={set("note")} placeholder="e.g. Customer waiting" />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Requesting…" : "Request transfer"}</button>
        </div>
      </form>
    </Modal>
  );
}
