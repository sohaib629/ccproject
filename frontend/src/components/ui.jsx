// Small shared UI pieces.
import { useEffect } from "react";

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Alert({ kind = "error", children, onClose }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onClose && <button className="icon-btn" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  );
}

const STATUS_LABELS = {
  requested: "Requested",
  in_transit: "In transit",
  received: "Received",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Spinner({ label = "Loading…" }) {
  return <div className="muted pad">{label}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
