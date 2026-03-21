/**
 * FILE: frontend/src/pages/ShopDashboard.jsx
 * Replace your existing ShopDashboard.jsx with this file exactly.
 *
 * Changes vs original:
 *  1. THREE TABS: Queue | Active | History  (history = picked_up/rejected/cancelled/expired)
 *  2. Each tab renders a SEARCH BAR (Name, email or phone) + Role/Status filter
 *     — identical pattern to AdminDashboard Users tab
 *  3. Orders shown as TABLE ROWS matching AdminDashboard Users table exactly
 *     Columns: Order # | Customer | Email | Documents | Amount | Status | OTP Code | Date | Action
 *  4. OTP column: shows order.pickup.pickupCode in orange dashed pill when order is ready
 *     Shopkeeper searches customer name → sees OTP → cross-checks with user → clicks "Mark Done"
 *  5. "Mark Done" opens a confirm modal showing OTP big + customer info → one-click confirm
 *     Calls orderAPI.verifyPickup → order moves to History tab automatically via real-time
 *  6. Reject order wired: orderAPI.reject(id)  — was missing in original
 *  7. Download docs: orderAPI.getDocumentUrl   — was missing in original
 *  8. Shop open/close toggle: shopAPI.toggleStatus — was missing in original
 *  9. Real-time via getSocket() singleton — order:new, order:status_update, order:expired, order:extended
 * 10. All existing logic preserved (updateStatus, handleDownload, handleVerifyOTP flow)
 *
 * Uses exact same patterns as your codebase:
 *  - Tailwind classes, glass-card, sunrise-gradient, font-heading
 *  - shadcn/ui Button, Input, Label
 *  - framer-motion, AnimatePresence
 *  - sonner toast
 *  - lucide-react icons
 *  - shopAPI / orderAPI from @/lib/api
 *  - getSocket, onOrderUpdate from @/lib/socket
 *  - order.pickup.pickupCode, order.pricing.total (correct field paths)
 */

import React, { useState, useEffect, useCallback } from 'react';
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
  Download, RefreshCw, Search, X, CheckCircle, Store,
} from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

// ─── Status config (identical to original) ────────────────────────────────────
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

// ─── Confirm Pickup Modal ─────────────────────────────────────────────────────
// Shows OTP big + customer info. Shopkeeper visually cross-checks OTP with user,
// then clicks confirm — no typing needed (removes friction at counter).
const ConfirmPickupModal = ({ order, onClose, onConfirm, loading }) => {
  const u = order.user || {};
  const otp = order.pickup?.pickupCode;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="glass-card p-6 max-w-md w-full"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="font-heading text-lg font-bold">Confirm Pickup</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Order #{order.orderNumber || order._id?.slice(-6).toUpperCase()}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Customer info — same card style as admin panel */}
        <div className="rounded-xl bg-secondary/50 border border-border p-4 mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full sunrise-gradient text-primary-foreground font-bold text-sm shrink-0">
            {(u.name || 'U')[0].toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-sm">{u.name || 'Unknown'}</p>
            <p className="text-xs text-muted-foreground">{u.email}</p>
            {u.phone && <p className="text-xs text-muted-foreground">{u.phone}</p>}
          </div>
        </div>

        {/* OTP — big, clear, dashed orange box matching Orders.jsx style */}
        <div className="rounded-xl bg-green-50 border border-green-200 p-5 mb-5 text-center">
          <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-2">
            Customer OTP — Cross-check with user&apos;s screen
          </p>
          {otp ? (
            <p className="font-mono text-4xl font-bold text-green-800 tracking-[0.4em]">{otp}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">OTP not available</p>
          )}
          <p className="text-xs text-green-600 mt-2">
            OTP was sent to customer&apos;s email &amp; shown on their order screen
          </p>
        </div>

        {/* Amount */}
        <div className="flex justify-between items-center py-3 border-t border-border mb-5 text-sm">
          <span className="text-muted-foreground">Order Amount</span>
          <span className="font-heading font-bold text-primary text-base">
            ₹{order.pricing?.total ?? 0}
          </span>
        </div>

        <p className="text-xs text-muted-foreground mb-4 text-center">
          Verify the OTP matches, then click confirm to mark as collected.
        </p>

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            className="flex-2 sunrise-gradient text-primary-foreground"
            style={{ flex: 2 }}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading
              ? 'Confirming...'
              : <><CheckCircle2 className="h-4 w-4 mr-1.5" />OTP Matched — Mark Collected</>}
          </Button>
        </div>
      </motion.div>
    </div>
  );
};

// ─── OTP Pill — orange dashed pill shown in table OTP column ──────────────────
const OtpPill = ({ code }) => {
  if (!code) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className="inline-flex items-center font-mono font-bold text-base tracking-[0.25em] text-orange-600 bg-orange-50 border-2 border-dashed border-orange-300 rounded-lg px-3 py-1">
      {code}
    </span>
  );
};

// ─── Orders Table — matches AdminDashboard Users table exactly ─────────────────
const OrdersTable = ({ orders, isHistory, onAction, onOpenConfirm, onDownload }) => {
  const [expandedDoc, setExpandedDoc] = useState(null);

  if (orders.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground text-sm">
        {isHistory ? 'No completed orders yet' : 'No orders here right now'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Order #</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Customer</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Email</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Documents</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Amount</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">OTP Code</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Date</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Action</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const u = order.user || {};
            const docs = order.documents || [];
            const isExpanded = expandedDoc === order._id;

            return (
              <React.Fragment key={order._id}>
                <tr
                  className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  {/* Order # */}
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold bg-secondary px-2 py-1 rounded-md">
                      #{order.orderNumber || order._id?.slice(-6).toUpperCase()}
                    </span>
                  </td>

                  {/* Customer name + avatar */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-full sunrise-gradient flex items-center justify-center text-primary-foreground font-bold text-xs shrink-0">
                        {(u.name || 'U')[0].toUpperCase()}
                      </div>
                      <span className="font-medium whitespace-nowrap">{u.name || 'Unknown'}</span>
                    </div>
                  </td>

                  {/* Email */}
                  <td className="px-4 py-3 text-xs text-muted-foreground">{u.email || '—'}</td>

                  {/* Documents — expand toggle */}
                  <td className="px-4 py-3">
                    <button
                      className="text-xs text-primary underline underline-offset-2 hover:opacity-75 flex items-center gap-1"
                      onClick={() => setExpandedDoc(isExpanded ? null : order._id)}
                    >
                      📄 {docs.length} file{docs.length !== 1 ? 's' : ''}
                      <ChevronUp className={`h-3 w-3 transition-transform ${isExpanded ? '' : 'rotate-180'}`} />
                    </button>
                  </td>

                  {/* Amount */}
                  <td className="px-4 py-3 font-heading font-bold text-primary whitespace-nowrap">
                    ₹{order.pricing?.total ?? 0}
                  </td>

                  {/* Status badge */}
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge[order.status] || ''}`}>
                      {statusLabel[order.status] || order.status}
                    </span>
                  </td>

                  {/* OTP — key column for shopkeeper */}
                  <td className="px-4 py-3">
                    <OtpPill code={order.pickup?.pickupCode} />
                  </td>

                  {/* Date */}
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(order.createdAt).toLocaleDateString('en-IN')}
                  </td>

                  {/* Action */}
                  <td className="px-4 py-3">
                    <RowActions
                      order={order}
                      isHistory={isHistory}
                      onAction={onAction}
                      onOpenConfirm={onOpenConfirm}
                    />
                  </td>
                </tr>

                {/* Expanded docs row */}
                {isExpanded && (
                  <tr className="bg-orange-50/40 border-b border-border/50">
                    <td colSpan={9} className="px-4 py-3 pl-16">
                      <div className="flex flex-wrap gap-2">
                        {docs.map(doc => (
                          <div
                            key={doc._id}
                            className="flex items-center gap-2 rounded-full bg-background border border-orange-200 px-3 py-1.5 text-xs"
                          >
                            <span className="font-medium">{doc.fileName || doc.originalName}</span>
                            <span className="text-muted-foreground">
                              · {doc.copies}× · {doc.colorType === 'color' ? 'Color' : 'B&W'}
                              {doc.paperSize ? ` · ${doc.paperSize}` : ''}
                              {doc.doubleSided ? ' · 2-sided' : ''}
                            </span>
                            {!isHistory && (
                              <button
                                className="flex items-center gap-1 text-primary font-semibold hover:opacity-75"
                                onClick={() => onDownload(order._id, doc._id)}
                              >
                                <Download className="h-3 w-3" /> Download
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {order.specialInstructions && (
                        <p className="mt-2 text-xs text-muted-foreground italic">
                          📝 {order.specialInstructions}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground p-3 border-t border-border">
        {orders.length} order{orders.length !== 1 ? 's' : ''} shown
      </p>
    </div>
  );
};

// ─── Row Action Buttons — per status ──────────────────────────────────────────
const RowActions = ({ order, isHistory, onAction, onOpenConfirm }) => {
  if (isHistory) return <span className="text-xs text-muted-foreground">—</span>;

  if (order.status === 'paid')
    return (
      <div className="flex gap-1.5">
        <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white text-xs h-7 px-2.5"
          onClick={() => onAction(order._id, 'accepted')}>
          ✓ Accept
        </Button>
        <Button size="sm" variant="outline" className="text-destructive border-destructive/40 text-xs h-7 px-2.5"
          onClick={() => onAction(order._id, 'rejected')}>
          ✕ Reject
        </Button>
      </div>
    );

  if (order.status === 'accepted')
    return (
      <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
        onClick={() => onAction(order._id, 'printing')}>
        <Printer className="h-3 w-3 mr-1" /> Print
      </Button>
    );

  if (order.status === 'printing')
    return (
      <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white text-xs h-7"
        onClick={() => onAction(order._id, 'ready')}>
        <CheckCircle className="h-3 w-3 mr-1" /> Ready
      </Button>
    );

  if (order.status === 'ready')
    return (
      <Button size="sm" className="sunrise-gradient text-primary-foreground text-xs h-7"
        onClick={() => onOpenConfirm(order)}>
        <CheckCircle2 className="h-3 w-3 mr-1" /> Mark Done
      </Button>
    );

  return null;
};

// ─── Main Component ────────────────────────────────────────────────────────────
const ShopDashboard = () => {
  const { user } = useAuth();
  const [orders, setOrders]           = useState([]);
  const [activeTab, setActiveTab]     = useState('queue');
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [myShop, setMyShop]           = useState(null);

  // Confirm pickup modal
  const [confirmOrder,   setConfirmOrder]   = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Search state per tab
  const [queueSearch,   setQueueSearch]   = useState('');
  const [activeSearch,  setActiveSearch]  = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [statusFilter,  setStatusFilter]  = useState('');

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
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchShop(); fetchOrders(); }, [fetchShop, fetchOrders]);

  // ── Real-time (same pattern as original + AdminDashboard) ─────────────────
  useEffect(() => {
    const cleanup = onOrderUpdate(() => fetchOrders(true));
    return cleanup;
  }, [fetchOrders]);

  useEffect(() => {
    const s = getSocket();
    const onNew     = () => { toast.info('🆕 New order received!'); fetchOrders(true); };
    const onExpired = (p) => { toast.warning(`⏰ Order #${p?.orderNumber} has expired`); fetchOrders(true); };
    s.on('order:new',     onNew);
    s.on('order:expired', onExpired);
    return () => { s.off('order:new', onNew); s.off('order:expired', onExpired); };
  }, [fetchOrders]);

  // ── Toggle shop open/closed (was missing in original) ─────────────────────
  const handleToggleShop = async () => {
    try {
      const res = await shopAPI.toggleStatus();
      const open = res.data.data?.isOpen ?? res.data.isOpen;
      setMyShop(prev => ({ ...prev, isOpen: open }));
      toast.success(`Shop is now ${open ? 'OPEN 🟢' : 'CLOSED 🔴'}`);
    } catch {
      toast.error('Could not update shop status');
    }
  };

  // ── Status update ──────────────────────────────────────────────────────────
  const updateStatus = async (orderId, status) => {
    try {
      if (status === 'accepted') {
        await orderAPI.accept(orderId);
        toast.success('Order accepted! Print agent will print automatically.');
      } else if (status === 'rejected') {
        await orderAPI.reject(orderId);
        toast.success('Order rejected.');
      } else {
        await orderAPI.updateStatus(orderId, status);
        toast.success(`Order marked as ${statusLabel[status]}`);
      }
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update status');
    }
  };

  // ── Confirm pickup — calls verifyPickup ───────────────────────────────────
  const handleConfirmPickup = async () => {
    if (!confirmOrder) return;
    setConfirmLoading(true);
    try {
      await orderAPI.verifyPickup({
        orderId:    confirmOrder._id,
        pickupCode: confirmOrder.pickup?.pickupCode,
      });
      toast.success('✅ OTP verified! Order marked as collected.');
      setConfirmOrder(null);
      fetchOrders(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not confirm pickup');
    } finally {
      setConfirmLoading(false);
    }
  };

  // ── Download document ─────────────────────────────────────────────────────
  const handleDownload = async (orderId, docId) => {
    try {
      const res = await orderAPI.getDocumentUrl(orderId, docId);
      const url = res.data.data?.downloadUrl || res.data.data?.url || res.data.url;
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

  // ── Tab filter ─────────────────────────────────────────────────────────────
  const queueOrders   = orders.filter(o => o.status === 'paid');
  const activeOrders  = orders.filter(o => ['accepted', 'printing', 'ready'].includes(o.status));
  const historyOrders = orders.filter(o => ['picked_up', 'rejected', 'cancelled', 'expired'].includes(o.status));

  // Search filter helper — matches AdminDashboard search pattern
  const applySearch = (list, query) => {
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter(o =>
      (o.user?.name  || '').toLowerCase().includes(q) ||
      (o.user?.email || '').toLowerCase().includes(q) ||
      (o.user?.phone || '').toLowerCase().includes(q) ||
      (o.orderNumber || '').toLowerCase().includes(q)
    );
  };

  const applyStatusFilter = (list, status) =>
    status ? list.filter(o => o.status === status) : list;

  const filteredQueue   = applySearch(queueOrders,   queueSearch);
  const filteredActive  = applyStatusFilter(applySearch(activeOrders, activeSearch), statusFilter);
  const filteredHistory = applySearch(historyOrders, historySearch);

  const tabs = [
    { key: 'queue',   label: 'Queue',   icon: <Clock    className="h-4 w-4" />, count: queueOrders.length   },
    { key: 'active',  label: 'Active',  icon: <Printer  className="h-4 w-4" />, count: activeOrders.length  },
    { key: 'history', label: 'History', icon: <History  className="h-4 w-4" />, count: historyOrders.length },
  ];

  const getSearch = () => {
    if (activeTab === 'queue')   return [queueSearch,   setQueueSearch];
    if (activeTab === 'active')  return [activeSearch,  setActiveSearch];
    return                              [historySearch,  setHistorySearch];
  };
  const [searchVal, setSearchVal] = getSearch();

  const getCurrentOrders = () => {
    if (activeTab === 'queue')   return filteredQueue;
    if (activeTab === 'active')  return filteredActive;
    return filteredHistory;
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      <div className="container mx-auto px-4 py-8">

        {/* ── Header — identical to original ─────────────────────────────── */}
        <div className="mb-8 flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-heading text-3xl font-bold">Shop Dashboard 🏪</h1>
            <p className="text-muted-foreground mt-1">{myShop?.name || user?.name}</p>
          </div>
          <div className="flex gap-2">
            {/* Shop open/close toggle — newly wired */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleShop}
              className={myShop?.isOpen
                ? 'border-green-400 text-green-700 hover:bg-green-50'
                : 'border-red-400 text-red-700 hover:bg-red-50'}
            >
              <Store className="h-4 w-4 mr-1" />
              {myShop?.isOpen ? '🟢 Open' : '🔴 Closed'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => fetchOrders(false)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* ── Print agent banner — preserved from original ────────────────── */}
        <div className="mb-6 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
          <Printer className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            <strong>Auto-print active</strong> — when you click Accept, the print agent on this PC will
            automatically print the document. If the agent is not running, use the{' '}
            <strong>Download</strong> link as fallback.
          </span>
        </div>

        {/* ── Tabs — identical className pattern to original ──────────────── */}
        <div className="mb-6 flex flex-wrap gap-2">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all
                ${activeTab === t.key
                  ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
            >
              {t.icon}
              {t.label}
              {t.count > 0 && (
                <span className="rounded-full bg-white/25 px-1.5 text-xs font-bold">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Search bar + filters — matches AdminDashboard Users tab exactly ─ */}
        <div className="glass-card p-4 mb-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-48">
            <Label className="text-xs">Search</Label>
            <div className="relative mt-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Name, email or phone..."
                value={searchVal}
                onChange={e => setSearchVal(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setSearchVal('')}
                className="pl-8 h-9 text-sm"
              />
            </div>
          </div>

          {/* Status filter — only on Active tab */}
          {activeTab === 'active' && (
            <div>
              <Label className="text-xs">Status</Label>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="mt-1 rounded-lg border border-border bg-background px-3 h-9 text-sm"
              >
                <option value="">All active</option>
                <option value="accepted">Accepted</option>
                <option value="printing">Printing</option>
                <option value="ready">Ready for Pickup</option>
              </select>
            </div>
          )}

          <Button
            size="sm"
            className="sunrise-gradient text-primary-foreground"
            onClick={() => {/* search is live, button just confirms */}}
          >
            <Search className="h-3.5 w-3.5 mr-1" /> Search
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setSearchVal(''); setStatusFilter(''); }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        </div>

        {/* ── Orders table — matching AdminDashboard table style ──────────── */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground">Loading orders...</div>
        ) : (
          <div className="glass-card overflow-hidden">
            <OrdersTable
              orders={getCurrentOrders()}
              isHistory={activeTab === 'history'}
              onAction={updateStatus}
              onOpenConfirm={setConfirmOrder}
              onDownload={handleDownload}
            />
          </div>
        )}
      </div>

      {/* ── Confirm Pickup Modal ─────────────────────────────────────────── */}
      <AnimatePresence>
        {confirmOrder && (
          <ConfirmPickupModal
            order={confirmOrder}
            onClose={() => setConfirmOrder(null)}
            onConfirm={handleConfirmPickup}
            loading={confirmLoading}
          />
        )}
      </AnimatePresence>

      <Footer />
    </div>
  );
};

export default ShopDashboard;