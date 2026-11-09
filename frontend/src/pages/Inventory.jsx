// Inventory: every product with its quantity at both stores, plus Sell /
// Restock / Adjust for the store the user may act on.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, money } from "../api";
import { can, useAuth } from "../auth";
import { Alert, Empty, Modal, Spinner } from "../components/ui";

export default function Inventory() {
  const { user } = useAuth();
  const [stores, setStores] = useState([]);
  const [products, setProducts] = useState(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [actingStoreId, setActingStoreId] = useState(user.store?.id ?? null);
  const [action, setAction] = useState(null); // { kind, product }
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (category) params.set("category", category);
      const [{ stores }, { products }] = await Promise.all([api("/stores"), api(`/products?${params}`)]);
      setStores(stores);
      setProducts(products);
      setActingStoreId((id) => id ?? stores[0]?.id ?? null); // admins start on the first store
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [q, category]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing in the search box
    return () => clearTimeout(t);
  }, [load]);

  const categories = useMemo(
    () => [...new Set((products ?? []).map((p) => p.category))].sort(),
    [products],
  );
  const actingStore = stores.find((s) => s.id === actingStoreId);

  function done(message) {
    setAction(null);
    setNotice(message);
    load();
  }

  return (
    <section>
      <div className="page-head">
        <h1>Inventory</h1>
        <div className="toolbar">
          <input placeholder="Search name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          {user.role === "admin" && (
            <label className="inline">
              Acting at
              <select value={actingStoreId ?? ""} onChange={(e) => setActingStoreId(Number(e.target.value))}>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>
      <Alert onClose={() => setError(null)}>{error}</Alert>

      {!products ? <Spinner /> : products.length === 0 ? <Empty>No products match.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>Product</th><th>Category</th><th className="num">Price</th>
                {stores.map((s) => <th key={s.id} className={`num ${s.id === actingStoreId ? "hl" : ""}`}>{s.code}</th>)}
                <th className="num">Total</th>
                <th>Actions {actingStore && <span className="muted small">at {actingStore.code}</span>}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.sku}</td>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td className="num">{money(p.priceCents)}</td>
                  {stores.map((s) => {
                    const qty = p.stock[s.code] ?? 0;
                    const low = qty <= p.reorderThreshold;
                    return (
                      <td key={s.id} className={`num ${s.id === actingStoreId ? "hl" : ""}`}>
                        <span className={low ? (qty === 0 ? "qty out" : "qty low") : "qty"} title={`Reorder at ${p.reorderThreshold}`}>{qty}</span>
                      </td>
                    );
                  })}
                  <td className="num">{p.totalQuantity}</td>
                  <td className="actions">
                    {actingStoreId && can.actOnStore(user, actingStoreId) && (
                      <>
                        <button className="btn small primary" onClick={() => setAction({ kind: "sell", product: p })}
                          disabled={(p.stock[actingStore?.code] ?? 0) === 0}>Sell</button>
                        <button className="btn small" onClick={() => setAction({ kind: "restock", product: p })}>Restock</button>
                        {can.adjust(user, actingStoreId) && (
                          <button className="btn small ghost" onClick={() => setAction({ kind: "adjust", product: p })}>Adjust</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {action && actingStore && (
        <StockActionModal action={action} store={actingStore} onClose={() => setAction(null)} onDone={done} />
      )}
    </section>
  );
}

const ACTIONS = {
  sell: { title: "Sell", path: "/sales", button: "Record sale" },
  restock: { title: "Restock", path: "/restocks", button: "Add stock" },
  adjust: { title: "Adjust stock", path: "/adjustments", button: "Save adjustment" },
};

function StockActionModal({ action, store, onClose, onDone }) {
  const { kind, product } = action;
  const cfg = ACTIONS[kind];
  const current = product.stock[store.code] ?? 0;
  const [amount, setAmount] = useState(kind === "adjust" ? -1 : 1);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = { storeId: store.id, productId: product.id };
    const body =
      kind === "adjust"
        ? { ...base, change: Number(amount), reason: text }
        : { ...base, quantity: Number(amount), ...(text.trim() ? { note: text.trim() } : {}) };
    try {
      const res = await api(cfg.path, { method: "POST", body });
      const after = (res.sale ?? res.restock ?? res.adjustment).quantityAfter;
      const verb = kind === "sell" ? `Sold ${amount}` : kind === "restock" ? `Added ${amount}` : `Adjusted by ${amount}`;
      onDone(`${verb} × ${product.name} at ${store.code}. Now ${after} in stock.`);
    } catch (err) {
      // e.g. someone else bought the last unit a moment ago -> 409 OUT_OF_STOCK
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`${cfg.title}: ${product.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="muted">{store.name} currently has <strong>{current}</strong> in stock.</p>
        <label>
          {kind === "adjust" ? "Change (negative removes units)" : "Quantity"}
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            min={kind === "adjust" ? -1000 : 1} max={1000} step="1" required autoFocus />
        </label>
        <label>
          {kind === "adjust" ? "Reason (required)" : "Note (optional)"}
          <input value={text} onChange={(e) => setText(e.target.value)} required={kind === "adjust"} minLength={kind === "adjust" ? 3 : undefined}
            placeholder={kind === "adjust" ? "e.g. Water damage, recount" : kind === "restock" ? "e.g. Delivery #1042" : ""} />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : cfg.button}</button>
        </div>
      </form>
    </Modal>
  );
}
