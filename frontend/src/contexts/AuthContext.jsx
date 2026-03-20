import { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';

const AuthContext = createContext(undefined);

export const AuthProvider = ({ children }) => {
  const [user, setUser]   = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      // FIX: was /auth/profile (404) — correct endpoint is /auth/me
      authAPI.getMe()
        .then((res) => setUser(res.data.data?.user || res.data.user || res.data))
        .catch(() => { localStorage.removeItem('token'); setToken(null); })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [token]);

  const login = async (email, password) => {
    const res = await authAPI.login({ email, password });
    // FIX: backend wraps response in res.data.data — was reading res.data directly
    if (res.data.data?.requiresOTP || res.data.requiresOTP) return { requiresOTP: true };
    const { token: newToken, user: newUser } = res.data.data || res.data;
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
    return {};
  };

  const register = async (data) => {
    await authAPI.register(data);
  };

  const verifyOTP = async (email, otp) => {
    const res = await authAPI.verifyOTP({ email, otp });
    // FIX: same nested data fix
    const { token: newToken, user: newUser } = res.data.data || res.data;
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
    disconnectSocket();
  };

  return (
    <AuthContext.Provider value={{
      user, token, loading, login, register, verifyOTP, logout,
      isAuthenticated: !!user,
      isAdmin:      user?.role === 'admin',
      isShopkeeper: user?.role === 'shopkeeper',
      isUser:       user?.role === 'user',
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
