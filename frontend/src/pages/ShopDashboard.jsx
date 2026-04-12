import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { shopAPI, orderAPI } from '@/lib/api';
import { onOrderUpdate, getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Printer, Clock, History, CheckCircle2, ChevronUp,
  Download, RefreshCw, XCircle, Settings, ToggleLeft,
  ToggleRight, DollarSign, X
} from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

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

const ShopDashboard = () => {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders]         = useState([]);
  const [activeTab, setActiveTab]   = useState('queue');
  const [loading, setLoading]       = useState(true);
  const [myShop, setMyShop]         = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // OTP verify
  const [expandedId, setExpandedId] = useState(null);
  const [otpValues, setOtpValues]   = useState({});
  const [verifying, setVerifying]   = useState(false);

  // Reject order modal
  const [rejectTarget, setRejectTarget]   = useState(null);
  const [rejectReason, setRejectReason]   = useState('');
  const [rejecting, setRejecting]         = useState(false);

  // Shop settings modal
  const [settingsOpen, setSettingsOpen]   = useState(false);
  const [toggling, setToggling]           = useState(false);
  const [pricing, setPricing]             = useState({ bw: { singleSided: '', doubleSided: '' }, color: { singleSided: '', doubleSided: '' } });
  const [savingPricing, setSavingPricing] = useState(false);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await shopAPI.getShopOrders();
      setOrders(res.data.data?.orders || res.data.orders || []);
    } catch {
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
      // Pre-fill pricing
      if (shop?.pricing) {
        setPricing({
          bw:    { singleSided: shop.pricing.bw?.singleSided    || '', doubleSided: shop.pricing.bw?.doubleSided    || '' },
          color: { singleSided: shop.pricing.color?.singleSided || '', doubleSided: shop.pricing.color?.doubleSided || '' },
        });
      }
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchShop(); fetchOrders(); }, [fetchShop, fetchOrders]);

  useEffect(() => {
    const cleanup = onOrderUpdate(() => fetchOrders(true));
    return cleanup;
  }, [fetchOrders]);

  useEffect(() => {
    const s = getSocket();
    const onNew = () => { toast.info('🔔 New order received!'); fetchOrders(true); };
    s.on('order:new', onNew);
    return () => s.off('order:new', onNew);
  }, [fetchOrders]);

  // ── Print job real-time alerts ────────────────────────────────────────────
  useEffect(() => {
    const s = getSocket();
    const onOutOfPaper = (data) => {
      toast.error(`🖨️ OUT OF PAPER — Order #${data.orderNumber}: ${data.printedPages}/${data.totalPages} pages done. Add paper then click Resume.`, { duration: 10000 });
      fetchOrders(true);
    };
    const onPrintError   = (data) => { toast.error(`🖨️ PRINTER ERROR — ${data.error}`, { duration: 8000 }); fetchOrders(true); };
    const onPrintComplete = (data) => { toast.success(`✅ Printing complete — Order #${data.orderNumber}`); fetchOrders(true); };
    s.on('print:out_of_paper', onOutOfPaper);
    s.on('print:error',        onPrintError);
    s.on('print:completed',    onPrintComplete);
    return () => {
      s.off('print:out_of_paper', onOutOfPaper);
      s.off('print:error',        onPrintError);
      s.off('print:completed',    onPrintComplete);
    };
  }, [fetchOrders]);

  // ── Resume Print Job ──────────────────────────────────────────────────────
  const handleResumePrint = async (orderId) => {
    try {
      await orderAPI.resumePrint(orderId);
      toast.success('▶️ Print job resumed!');
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to resume');
    }
  };

  // ── Desktop Print Trigger ──────────────────────────────────────────────────
  const handleDesktopPrint = async (orderId) => {
    try {
      await updateStatus(orderId, 'printing');
      window.location.href = `smartxerox://print/${orderId}`;
      toast.success('Opening Desktop Print Agent...');
    } catch (err) {
      toast.error('Failed to trigger desktop agent');
    }
  };

  // ── Accept / status update ─────────────────────────────────────────────────
  const updateStatus = async (orderId, status) => {
    try {
      if (status === 'accepted') await orderAPI.accept(orderId);
      else await orderAPI.updateStatus(orderId, status);
      toast.success(`Order marked as ${statusLabel[status]}`);
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update status');
    }
  };

  // ── Reject order ───────────────────────────────────────────────────────────
  const handleReject = async () => {
    if (!rejectReason.trim()) { toast.error('Please enter a reason'); return; }
    setRejecting(true);
    try {
      await orderAPI.reject(rejectTarget._id, rejectReason);
      toast.success('Order rejected — customer will be notified');
      setRejectTarget(null);
      setRejectReason('');
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to reject order');
    } finally {
      setRejecting(false);
    }
  };

  // ── Download ───────────────────────────────────────────────────────────────
  const handleDownload = async (orderId, docId) => {
    try {
      const res = await orderAPI.getDocumentUrl(orderId, docId);
      const url = res.data.data?.downloadUrl;
      if (url) { window.open(url, '_blank'); toast.success('PDF opened. Press Ctrl+P to print.'); }
      else toast.error('Could not get download link');
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to get document link'); }
  };

  // ── OTP verify ─────────────────────────────────────────────────────────────
  const handleVerifyOTP = async (orderId) => {
    const code = (otpValues[orderId] || '').trim();
    if (code.length !== 6) { toast.error('Enter the full 6-digit OTP'); return; }
    setVerifying(true);
    try {
      await orderAPI.verifyPickup({ orderId, pickupCode: code });
      toast.success('OTP verified! Order marked as collected ✅');
      setExpandedId(null);
      setOtpValues(prev => { const n = { ...prev }; delete n[orderId]; return n; });
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Invalid OTP. Please check again.');
    } finally {
      setVerifying(false);
    }
  };

  // ── Toggle shop open/close ─────────────────────────────────────────────────
  const handleToggleShop = async () => {
    setToggling(true);
    try {
      await shopAPI.toggleStatus();
      const newStatus = !myShop?.isOpen;
      setMyShop(prev => ({ ...prev, isOpen: newStatus }));
      toast.success(`Shop is now ${newStatus ? 'Open 🟢' : 'Closed 🔴'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to toggle shop status');
    } finally {
      setToggling(false);
    }
  };

  // ── Save pricing ───────────────────────────────────────────────────────────
  const handleSavePricing = async () => {
    setSavingPricing(true);
    try {
      await shopAPI.update({ pricing });
      setMyShop(prev => ({ ...prev, pricing }));
      toast.success('Pricing updated ✅');
      setSettingsOpen(false);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update pricing');
    } finally {
      setSavingPricing(false);
    }
  };

  // ── Tab filters ────────────────────────────────────────────────────────────
  const queueOrders   = orders.filter(o => o.status === 'paid');
  const activeOrders  = orders.filter(o => ['accepted', 'printing', 'ready'].includes(o.status));
  const historyOrders = orders.filter(o => ['picked_up', 'rejected', 'cancelled', 'expired'].includes(o.status));

  const tabs = [
    { key: 'queue',    label: 'Queue',    icon: <Clock className="h-4 w-4" />,    count: queueOrders.length   },
    { key: 'active',   label: 'Active',   icon: <Printer className="h-4 w-4" />,  count: activeOrders.length  },
    { key: 'history',  label: 'History',  icon: <History className="h-4 w-4" />,  count: historyOrders.length },
  ];

  const getTabOrders = () => {
    if (activeTab === 'queue')  return queueOrders;
    if (activeTab === 'active') return activeOrders;
    return historyOrders;
  };

  // ── Action buttons ─────────────────────────────────────────────────────────
  const ActionButton = ({ order }) => {
    if (order.status === 'paid') return (
      <div className="flex gap-2">
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" onClick={() => updateStatus(order._id, 'accepted')}>Accept</Button>
        <Button size="sm" variant="outline" className="text-destructive border-destructive" onClick={() => { setRejectTarget(order); setRejectReason(''); }}>
          <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
        </Button>
      </div>
    );
    if (order.status === 'accepted') return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white" onClick={() => handleDesktopPrint(order._id)}>
          <Printer className="h-3.5 w-3.5 mr-1" /> Start Printing (Desktop)
        </Button>
        <button 
          className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-primary"
          onClick={() => navigate(`/shop/print/${order._id}`)}
        >
          or use Web Print Interface
        </button>
      </div>
    );
    if (order.status === 'printing') return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2 text-sm text-purple-700 font-medium">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          <span>Printing{order.printJob?.printedPages > 0 ? ` (${order.printJob.printedPages}/${order.printJob.totalPages} pages)` : '...'}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] text-muted-foreground">Auto-ready + OTP when done</span>
          <button 
            className="text-[10px] text-primary underline underline-offset-2 hover:opacity-75 mt-1"
            onClick={() => updateStatus(order._id, 'ready')}
          >
            Mark Ready manually
          </button>
        </div>

        {/* Print job paused — show resume button */}
        {order.printJob?.status === 'paused' && (
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white mt-1" onClick={() => handleResumePrint(order._id)}>
            ▶ Resume Print
          </Button>
        )}
      </div>
    );
    if (order.status === 'ready') return (
      <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white" onClick={() => setExpandedId(expandedId === order._id ? null : order._id)}>
        {expandedId === order._id ? <><ChevronUp className="h-3 w-3 mr-1" />Close</> : <><CheckCircle2 className="h-3 w-3 mr-1" />Mark Done</>}
      </Button>
    );
    return null;
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-heading text-3xl font-bold">Shop Dashboard 🏪</h1>
            <div className="flex items-center gap-3 mt-1">
              <p className="text-muted-foreground">{myShop?.name || user?.name}</p>
              {myShop && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${myShop.isOpen ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {myShop.isOpen ? '🟢 Open' : '🔴 Closed'}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {/* Open/Close toggle */}
            <Button variant="outline" size="sm" onClick={handleToggleShop} disabled={toggling} className="gap-1.5">
              {myShop?.isOpen
                ? <><ToggleRight className="h-4 w-4 text-green-600" />Close Shop</>
                : <><ToggleLeft className="h-4 w-4 text-muted-foreground" />Open Shop</>}
            </Button>
            {/* Settings */}
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} className="gap-1.5">
              <Settings className="h-4 w-4" /> Pricing
            </Button>
            <Button variant="outline" size="sm" onClick={() => fetchOrders(false)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </div>

        {/* Auto-print banner */}
        <div className="mb-6 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <Printer className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              <strong>Desktop Print Agent</strong> — The fastest way to handle orders. Install the Windows app, connect it once, and let it auto-print and auto-verify every order instantly.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Download Button */}
            <a 
              href="https://github.com/your-username/smartxerox/releases/latest/download/Smart-Xerox-Print-Agent-Setup-1.0.0.exe" 
              className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-white border border-blue-200 hover:bg-blue-100 transition-colors"
            >
              <Download className="h-3 w-3" /> Download .exe
            </a>
            
            {/* Connect / Auto-login Button */}
            <a 
              href={`smartxerox://autologin?token=${token}&email=${encodeURIComponent(user?.email || '')}&name=${encodeURIComponent(user?.name || '')}&shopName=${encodeURIComponent(myShop?.name || '')}`}
              className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white shadow-sm hover:bg-blue-700 transition-colors"
              onClick={() => toast.success('Opening Print Agent...')}
            >
              <ToggleRight className="h-3 w-3" /> Connect Agent
            </a>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${activeTab === t.key ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm' : 'bg-secondary text-secondary-foreground'}`}>
              {t.icon} {t.label}
              {t.count > 0 && <span className="rounded-full bg-white/25 px-1.5 text-xs font-bold">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* Orders */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground">Loading orders...</div>
        ) : getTabOrders().length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {activeTab === 'queue' && 'No new orders waiting'}
            {activeTab === 'active' && 'No active orders right now'}
            {activeTab === 'history' && 'No completed orders yet'}
          </div>
        ) : (
          <div className="space-y-3">
            {getTabOrders().map((order, i) => (
              <motion.div key={order._id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="glass-card overflow-hidden">
                <div className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">#{order.orderNumber || order._id.slice(-6).toUpperCase()}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge[order.status] || ''}`}>{statusLabel[order.status] || order.status}</span>
                    </div>
                    <p className="text-sm font-medium">{order.user?.name || 'Customer'}{order.user?.phone ? ` · ${order.user.phone}` : ''}</p>
                    {order.documents?.[0] && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {order.documents[0].originalName || order.documents[0].fileName || 'Document'} &bull;{' '}
                        {order.documents[0].printingOptions?.copies || order.documents[0].copies || 1} copies &bull;{' '}
                        {(order.documents[0].printingOptions?.colorMode || order.documents[0].colorType) === 'color' ? 'Color' : 'B&W'} &bull;{' '}
                        {order.documents[0].printingOptions?.paperSize || order.documents[0].paperSize}
                        {(order.documents[0].printingOptions?.sides || order.documents[0].sides) === 'double' ? ' · Double-sided' : ''}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">{new Date(order.createdAt).toLocaleString('en-IN')}</p>

                    {order.status === 'ready' && order.pickup?.pickupCode && (
                      <div className="mt-3 inline-flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-2.5">
                        <div>
                          <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-0.5">Customer OTP</p>
                          <p className="font-mono text-2xl font-bold text-green-800 tracking-[0.3em]">{order.pickup.pickupCode}</p>
                        </div>
                        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                      </div>
                    )}

                    {['accepted', 'printing', 'ready'].includes(order.status) && order.documents?.[0] && (
                      <button className="mt-2 text-xs text-primary underline underline-offset-2 hover:opacity-75 flex items-center gap-1"
                        onClick={() => navigate(`/shop/print/${order._id}`)}>
                        <Printer className="h-3 w-3" /> Open Web Print Interface
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {order.pricing?.total != null && (
                      <span className="font-heading font-bold text-primary text-lg">₹{order.pricing.total}</span>
                    )}
                    <ActionButton order={order} />
                  </div>
                </div>

                {/* OTP verify panel */}
                <AnimatePresence>
                  {expandedId === order._id && order.status === 'ready' && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                      <div className="border-t border-border bg-orange-50/60 px-5 py-4">
                        <p className="text-sm font-semibold text-orange-900 mb-3">Ask the customer to show their OTP. Type it below to confirm pickup.</p>
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <Label className="text-xs font-semibold">Enter customer OTP</Label>
                            <Input className="mt-1 w-44 text-center font-mono font-bold text-xl tracking-[0.3em]" placeholder="_ _ _ _ _ _" maxLength={6}
                              value={otpValues[order._id] || ''}
                              onChange={(e) => setOtpValues(prev => ({ ...prev, [order._id]: e.target.value.replace(/\D/g, '') }))} />
                          </div>
                          <Button className="bg-green-600 hover:bg-green-700 text-white" disabled={verifying || (otpValues[order._id] || '').length !== 6} onClick={() => handleVerifyOTP(order._id)}>
                            {verifying ? 'Verifying...' : 'Confirm & Mark Done'}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => { setExpandedId(null); setOtpValues(prev => { const n = { ...prev }; delete n[order._id]; return n; }); }}>Cancel</Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        )}

        {/* ── Reject Modal ── */}
        {rejectTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setRejectTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-heading font-semibold text-destructive flex items-center gap-2"><XCircle className="h-5 w-5" /> Reject Order</h3>
                <button onClick={() => setRejectTarget(null)}><X className="h-4 w-4" /></button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">Order <strong>#{rejectTarget._id.slice(-6).toUpperCase()}</strong> — {rejectTarget.user?.name}</p>
              <div>
                <Label>Reason for rejection (required)</Label>
                <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  placeholder="e.g. File corrupted, unable to print requested size..."
                  className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm min-h-[80px]" />
                <p className="text-xs text-muted-foreground mt-1">Customer will receive this reason via notification.</p>
              </div>
              <div className="flex gap-2 mt-4">
                <Button className="flex-1 bg-destructive text-destructive-foreground" disabled={rejecting} onClick={handleReject}>
                  {rejecting ? 'Rejecting...' : 'Confirm Reject'}
                </Button>
                <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
              </div>
            </motion.div>
          </div>
        )}

        {/* ── Settings / Pricing Modal ── */}
        {settingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setSettingsOpen(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-6 max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-heading font-semibold flex items-center gap-2"><DollarSign className="h-5 w-5 text-primary" /> Update Pricing</h3>
                <button onClick={() => setSettingsOpen(false)}><X className="h-4 w-4" /></button>
              </div>

              <div className="space-y-5">
                {/* Open/Close toggle inside modal too */}
                <div className="flex items-center justify-between rounded-xl bg-secondary p-4">
                  <div>
                    <p className="font-medium text-sm">Shop Status</p>
                    <p className="text-xs text-muted-foreground">Toggle if your shop is open for orders</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleToggleShop} disabled={toggling}>
                    {myShop?.isOpen ? '🟢 Open' : '🔴 Closed'}
                  </Button>
                </div>

                {/* B&W pricing */}
                <div>
                  <p className="font-medium text-sm mb-2">Black & White (₹ per page)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Single-sided</Label>
                      <Input type="number" min={0} step={0.5} value={pricing.bw.singleSided} onChange={e => setPricing(p => ({ ...p, bw: { ...p.bw, singleSided: e.target.value } }))} className="mt-1" placeholder="e.g. 1" />
                    </div>
                    <div>
                      <Label className="text-xs">Double-sided</Label>
                      <Input type="number" min={0} step={0.5} value={pricing.bw.doubleSided} onChange={e => setPricing(p => ({ ...p, bw: { ...p.bw, doubleSided: e.target.value } }))} className="mt-1" placeholder="e.g. 1.5" />
                    </div>
                  </div>
                </div>

                {/* Color pricing */}
                <div>
                  <p className="font-medium text-sm mb-2">Color (₹ per page)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Single-sided</Label>
                      <Input type="number" min={0} step={0.5} value={pricing.color.singleSided} onChange={e => setPricing(p => ({ ...p, color: { ...p.color, singleSided: e.target.value } }))} className="mt-1" placeholder="e.g. 5" />
                    </div>
                    <div>
                      <Label className="text-xs">Double-sided</Label>
                      <Input type="number" min={0} step={0.5} value={pricing.color.doubleSided} onChange={e => setPricing(p => ({ ...p, color: { ...p.color, doubleSided: e.target.value } }))} className="mt-1" placeholder="e.g. 8" />
                    </div>
                  </div>
                </div>

                <Button onClick={handleSavePricing} disabled={savingPricing} className="w-full sunrise-gradient text-primary-foreground">
                  {savingPricing ? 'Saving...' : 'Save Pricing'}
                </Button>
              </div>
            </motion.div>
          </div>
        )}

      </div>
      <Footer />
    </div>
  );
};

export default ShopDashboard;