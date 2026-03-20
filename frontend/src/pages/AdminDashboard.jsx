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
  const [stats, setStats] = useState({});
  const [users, setUsers] = useState([]);
  const [shops, setShops] = useState([]);
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [margin, setMargin] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [dashRes, usersRes, shopsRes, ordersRes] = await Promise.all([
        adminAPI.getDashboard().catch(() => ({ data: {} })),
        adminAPI.getUsers().catch(() => ({ data: [] })),
        adminAPI.getShops().catch(() => ({ data: [] })),
        adminAPI.getOrders().catch(() => ({ data: [] })),
      ]);
      setStats(dashRes.data);
      setUsers(usersRes.data.users || usersRes.data || []);
      setShops(shopsRes.data.shops || shopsRes.data || []);
      setOrders(ordersRes.data.orders || ordersRes.data || []);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleApproveShop = async (id) => {
    try {
      await adminAPI.approveShop(id);
      toast.success('Shop approved');
      fetchData();
    } catch { toast.error('Failed'); }
  };

  const handleBlockUser = async (id) => {
    try {
      await adminAPI.blockUser(id);
      toast.success('User updated');
      fetchData();
    } catch { toast.error('Failed'); }
  };

  const handleMargin = async () => {
    try {
      await adminAPI.updateMargin({ marginPercentage: Number(margin) });
      toast.success('Margin updated');
    } catch { toast.error('Failed'); }
  };

  const statCards = [
    { icon: Users, label: 'Total Users', value: stats.totalUsers || 0, color: 'text-info' },
    { icon: Store, label: 'Total Shops', value: stats.totalShops || 0, color: 'text-success' },
    { icon: Package, label: 'Total Orders', value: stats.totalOrders || 0, color: 'text-primary' },
    { icon: DollarSign, label: 'Revenue', value: `₹${stats.totalRevenue || 0}`, color: 'text-warning' },
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

        <div className="mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button key={t} onClick={() => setActiveTab(t)} className={`rounded-xl px-4 py-2 text-sm font-medium capitalize transition-all ${activeTab === t ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm' : 'bg-secondary text-secondary-foreground'}`}>
              {t}
            </button>
          ))}
        </div>

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
            <div className="glass-card p-5">
              <h3 className="font-heading font-semibold mb-4">Recent Orders</h3>
              <div className="space-y-3">
                {orders.slice(0, 5).map((o) => (
                  <div key={o._id} className="flex items-center justify-between rounded-lg bg-secondary/50 p-3 text-sm">
                    <span>#{o._id?.slice(-6)} - {o.userId?.name || 'User'}</span>
                    <span className="font-medium text-primary">₹{o.totalCost || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-secondary/50"><th className="px-4 py-3 text-left font-medium">Name</th><th className="px-4 py-3 text-left font-medium">Email</th><th className="px-4 py-3 text-left font-medium">Role</th><th className="px-4 py-3 text-left font-medium">Actions</th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u._id} className="border-b border-border/50">
                      <td className="px-4 py-3">{u.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{u.role}</span></td>
                      <td className="px-4 py-3"><Button variant="ghost" size="sm" onClick={() => handleBlockUser(u._id)} className="text-destructive">Block</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'shops' && (
          <div className="space-y-4">
            {shops.map((s) => (
              <div key={s._id} className="glass-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{s.address || 'No address'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.approved ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                    {s.approved ? 'Approved' : 'Pending'}
                  </span>
                  {!s.approved && (
                    <Button size="sm" className="sunrise-gradient text-primary-foreground" onClick={() => handleApproveShop(s._id)}>Approve</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'orders' && (
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-secondary/50"><th className="px-4 py-3 text-left font-medium">ID</th><th className="px-4 py-3 text-left font-medium">User</th><th className="px-4 py-3 text-left font-medium">Status</th><th className="px-4 py-3 text-left font-medium">Cost</th><th className="px-4 py-3 text-left font-medium">Date</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o._id} className="border-b border-border/50">
                      <td className="px-4 py-3 font-mono text-xs">#{o._id?.slice(-6)}</td>
                      <td className="px-4 py-3">{o.userId?.name || '-'}</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{o.status}</span></td>
                      <td className="px-4 py-3 font-medium">₹{o.totalCost || 0}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(o.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="glass-card p-6 max-w-md">
            <h3 className="font-heading text-xl font-semibold mb-4">Platform Settings</h3>
            <div className="space-y-4">
              <div>
                <Label>Margin Percentage (%)</Label>
                <Input type="number" min={0} max={100} value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="e.g. 10" className="mt-1.5" />
                <p className="text-xs text-muted-foreground mt-1">Added on top of shop prices</p>
              </div>
              <Button onClick={handleMargin} className="sunrise-gradient text-primary-foreground">Update Margin</Button>
            </div>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
};

export default AdminDashboard;
