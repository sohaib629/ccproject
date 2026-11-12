import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { can, useAuth } from "./auth";
import Login from "./pages/Login";
import Inventory from "./pages/Inventory";
import Transfers from "./pages/Transfers";
import History from "./pages/History";
import LowStock from "./pages/LowStock";
import System from "./pages/System";
import Admin from "./pages/Admin";

export default function App() {
  const { user, logout } = useAuth();
  if (!user) return <Login />;

  const links = [
    ["/inventory", "Inventory"],
    ["/transfers", "Transfers"],
    ["/low-stock", "Low stock"],
    ["/history", "History"],
    ...(can.viewSystem(user) ? [["/admin", "Admin"], ["/system", "System"]] : []),
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="26" height="26" />
          <span>StockSync</span>
        </div>
        <nav>
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <div>
            <strong>{user.fullName}</strong>
            <span className={`role role-${user.role}`}>{user.role}</span>
          </div>
          <div className="muted small">{user.store ? user.store.name : "All locations"}</div>
        </div>
        <button className="btn ghost" onClick={logout}>Log out</button>
      </header>

      <main className="content">
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/low-stock" element={<LowStock />} />
          <Route path="/history" element={<History />} />
          <Route path="/admin" element={can.viewSystem(user) ? <Admin /> : <Navigate to="/inventory" replace />} />
          <Route path="/system" element={can.viewSystem(user) ? <System /> : <Navigate to="/inventory" replace />} />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </main>
      <BuildFooter />
    </div>
  );
}

/** Which build is live: the git commit the running API was built from. */
function BuildFooter() {
  const [build, setBuild] = useState(null);
  useEffect(() => {
    api("/health").then(setBuild).catch(() => setBuild(null));
  }, []);
  if (!build) return null;
  return (
    <footer className="footer muted small">
      StockSync {build.version} · build <code>{build.commit}</code>
      {build.deployedAt && <> · deployed {new Date(build.deployedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</>}
    </footer>
  );
}
