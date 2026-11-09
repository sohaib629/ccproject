// Login state shared by the whole app, plus the client-side permission rules.
// These rules only decide which buttons to SHOW; the API enforces the same
// rules on every request, so hiding a button is a convenience, not security.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, session } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(session.user);

  const login = useCallback(async (email, password) => {
    const { token, user } = await api("/auth/login", { method: "POST", body: { email, password } });
    session.save(token, user);
    setUser(user);
  }, []);

  const logout = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  // The API client fires this when a token expires (401).
  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener("stocksync:logout", onLogout);
    return () => window.removeEventListener("stocksync:logout", onLogout);
  }, []);

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export const can = {
  actOnStore: (u, storeId) => u.role === "admin" || u.store?.id === storeId,
  adjust: (u, storeId) => (u.role === "admin" || u.role === "manager") && can.actOnStore(u, storeId),
  dispatch: (u, t) => u.role === "admin" || (u.role === "manager" && u.store?.id === t.fromStoreId),
  receive: (u, t) => u.role === "admin" || u.store?.id === t.toStoreId,
  cancel: (u, t) =>
    u.role === "admin" || (u.role === "manager" && [t.fromStoreId, t.toStoreId].includes(u.store?.id)),
  viewSystem: (u) => u.role === "admin",
};
