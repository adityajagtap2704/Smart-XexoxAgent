import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { orderAPI } from '@/lib/api';
import { onOrderUpdate, joinOrderRoom } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { FileText, CheckCircle, X, RefreshCw } from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

const statusSteps = ['paid', 'accepted', 'printing', 'ready', 'picked_up'];

const statusLabels = {
  pending_payment: 'Awaiting Payment',
  paid:        'Paid',
  accepted:    'Accepted',
  printing:    'Printing',
  ready:       'Ready',
  picked_up:   'Collected',
  cancelled:   'Cancelled',
  rejected:    'Rejected',
  expired:     'Expired',
};

const Orders = () => {
  const { user } = useAuth();
  const [orders, setOrders]   = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    orderAPI.getMyOrders()
      .then((res) => setOrders(res.data.data?.orders || res.data.orders || res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // FIX: was 'order-update' — correct event is 'order:status_update'
    const cleanup = onOrderUpdate((data) => {
      setOrders((prev) => prev.map((o) =>
        o._id === data.orderId
          ? { ...o, status: data.status, pickup: data.pickupCode ? { ...o.pickup, pickupCode: data.pickupCode } : o.pickup }
          : o
      ));
      const label = statusLabels[data.status] || data.status;
      toast.info(`Order status: ${label}`);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    orders.forEach((o) => {
      if (!['picked_up', 'cancelled', 'expired', 'rejected'].includes(o.status)) {
        joinOrderRoom(o._id);
      }
    });
  }, [orders]);

  const handleExtend = async (id) => {
    try {
      await orderAPI.extendExpiry(id);
      toast.success('Expiry extended by 12 hours');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to extend');
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
              <motion.div
                key={order._id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="glass-card p-5"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">
                        #{order.orderNumber || order._id.slice(-6).toUpperCase()}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {order.documents?.[0]?.fileName || 'Document'} &bull; {new Date(order.createdAt).toLocaleString('en-IN')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-heading font-bold text-primary">
                      ₹{order.pricing?.total || 0}
                    </span>
                    {order.status === 'ready' && (
                      <Button size="sm" variant="outline" onClick={() => setSelected(order)}>
                        Show OTP / QR
                      </Button>
                    )}
                    {['paid','accepted','printing','ready'].includes(order.status) && (
                      <Button size="sm" variant="ghost" onClick={() => handleExtend(order._id)}>
                        <RefreshCw className="h-3 w-3 mr-1" /> Extend
                      </Button>
                    )}
                  </div>
                </div>

                {/* Status tracker */}
                <div className="mt-4 flex items-center gap-1 overflow-x-auto pb-1">
                  {statusSteps.map((step, si) => {
                    const currentIdx = statusSteps.indexOf(order.status);
                    const done = si <= currentIdx;
                    return (
                      <div key={step} className="flex items-center">
                        <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium shrink-0 ${done ? 'sunrise-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                          {done ? <CheckCircle className="h-3.5 w-3.5" /> : si + 1}
                        </div>
                        {si < statusSteps.length - 1 && (
                          <div className={`h-0.5 w-6 sm:w-10 ${done ? 'bg-primary' : 'bg-muted'}`} />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground overflow-x-auto">
                  {statusSteps.map((s) => (
                    <span key={s} className="min-w-[52px] text-center capitalize">
                      {statusLabels[s] || s}
                    </span>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* OTP + QR modal for ready orders */}
        {selected && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4"
            onClick={() => setSelected(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass-card p-8 text-center max-w-sm w-full relative"
              onClick={(e) => e.stopPropagation()}
            >
              <button onClick={() => setSelected(null)} className="absolute top-3 right-3">
                <X className="h-5 w-5" />
              </button>
              <h3 className="font-heading text-lg font-semibold mb-1">Your Pickup Code</h3>
              <p className="text-sm text-muted-foreground mb-5">Show this to the shopkeeper</p>

              {selected.pickup?.pickupCode && (
                <div className="rounded-xl bg-green-50 border border-green-200 p-4 mb-5">
                  <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-1">OTP</p>
                  <p className="font-mono text-4xl font-bold text-green-800 tracking-[0.3em]">
                    {selected.pickup.pickupCode}
                  </p>
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
      </div>
      <Footer />
    </div>
  );
};

export default Orders;
