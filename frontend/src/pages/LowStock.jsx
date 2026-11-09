// Products at or below their reorder threshold, biggest shortfall first.
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Alert, Empty, Spinner } from "../components/ui";

export default function LowStock() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/low-stock").then((d) => setRows(d.lowStock)).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <section>
      <div className="page-head"><h1>Low stock</h1></div>
      <p className="muted small">Items at or below their reorder threshold in either store.</p>
      <Alert>{error}</Alert>
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>Nothing needs reordering.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Store</th><th>SKU</th><th>Product</th><th>Category</th><th className="num">In stock</th><th className="num">Reorder at</th><th className="num">Short by</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.storeId}-${r.productId}`}>
                  <td>{r.storeCode}</td>
                  <td className="mono">{r.sku}</td>
                  <td>{r.name}</td>
                  <td>{r.category}</td>
                  <td className="num"><span className={r.quantity === 0 ? "qty out" : "qty low"}>{r.quantity}</span></td>
                  <td className="num">{r.reorderThreshold}</td>
                  <td className="num">{r.shortfall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
