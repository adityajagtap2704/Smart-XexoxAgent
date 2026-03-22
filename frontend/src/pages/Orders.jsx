import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { orderAPI, notificationAPI } from '@/lib/api';
import { onOrderUpdate, joinOrderRoom } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { FileText, CheckCircle, X, RefreshCw, Star, XCircle } from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

const statusSteps = ['paid', 'accepted', 'printing', 'ready', 'picked_up'];

const statusLabels = {
  pending_payment: 'Awaiting Payment',
  paid:            'Paid',
  accepted:        'Accepted',
  printing:        'Printing',
  ready:           'Ready',
  picked_up:       'Collected',
  cancelled:       'Cancelled',
  rejected:        'Rejected',
  expired:         'Expired',
};

const statusColors = {
  pending_payment: 'bg-yellow-100 text-yellow-800',
  paid:            'bg-blue-100 text-blue-800',
  accepted:        'bg-indigo-100 text-indigo-800',
  printing:        'bg-purple-100 text-purple-800',
  ready:           'bg-green-100 text-green-800',
  picked_up:       'bg-gray-100 text-gray-600',
  cancelled:       'bg-red-100 text-red-700',
  rejected:        'bg-red-100 text-red-700',
  expired:         'bg-orange-100 text-orange-700',
};

// ── Star Rating Component ─────────────────────────────────────────────────────
const StarRating = ({ value, onChange }) => (
  <div className="flex gap-1">
    {[1, 2, 3, 4, 5].map((star) => (
      <button key={star} type="button" onClick={() => onChange(star)}
        className={`text-2xl transition-transform hover:scale-110 ${star <= value ? 'text-yellow-400' : 'text-gray-300'}`}>
        ★
      </button>
    ))}
  </div>
);

const Orders = () => {
  const { user } = useAuth();
  const [orders, setOrders]     = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading]   = useState(true);

  // Rate modal
  const [rateTarget, setRateTarget]   = useState(null);
  const [rating, setRating]           = useState(0);
  const [review, setReview]           = useState('');
  const [submittingRate, setSubmittingRate] = useState(false);

  // Cancel confirm
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling]     = useState(false);

  const fetchOrders = () => {
    orderAPI.getMyOrders()
      .then(res => setOrders(res.data.data?.orders || res.data.orders || res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, []);

  useEffect(() => {
    const cleanup = onOrderUpdate((data) => {
      setOrders(prev => prev.map(o =>
        o._id === data.orderId
          ? { ...o, status: data.status, pickup: data.pickupCode ? { ...o.pickup, pickupCode: data.pickupCode } : o.pickup }
          : o
      ));
      toast.info(`Order status: ${statusLabels[data.status] || data.status}`);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    orders.forEach(o => {
      if (!['picked_up', 'cancelled', 'expired', 'rejected'].includes(o.status)) joinOrderRoom(o._id);
    });
  }, [orders]);

  // ── Extend expiry ─────────────────────────────────────────────────────────
  const handleExtend = async (id) => {
    try {
      await orderAPI.extendExpiry(id);
      toast.success('Expiry extended by 12 hours ✅');
      fetchOrders();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to extend'); }
  };

  // ── Cancel order ──────────────────────────────────────────────────────────
  const handleCancel = async () => {
    setCancelling(true);
    try {
      await orderAPI.cancel(cancelTarget._id);
      toast.success('Order cancelled');
      setCancelTarget(null);
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to cancel order');
    } finally {
      setCancelling(false);
    }
  };

  // ── Rate order ────────────────────────────────────────────────────────────
  const handleRate = async () => {
    if (rating === 0) { toast.error('Please select a star rating'); return; }
    setSubmittingRate(true);
    try {
      await orderAPI.rateOrder(rateTarget._id, { rating, review });
      toast.success('Thank you for your feedback! ⭐');
      setRateTarget(null);
      setRating(0);
      setReview('');
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit rating');
    } finally {
      setSubmittingRate(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">
        <h1 className="font-heading text-3xl font-bold mb-6">My Orders</h1>

        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">No orders yet</div>
        ) : (
          <div className="space-y-4">
            {orders.map((order, i) => (
              <motion.div key={order._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="glass-card p-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">#{order.orderNumber || order._id.slice(-6).toUpperCase()}</p>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[order.status] || 'bg-muted text-muted-foreground'}`}>
                          {statusLabels[order.status] || order.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {order.documents?.[0]?.originalName || order.documents?.[0]?.fileName || 'Document'} &bull; {new Date(order.createdAt).toLocaleString('en-IN')}
                      </p>
                      {order.shop?.name && <p className="text-xs text-muted-foreground">📍 {order.shop.name}</p>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className="font-heading font-bold text-primary">₹{order.pricing?.total || 0}</span>

                    {/* Show OTP if ready */}
                    {order.status === 'ready' && (
                      <Button size="sm" variant="outline" onClick={() => setSelected(order)}>Show OTP / QR</Button>
                    )}

                    {/* Extend expiry */}
                    {['paid', 'accepted', 'printing', 'ready'].includes(order.status) && (
                      <Button size="sm" variant="ghost" onClick={() => handleExtend(order._id)} className="text-xs">
                        <RefreshCw className="h-3 w-3 mr-1" /> Extend
                      </Button>
                    )}

                    {/* Cancel — only if paid (not yet accepted) */}
                    {order.status === 'paid' && (
                      <Button size="sm" variant="ghost" className="text-destructive text-xs" onClick={() => setCancelTarget(order)}>
                        <XCircle className="h-3 w-3 mr-1" /> Cancel
                      </Button>
                    )}

                    {/* Rate — only after picked up, and not yet rated */}
                    {order.status === 'picked_up' && !order.rating?.score && (
                      <Button size="sm" className="sunrise-gradient text-primary-foreground text-xs" onClick={() => { setRateTarget(order); setRating(0); setReview(''); }}>
                        <Star className="h-3 w-3 mr-1" /> Rate
                      </Button>
                    )}

                    {/* Show rating if already rated */}
                    {order.rating?.score && (
                      <span className="text-xs text-yellow-600 font-medium">⭐ {order.rating.score}/5 rated</span>
                    )}
                  </div>
                </div>

                {/* Status tracker */}
                {!['cancelled', 'rejected', 'expired'].includes(order.status) && (
                  <div className="mt-4">
                    <div className="flex items-center gap-1 overflow-x-auto pb-1">
                      {statusSteps.map((step, si) => {
                        const currentIdx = statusSteps.indexOf(order.status);
                        const done = si <= currentIdx;
                        return (
                          <div key={step} className="flex items-center">
                            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium shrink-0 ${done ? 'sunrise-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                              {done ? <CheckCircle className="h-3.5 w-3.5" /> : si + 1}
                            </div>
                            {si < statusSteps.length - 1 && <div className={`h-0.5 w-6 sm:w-10 ${done ? 'bg-primary' : 'bg-muted'}`} />}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground overflow-x-auto">
                      {statusSteps.map((s) => (
                        <span key={s} className="min-w-[52px] text-center">{statusLabels[s]}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Rejected / cancelled reason */}
                {['rejected', 'cancelled'].includes(order.status) && order.statusHistory?.find(h => h.status === order.status)?.note && (
                  <div className="mt-3 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-700">
                    <strong>Reason:</strong> {order.statusHistory.find(h => h.status === order.status).note}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {/* ── OTP + QR Modal ── */}
        {selected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setSelected(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-8 text-center max-w-sm w-full relative" onClick={e => e.stopPropagation()}>
              <button onClick={() => setSelected(null)} className="absolute top-3 right-3"><X className="h-5 w-5" /></button>
              <h3 className="font-heading text-lg font-semibold mb-1">Your Pickup Code</h3>
              <p className="text-sm text-muted-foreground mb-5">Show this to the shopkeeper</p>
              {selected.pickup?.pickupCode && (
                <div className="rounded-xl bg-green-50 border border-green-200 p-4 mb-5">
                  <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-1">OTP</p>
                  <p className="font-mono text-4xl font-bold text-green-800 tracking-[0.3em]">{selected.pickup.pickupCode}</p>
                </div>
              )}
              {selected.pickup?.qrCode && (
                <>
                  <p className="text-xs text-muted-foreground mb-3">Or scan QR code</p>
                  <QRCodeSVG value={selected.pickup.qrCode} size={180} className="mx-auto" />
                </>
              )}
            </motion.div>
          </div>
        )}

        {/* ── Cancel Confirm Modal ── */}
        {cancelTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setCancelTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="font-heading font-semibold mb-2 flex items-center gap-2"><XCircle className="h-5 w-5 text-destructive" /> Cancel Order</h3>
              <p className="text-sm text-muted-foreground mb-2">Order <strong>#{cancelTarget._id.slice(-6).toUpperCase()}</strong></p>
              <p className="text-sm text-muted-foreground mb-5">Are you sure? This cannot be undone. If you've paid, a refund will be initiated.</p>
              <div className="flex gap-2">
                <Button className="flex-1 bg-destructive text-destructive-foreground" disabled={cancelling} onClick={handleCancel}>
                  {cancelling ? 'Cancelling...' : 'Yes, Cancel Order'}
                </Button>
                <Button variant="outline" onClick={() => setCancelTarget(null)}>Keep Order</Button>
              </div>
            </motion.div>
          </div>
        )}

        {/* ── Rate Order Modal ── */}
        {rateTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setRateTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-heading font-semibold flex items-center gap-2"><Star className="h-5 w-5 text-yellow-400" /> Rate Your Experience</h3>
                <button onClick={() => setRateTarget(null)}><X className="h-4 w-4" /></button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">Order #{rateTarget._id.slice(-6).toUpperCase()} at {rateTarget.shop?.name || 'shop'}</p>
              <div className="flex justify-center mb-4">
                <StarRating value={rating} onChange={setRating} />
              </div>
              <textarea
                value={review}
                onChange={e => setReview(e.target.value)}
                placeholder="Write a review (optional)..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm min-h-[80px] mb-4"
              />
              <Button onClick={handleRate} disabled={submittingRate || rating === 0} className="w-full sunrise-gradient text-primary-foreground">
                {submittingRate ? 'Submitting...' : 'Submit Rating'}
              </Button>
            </motion.div>
          </div>
        )}

      </div>
      <Footer />
    </div>
  );
};

export default Orders;