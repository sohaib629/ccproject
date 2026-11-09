// Audit history: every stock change, who made it and when. Newest first.
import { useCallback, useEffect, useState } from "react";
import { api, dateTime, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Spinner } from "../components/ui";

const TYPES = ["sale", "restock", "adjustment", "transfer_out", "transfer_in", "transfer_return", "initial"];

export default function History() {
  const { user } = useAuth();
  const [stores, setStores] = useState([]);
  const [filters, setFilters] = useState({ storeId: "", type: "" });
  const [rows, setRows] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (user.role === "admin") api("/stores").then((d) => setStores(d.stores)).catch(() => {});
  }, [user]);

  const fetchPage = useCallback(async (before) => {
    const params = new URLSearchParams({ limit: "50" });
    if (filters.storeId) params.set("storeId", filters.storeId);
    if (filters.type) params.set("type", filters.type);
    if (before) params.set("before", before);
    return api(`/movements?${params}`);
  }, [filters]);

  useEffect(() => {
    setRows(null);
    fetchPage().then((d) => { setRows(d.movements); setNextBefore(d.nextBefore); }).catch((err) => setError(errorMessage(err)));
  }, [fetchPage]);

  async function loadMore() {
    try {
      const d = await fetchPage(nextBefore);
      setRows((r) => [...r, ...d.movements]);
      setNextBefore(d.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section>
      <div className="page-head">
        <h1>History</h1>
        <div className="toolbar">
          {user.role === "admin" && (
            <select value={filters.storeId} onChange={(e) => setFilters((f) => ({ ...f, storeId: e.target.value }))}>
              <option value="">All stores</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
        </div>
      </div>
      {user.role !== "admin" && <p className="muted small">Showing {user.store?.name}. The audit log is append-only: entries can never be edited or deleted.</p>}
      <Alert onClose={() => setError(null)}>{error}</Alert>

      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>No entries.</Empty> : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>When</th><th>Store</th><th>Product</th><th>Type</th><th className="num">Change</th><th className="num">After</th><th>By</th><th>Reason / transfer</th></tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{m.id}</td>
                    <td className="small">{dateTime(m.createdAt)}</td>
                    <td>{m.storeCode}</td>
                    <td><span className="mono small">{m.sku}</span></td>
                    <td><span className={`type type-${m.type}`}>{m.type.replace("_", " ")}</span></td>
                    <td className={`num ${m.quantityChange < 0 ? "neg" : "pos"}`}>{m.quantityChange > 0 ? "+" : ""}{m.quantityChange}</td>
                    <td className="num">{m.quantityAfter}</td>
                    <td>{m.userName}</td>
                    <td className="small muted">{m.reason ?? (m.transferId ? `Transfer #${m.transferId}` : "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextBefore && <button className="btn wide" onClick={loadMore}>Load more</button>}
        </>
      )}
    </section>
  );
}
