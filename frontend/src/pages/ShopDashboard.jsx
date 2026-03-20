import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { shopAPI, orderAPI } from '@/lib/api';
import { onOrderUpdate, getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Printer, Clock, History, CheckCircle2, ChevronUp, Download, RefreshCw } from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

// ─── Status config ────────────────────────────────────────────────────────────
const statusBadge = {
  paid:      'bg-blue-100 text-blue-800 border border-blue-200',
  accepted:  'bg-indigo-100 text-indigo-800 border border-indigo-200',
  printing:  'bg-purple-100 text-purple-800 border border-purple-200',
  ready:     'bg-green-100 text-green-800 border border-green-200',
  picked_up: 'bg-gray-100 text-gray-600 border border-gray-200',
  rejected:  'bg-red-100 text-red-800 border border-red-200',
  cancelled: 'bg-red-50 text-red-600 border border-red-100',
  expired:   'bg-orange-100 text-orange-700 border border-orange-200',
};

const statusLabel = {
  paid:      'Queued',
  accepted:  'Accepted',
  printing:  'Printing',
  ready:     'Ready for Pickup',
  picked_up: 'Collected',
  rejected:  'Rejected',
  cancelled: 'Cancelled',
  expired:   'Expired',
};

// ─── Component ────────────────────────────────────────────────────────────────
const ShopDashboard = () => {
  const { user } = useAuth();
  const [orders, setOrders]         = useState([]);
  const [activeTab, setActiveTab]   = useState('queue');
  const [loading, setLoading]       = useState(true);
  const [myShop, setMyShop]         = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // OTP verify state
  const [expandedId, setExpandedId]   = useState(null);
  const [otpValues, setOtpValues]     = useState({});
  const [verifying, setVerifying]     = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await shopAPI.getShopOrders();
      setOrders(res.data.data?.orders || res.data.orders || []);
    } catch (err) {
      if (!silent) toast.error('Could not load orders. Check your connection.');
    } finally {
      if (!silent) setRefreshing(false);
      setLoading(false);
    }
  }, []);

  const fetchShop = useCallback(async () => {
    try {
      const res = await shopAPI.getMyShop();
      const shop = res.data.data?.shop || res.data.shop || res.data;
      setMyShop(shop);
      if (shop?._id) getSocket().emit('join:shop', shop._id);
    } catch {
      // non-critical — dashboard still works without shop name
    }
  }, []);

  useEffect(() => {
    fetchShop();
    fetchOrders();
  }, [fetchShop, fetchOrders]);

  // ── Real-time updates ──────────────────────────────────────────────────────
  useEffect(() => {
    const cleanup = onOrderUpdate(() => fetchOrders(true));
    return cleanup;
  }, [fetchOrders]);

  useEffect(() => {
    const s = getSocket();
    const onNew = () => {
      toast.info('New order received!');
      fetchOrders(true);
    };
    s.on('order:new', onNew);
    return () => s.off('order:new', onNew);
  }, [fetchOrders]);

  // ── Status update (Accept / Start Printing / Mark Ready) ──────────────────
  const updateStatus = async (orderId, status) => {
    try {
      if (status === 'accepted') {
        await orderAPI.accept(orderId);
        toast.success('Order accepted! Print agent will print automatically.');
      } else {
        await orderAPI.updateStatus(orderId, status);
        toast.success(`Order marked as ${statusLabel[status]}`);
      }
      fetchOrders(true);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to update status';
      toast.error(msg);
    }
  };

  // ── Manual download (fallback if print agent not running) ─────────────────
  const handleDownload = async (orderId, docId) => {
    try {
      const res = await orderAPI.getDocumentUrl(orderId, docId);
      const url = res.data.data?.downloadUrl;
      if (url) {
        window.open(url, '_blank');
        toast.success('PDF opened. Press Ctrl+P to print.');
      } else {
        toast.error('Could not get download link');
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to get document link');
    }
  };

  // ── OTP verify (Mark Done after customer arrives) ─────────────────────────
  const handleVerifyOTP = async (orderId) => {
    const code = (otpValues[orderId] || '').trim();
    if (code.length !== 6) {
      toast.error('Please enter the full 6-digit OTP');
      return;
    }
    setVerifying(true);
    try {
      await orderAPI.verifyPickup({ orderId, pickupCode: code });
      toast.success('OTP verified! Order marked as collected.');
      setExpandedId(null);
      setOtpValues(prev => { const n = { ...prev }; delete n[orderId]; return n; });
      fetchOrders(true);
    } catch (err) {
      const msg = err.response?.data?.message || 'Invalid OTP. Please check again.';
      toast.error(msg);
    } finally {
      setVerifying(false);
    }
  };

  // ── Tab filter ─────────────────────────────────────────────────────────────
  const queueOrders   = orders.filter(o => o.status === 'paid');
  const activeOrders  = orders.filter(o => ['accepted', 'printing', 'ready'].includes(o.status));
  const historyOrders = orders.filter(o => ['picked_up', 'rejected', 'cancelled', 'expired'].includes(o.status));

  const tabs = [
    { key: 'queue',   label: 'Queue',   icon: <Clock className="h-4 w-4" />,   count: queueOrders.length },
    { key: 'active',  label: 'Active',  icon: <Printer className="h-4 w-4" />, count: activeOrders.length },
    { key: 'history', label: 'History', icon: <History className="h-4 w-4" />, count: historyOrders.length },
  ];

  const getTabOrders = () => {
    if (activeTab === 'queue')  return queueOrders;
    if (activeTab === 'active') return activeOrders;
    return historyOrders;
  };

  // ── Action buttons per order status ───────────────────────────────────────
  const ActionButton = ({ order }) => {
    if (order.status === 'paid')
      return (
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white"
          onClick={() => updateStatus(order._id, 'accepted')}>
          Accept
        </Button>
      );

    if (order.status === 'accepted')
      return (
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white"
            onClick={() => updateStatus(order._id, 'printing')}>
            Start Printing
          </Button>
          <span className="text-[10px] text-muted-foreground">or wait for auto-print</span>
        </div>
      );

    if (order.status === 'printing')
      return (
        <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white"
          onClick={() => updateStatus(order._id, 'ready')}>
          Mark Ready
        </Button>
      );

    if (order.status === 'ready')
      return (
        <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white"
          onClick={() => setExpandedId(expandedId === order._id ? null : order._id)}>
          {expandedId === order._id
            ? <><ChevronUp className="h-3 w-3 mr-1" />Close</>
            : <><CheckCircle2 className="h-3 w-3 mr-1" />Mark Done</>}
        </Button>
      );

    return null;
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="font-heading text-3xl font-bold">Shop Dashboard 🏪</h1>
            <p className="text-muted-foreground mt-1">{myShop?.name || user?.name}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchOrders(false)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Print agent status banner */}
        <div className="mb-6 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
          <Printer className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            <strong>Auto-print active</strong> — when you click Accept, the print agent on this PC will
            automatically print the document. If the agent is not running, use the
            <strong> Download & Print</strong> link as fallback.
          </span>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all
                ${activeTab === t.key
                  ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}>
              {t.icon}
              {t.label}
              {t.count > 0 && (
                <span className="rounded-full bg-white/25 px-1.5 text-xs font-bold">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Order list */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground">Loading orders...</div>
        ) : getTabOrders().length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {activeTab === 'queue'   && 'No new orders waiting'}
            {activeTab === 'active'  && 'No active orders right now'}
            {activeTab === 'history' && 'No completed orders yet'}
          </div>
        ) : (
          <div className="space-y-3">
            {getTabOrders().map((order, i) => (
              <motion.div key={order._id}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="glass-card overflow-hidden">

                {/* Main row */}
                <div className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">

                    {/* Order number + status badge */}
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">
                        #{order.orderNumber || order._id.slice(-6).toUpperCase()}
                      </span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge[order.status] || ''}`}>
                        {statusLabel[order.status] || order.status}
                      </span>
                    </div>

                    {/* Customer info */}
                    <p className="text-sm font-medium">
                      {order.user?.name || 'Customer'}
                      {order.user?.phone ? ` · ${order.user.phone}` : ''}
                    </p>

                    {/* Document details */}
                    {order.documents?.[0] && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {order.documents[0].fileName || 'Document'} &bull;{' '}
                        {order.documents[0].copies} {order.documents[0].copies > 1 ? 'copies' : 'copy'} &bull;{' '}
                        {order.documents[0].colorType === 'color' ? 'Color' : 'B&W'} &bull;{' '}
                        {order.documents[0].paperSize}
                        {order.documents[0].doubleSided ? ' · Double-sided' : ''}
                      </p>
                    )}

                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(order.createdAt).toLocaleString('en-IN')}
                    </p>

                    {/* OTP shown when ready — shopkeeper sees this, customer shows same number */}
                    {order.status === 'ready' && order.pickup?.pickupCode && (
                      <div className="mt-3 inline-flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-2.5">
                        <div>
                          <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-0.5">
                            Customer OTP
                          </p>
                          <p className="font-mono text-2xl font-bold text-green-800 tracking-[0.3em]">
                            {order.pickup.pickupCode}
                          </p>
                        </div>
                        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                      </div>
                    )}

                    {/* Download fallback */}
                    {['accepted', 'printing', 'ready'].includes(order.status) && order.documents?.[0] && (
                      <button
                        className="mt-2 text-xs text-primary underline underline-offset-2 hover:opacity-75 flex items-center gap-1"
                        onClick={() => handleDownload(order._id, order.documents[0]._id)}>
                        <Download className="h-3 w-3" />
                        Download & Print manually (fallback)
                      </button>
                    )}
                  </div>

                  {/* Cost + action button */}
                  <div className="flex items-center gap-3 shrink-0">
                    {order.pricing?.total != null && (
                      <span className="font-heading font-bold text-primary text-lg">
                        ₹{order.pricing.total}
                      </span>
                    )}
                    <ActionButton order={order} />
                  </div>
                </div>

                {/* OTP verify panel — expands when shopkeeper clicks Mark Done */}
                <AnimatePresence>
                  {expandedId === order._id && order.status === 'ready' && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden">
                      <div className="border-t border-border bg-orange-50/60 px-5 py-4">
                        <p className="text-sm font-semibold text-orange-900 mb-3">
                          Ask the customer to show their OTP from the app or email.
                          Compare with the code above, then type it below to confirm.
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <Label className="text-xs font-semibold">Enter customer OTP</Label>
                            <Input
                              className="mt-1 w-44 text-center font-mono font-bold text-xl tracking-[0.3em]"
                              placeholder="_ _ _ _ _ _"
                              maxLength={6}
                              value={otpValues[order._id] || ''}
                              onChange={(e) => setOtpValues(prev => ({
                                ...prev,
                                [order._id]: e.target.value.replace(/\D/g, ''),
                              }))}
                            />
                          </div>
                          <Button
                            className="bg-green-600 hover:bg-green-700 text-white"
                            disabled={verifying || (otpValues[order._id] || '').length !== 6}
                            onClick={() => handleVerifyOTP(order._id)}>
                            {verifying ? 'Verifying...' : 'Confirm & Mark Done'}
                          </Button>
                          <Button variant="outline" size="sm"
                            onClick={() => {
                              setExpandedId(null);
                              setOtpValues(prev => { const n = { ...prev }; delete n[order._id]; return n; });
                            }}>
                            Cancel
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          OTP must match exactly. If customer lost OTP, ask them to check their email.
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

              </motion.div>
            ))}
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
};

export default ShopDashboard;
