import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { orderAPI, paymentAPI } from '@/lib/api';
import { onOrderUpdate, joinOrderRoom } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { FileText, CheckCircle, RefreshCw, CreditCard } from 'lucide-react';
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

  const [payingOrderId, setPayingOrderId] = useState(null);

  const handlePayNow = async (order) => {
    setPayingOrderId(order._id);
    try {
      const res = await orderAPI.retryPayment(order._id);
      const { razorpay } = res.data.data;
      const options = {
        key:         razorpay.key,
        amount:      razorpay.amount,
        currency:    razorpay.currency,
        name:        'Smart Xerox',
        description: 'Document Printing',
        order_id:    razorpay.orderId,
        config: {
          display: {
            blocks: { upi: { name: 'Pay via UPI', instruments: [{ method: 'upi' }] } },
            sequence: ['block.upi'],
            preferences: { show_default_blocks: false },
          },
        },
        handler: async (response) => {
          try {
            await paymentAPI.verify({
              razorpayOrderId:   response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            });
            toast.success('Payment successful! Order is now in queue ✅');
            orderAPI.getMyOrders().then(r => setOrders(r.data.data?.orders || r.data.orders || []));
          } catch { toast.error('Payment verification failed. Contact support.'); }
        },
        modal: { ondismiss: () => toast.info('Payment cancelled. You can retry anytime.') },
        prefill: { name: order.user?.name, email: order.user?.email },
        theme: { color: '#f97316' },
      };
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not open payment. Try again.');
    } finally {
      setPayingOrderId(null);
    }
  };

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

                    {['paid','accepted','printing','ready'].includes(order.status) && (
                      <Button size="sm" variant="ghost" onClick={() => handleExtend(order._id)}>
                        <RefreshCw className="h-3 w-3 mr-1" /> Extend
                      </Button>
                    )}
                  </div>
                </div>

                {order.status === 'pending_payment' && (
                  <div className="mt-3 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800 flex items-center gap-2">
                    <CreditCard className="h-3.5 w-3.5 shrink-0" />
                    <span><strong>Payment pending</strong> — click Pay Now to complete this order.</span>
                  </div>
                )}
                {order.status !== 'pending_payment' && (
                <><div className="mt-4 flex items-center gap-1 overflow-x-auto pb-1">
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
                </>)}
              </motion.div>
            ))}
          </div>
        )}


      </div>
      <Footer />
    </div>
  );
};

export default Orders;