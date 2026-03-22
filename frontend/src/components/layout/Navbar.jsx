import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { notificationAPI } from '@/lib/api';
import { onNotification } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Menu, X, Printer, User, LogOut, LayoutDashboard, Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const Navbar = () => {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen]         = useState(false);
  const [notifOpen, setNotifOpen]           = useState(false);
  const [notifications, setNotifications]   = useState([]);
  const [unreadCount, setUnreadCount]       = useState(0);
  const notifRef = useRef(null);

  const getDashboardPath = () => {
    if (user?.role === 'admin')      return '/admin';
    if (user?.role === 'shopkeeper') return '/shop';   // FIX: was 'shop' not 'shopkeeper'
    return '/dashboard';
  };

  // Fetch notifications when logged in
  useEffect(() => {
    if (!isAuthenticated) return;
    notificationAPI.getAll()
      .then(res => {
        const notifs = res.data?.data?.notifications || res.data?.notifications || [];
        setNotifications(notifs);
        setUnreadCount(notifs.filter(n => !n.isRead).length);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  // Real-time new notifications
  useEffect(() => {
    if (!isAuthenticated) return;
    const cleanup = onNotification((notif) => {
      setNotifications(prev => [notif, ...prev]);
      setUnreadCount(prev => prev + 1);
    });
    return cleanup;
  }, [isAuthenticated]);

  // Close notif dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await notificationAPI.markAllRead();
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch { /* silent */ }
  };

  const handleDeleteNotif = async (id, e) => {
    e.stopPropagation();
    try {
      await notificationAPI.delete(id);
      setNotifications(prev => prev.filter(n => n._id !== id));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch { /* silent */ }
  };

  const handleLogout = () => { logout(); navigate('/'); };

  return (
    <nav className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl sunrise-gradient">
            <Printer className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-heading text-xl font-bold">Smart Xerox</span>
        </Link>

        {/* Desktop */}
        <div className="hidden items-center gap-6 md:flex">
          <Link to="/" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Home</Link>
          <Link to="/services" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Services</Link>
          {isAuthenticated ? (
            <>
              <Link to={getDashboardPath()} className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Dashboard</Link>
              {user?.role === 'user' && (
                <Link to="/orders" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Orders</Link>
              )}

              {/* Notifications Bell */}
              <div className="relative" ref={notifRef}>
                <button onClick={() => { setNotifOpen(!notifOpen); if (!notifOpen && unreadCount > 0) handleMarkAllRead(); }}
                  className="relative flex h-9 w-9 items-center justify-center rounded-xl hover:bg-secondary transition-colors">
                  <Bell className="h-4 w-4 text-muted-foreground" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>

                {/* Notifications dropdown */}
                <AnimatePresence>
                  {notifOpen && (
                    <motion.div initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.95 }}
                      className="absolute right-0 top-11 w-80 rounded-xl border border-border bg-background shadow-xl z-50 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                        <p className="font-semibold text-sm">Notifications</p>
                        {unreadCount > 0 && (
                          <button onClick={handleMarkAllRead} className="text-xs text-primary hover:underline">Mark all read</button>
                        )}
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        {notifications.length === 0 ? (
                          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications yet</div>
                        ) : notifications.slice(0, 20).map((n) => (
                          <div key={n._id} className={`flex items-start gap-3 px-4 py-3 border-b border-border/50 hover:bg-secondary/30 transition-colors ${!n.isRead ? 'bg-primary/5' : ''}`}>
                            <div className="flex-1 min-w-0">
                              <p className={`text-xs font-medium leading-snug ${!n.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>{n.title}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.message}</p>
                              <p className="text-[10px] text-muted-foreground mt-1">{new Date(n.createdAt).toLocaleString('en-IN')}</p>
                            </div>
                            <button onClick={(e) => handleDeleteNotif(n._id, e)} className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0">
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5">
                  <User className="h-4 w-4 text-secondary-foreground" />
                  <span className="text-sm font-medium text-secondary-foreground">{user?.name}</span>
                </div>
                <Button variant="ghost" size="icon" onClick={handleLogout}>
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Button variant="ghost" onClick={() => navigate('/login')}>Sign In</Button>
              <Button className="sunrise-gradient text-primary-foreground sunrise-shadow-sm" onClick={() => navigate('/register')}>Get Started</Button>
            </div>
          )}
        </div>

        {/* Mobile toggle */}
        <button className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-border/50 bg-background md:hidden">
            <div className="flex flex-col gap-2 p-4">
              <Link to="/" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-secondary">Home</Link>
              <Link to="/services" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-secondary">Services</Link>
              {isAuthenticated ? (
                <>
                  <Link to={getDashboardPath()} onClick={() => setMobileOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-secondary">
                    <LayoutDashboard className="h-4 w-4" /> Dashboard
                  </Link>
                  {user?.role === 'user' && (
                    <Link to="/orders" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-secondary">Orders</Link>
                  )}
                  <div className="flex items-center justify-between rounded-lg px-3 py-2">
                    <span className="text-sm font-medium">Notifications</span>
                    {unreadCount > 0 && <span className="rounded-full bg-destructive text-white text-xs px-1.5 py-0.5">{unreadCount}</span>}
                  </div>
                  <button onClick={() => { handleLogout(); setMobileOpen(false); }} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10">
                    <LogOut className="h-4 w-4" /> Logout
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-secondary">Sign In</Link>
                  <Link to="/register" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2 text-sm font-medium sunrise-gradient text-primary-foreground text-center">Get Started</Link>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
};

export default Navbar;