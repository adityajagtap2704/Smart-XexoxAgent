import { useState, useEffect, useCallback } from 'react';
import { adminAPI } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { Users, Store, Package, DollarSign } from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

const AdminDashboard = () => {
  const [stats, setStats]       = useState({});
  const [recentOrders, setRecentOrders] = useState([]);
  const [users, setUsers]       = useState([]);
  const [shops, setShops]       = useState([]);
  const [orders, setOrders]     = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [margin, setMargin]     = useState('');
  const [selectedShopId, setSelectedShopId] = useState('');
  const [loading, setLoading]   = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [dashRes, usersRes, shopsRes, ordersRes] = await Promise.all([
        adminAPI.getDashboard().catch(() => ({ data: {} })),
        adminAPI.getUsers().catch(() => ({ data: {} })),
        adminAPI.getShops().catch(() => ({ data: {} })),
        adminAPI.getOrders().catch(() => ({ data: {} })),
      ]);

      // Dashboard — backend returns: { data: { stats, recentOrders } }
      const dashData = dashRes.data?.data || dashRes.data || {};
      setStats(dashData.stats || {});
      setRecentOrders(Array.isArray(dashData.recentOrders) ? dashData.recentOrders : []);

      // Users — backend returns: { data: { users, pagination } }
      const usersData = usersRes.data?.data || usersRes.data || {};
      setUsers(Array.isArray(usersData.users) ? usersData.users : []);

      // Shops — backend returns: { data: { shops, pagination } }
      const shopsData = shopsRes.data?.data || shopsRes.data || {};
      setShops(Array.isArray(shopsData.shops) ? shopsData.shops : []);

      // Orders — backend returns: { data: { orders, pagination } }
      const ordersData = ordersRes.data?.data || ordersRes.data || {};
      setOrders(Array.isArray(ordersData.orders) ? ordersData.orders : []);

    } catch (err) {
      console.error('Admin fetch error:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Approve / verify shop — backend uses verifyShop(id, data)
  const handleApproveShop = async (id) => {
    try {
      await adminAPI.verifyShop(id, { isVerified: true, isActive: true });
      toast.success('Shop approved');
      fetchData();
    } catch { toast.error('Failed to approve shop'); }
  };

  // Toggle user active status — backend uses toggleUser(id)
  const handleBlockUser = async (id) => {
    try {
      await adminAPI.toggleUser(id);
      toast.success('User status updated');
      fetchData();
    } catch { toast.error('Failed to update user'); }
  };

  // Update platform margin — backend uses setMargin(shopId, data)
  const handleMargin = async () => {
    if (!selectedShopId) {
      toast.error('Please select a shop first');
      return;
    }
    try {
      await adminAPI.setMargin(selectedShopId, { marginPercentage: Number(margin) });
      toast.success('Margin updated');
    } catch { toast.error('Failed to update margin'); }
  };

  const statCards = [
    { icon: Users,       label: 'Total Users',   value: stats.totalUsers   || 0,   color: 'text-blue-500'   },
    { icon: Store,       label: 'Total Shops',   value: stats.totalShops   || 0,   color: 'text-green-500'  },
    { icon: Package,     label: 'Total Orders',  value: stats.totalOrders  || 0,   color: 'text-primary'    },
    { icon: DollarSign,  label: 'Revenue (MTD)', value: `₹${stats.monthPlatformRevenue || 0}`, color: 'text-orange-500' },
  ];

  const tabs = ['overview', 'users', 'shops', 'orders', 'settings'];

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="font-heading text-3xl font-bold">Admin Panel 🔐</h1>
          <p className="text-muted-foreground">Platform management &amp; analytics</p>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`rounded-xl px-4 py-2 text-sm font-medium capitalize transition-all ${activeTab === t ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm' : 'bg-secondary text-secondary-foreground'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* ── Overview ── */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {statCards.map((s, i) => (
                <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }} className="glass-card p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
                      <s.icon className={`h-5 w-5 ${s.color}`} />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                      <p className="font-heading text-xl font-bold">{s.value}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Recent Orders */}
            <div className="glass-card p-5">
              <h3 className="font-heading font-semibold mb-4">Recent Orders</h3>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No orders yet</p>
              ) : (
                <div className="space-y-3">
                  {recentOrders.slice(0, 5).map((o) => (
                    <div key={o._id} className="flex items-center justify-between rounded-lg bg-secondary/50 p-3 text-sm">
                      <span className="font-mono text-xs">#{o._id?.slice(-6).toUpperCase()} — {o.user?.name || 'User'}</span>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{o.status}</span>
                        <span className="font-medium text-primary">₹{o.pricing?.total || 0}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Extra stats */}
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { label: 'Active Orders',       value: stats.activeOrders       || 0 },
                { label: "Today's Orders",      value: stats.todayOrders        || 0 },
                { label: 'Pending Verification',value: stats.pendingVerification|| 0 },
              ].map((s) => (
                <div key={s.label} className="glass-card p-4 text-center">
                  <p className="text-2xl font-heading font-bold text-primary">{s.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Users ── */}
        {activeTab === 'users' && (
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="px-4 py-3 text-left font-medium">Name</th>
                    <th className="px-4 py-3 text-left font-medium">Email</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No users found</td></tr>
                  ) : (
                    users.map((u) => (
                      <tr key={u._id} className="border-b border-border/50">
                        <td className="px-4 py-3 font-medium">{u.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs capitalize">{u.role}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {u.isActive ? 'Active' : 'Blocked'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Button variant="ghost" size="sm" onClick={() => handleBlockUser(u._id)}
                            className={u.isActive ? 'text-destructive' : 'text-green-600'}>
                            {u.isActive ? 'Block' : 'Unblock'}
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Shops ── */}
        {activeTab === 'shops' && (
          <div className="space-y-4">
            {shops.length === 0 ? (
              <div className="glass-card p-8 text-center text-muted-foreground">No shops found</div>
            ) : (
              shops.map((s) => (
                <div key={s._id} className="glass-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.address?.street ? `${s.address.street}, ${s.address.city}` : 'No address'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{s.phone} · {s.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.isVerified ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                      {s.isVerified ? 'Verified' : 'Pending'}
                    </span>
                    {!s.isVerified && (
                      <Button size="sm" className="sunrise-gradient text-primary-foreground" onClick={() => handleApproveShop(s._id)}>
                        Approve
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── Orders ── */}
        {activeTab === 'orders' && (
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="px-4 py-3 text-left font-medium">ID</th>
                    <th className="px-4 py-3 text-left font-medium">User</th>
                    <th className="px-4 py-3 text-left font-medium">Shop</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Total</th>
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No orders found</td></tr>
                  ) : (
                    orders.map((o) => (
                      <tr key={o._id} className="border-b border-border/50">
                        <td className="px-4 py-3 font-mono text-xs">#{o._id?.slice(-6).toUpperCase()}</td>
                        <td className="px-4 py-3">{o.user?.name || '-'}</td>
                        <td className="px-4 py-3">{o.shop?.name || '-'}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs capitalize">{o.status}</span>
                        </td>
                        <td className="px-4 py-3 font-medium">₹{o.pricing?.total || 0}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {new Date(o.createdAt).toLocaleDateString('en-IN')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Settings ── */}
        {activeTab === 'settings' && (
          <div className="glass-card p-6 max-w-md">
            <h3 className="font-heading text-xl font-semibold mb-4">Platform Settings</h3>
            <div className="space-y-4">
              <div>
                <Label>Select Shop</Label>
                <select
                  value={selectedShopId}
                  onChange={(e) => setSelectedShopId(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Choose a shop...</option>
                  {shops.map((s) => (
                    <option key={s._id} value={s._id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Margin Percentage (%)</Label>
                <Input
                  type="number" min={0} max={100}
                  value={margin}
                  onChange={(e) => setMargin(e.target.value)}
                  placeholder="e.g. 10"
                  className="mt-1.5"
                />
                <p className="text-xs text-muted-foreground mt-1">Added on top of shop prices</p>
              </div>
              <Button onClick={handleMargin} className="sunrise-gradient text-primary-foreground">
                Update Margin
              </Button>
            </div>
          </div>
        )}

      </div>
      <Footer />
    </div>
  );
};

export default AdminDashboard;