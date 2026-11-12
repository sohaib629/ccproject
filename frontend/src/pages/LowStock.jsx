// Products at or below their reorder threshold, biggest shortfall first, with a
// rule-based replenishment suggestion for each store row:
//   suggested = min(2 x reorder level - in stock, units at the distribution centre)
// One click turns the suggestion into a transfer request (DC -> store).
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { can, useAuth } from "../auth";
import { Alert, Empty, Spinner } from "../components/ui";
import { RequestModal } from "./Inventory";

export default function LowStock() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [stores, setStores] = useState([]);
  const [requesting, setRequesting] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.all([api("/low-stock"), api("/stores")])
      .then(([{ lowStock }, { stores }]) => { setRows(lowStock); setStores(stores); })
      .catch((err) => setError(errorMessage(err)));
  }, []);
  useEffect(load, [load]);

  const warehouse = stores.find((s) => s.kind === "warehouse");

  return (
    <section>
      <div className="page-head"><h1>Low stock</h1></div>
      <p className="muted small">
        Items at or below their reorder threshold. Stores are replenished from the distribution centre
        (suggestion: up to twice the reorder level, limited by what the DC has); the DC reorders from suppliers.
      </p>
      <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>
      <Alert onClose={() => setError(null)}>{error}</Alert>
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>Nothing needs reordering.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Location</th><th>SKU</th><th>Product</th><th>Category</th>
                <th className="num">In stock</th><th className="num">Reorder at</th><th className="num">At DC</th>
                <th>Suggestion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const store = stores.find((s) => s.id === r.storeId);
                const mayRequest = r.storeKind === "store" && can.actOnStore(user, r.storeId) && r.suggestedQuantity > 0;
                return (
                  <tr key={`${r.storeId}-${r.productId}`}>
                    <td>{r.storeCode}{r.storeKind === "warehouse" && <span className="muted small"> DC</span>}</td>
                    <td className="mono">{r.sku}</td>
                    <td>{r.name}</td>
                    <td>{r.category}</td>
                    <td className="num"><span className={r.quantity === 0 ? "qty out" : "qty low"}>{r.quantity}</span></td>
                    <td className="num">{r.reorderThreshold}</td>
                    <td className="num">{r.storeKind === "store" ? r.warehouseQuantity : "—"}</td>
                    <td className="actions">
                      {r.storeKind === "warehouse" ? (
                        <span className="muted small">Order from supplier</span>
                      ) : r.suggestedQuantity === 0 ? (
                        <span className="muted small">DC is out too</span>
                      ) : (
                        <>
                          <span className="small">Request {r.suggestedQuantity}</span>{" "}
                          {mayRequest && (
                            <button className="btn small primary" onClick={() => setRequesting({ row: r, store })}>Request</button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {requesting && warehouse && (
        <RequestModal
          product={{ id: requesting.row.productId, name: requesting.row.name, quantity: requesting.row.quantity,
                     warehouseQuantity: requesting.row.warehouseQuantity }}
          store={requesting.store} warehouse={warehouse} suggested={requesting.row.suggestedQuantity}
          onClose={() => setRequesting(null)}
          onDone={(msg) => { setRequesting(null); setNotice(msg); load(); }} />
      )}
    </section>
  );
}
