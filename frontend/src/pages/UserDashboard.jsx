import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { orderAPI, paymentAPI, uploadAPI } from '@/lib/api';
import { onOrderUpdate, onPaymentSuccess, joinOrderRoom } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { Upload, FileText, Package, X, Loader2 } from 'lucide-react';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';

const statusColors = {
  pending_payment: 'bg-yellow-100 text-yellow-800',
  paid:            'bg-blue-100 text-blue-800',
  accepted:        'bg-indigo-100 text-indigo-800',
  printing:        'bg-purple-100 text-purple-800',
  ready:           'bg-green-100 text-green-800',
  picked_up:       'bg-gray-100 text-gray-700',
  cancelled:       'bg-red-100 text-red-800',
  rejected:        'bg-red-100 text-red-800',
  expired:         'bg-orange-100 text-orange-800',
};

const statusLabels = {
  pending_payment: 'Awaiting Payment',
  paid:            'Paid — In Queue',
  accepted:        'Accepted',
  printing:        'Printing...',
  ready:           '✅ Ready for Pickup!',
  picked_up:       'Collected',
  cancelled:       'Cancelled',
  rejected:        'Rejected',
  expired:         'Expired',
};

// Hardcoded AISSMS shop — only one shop in the system
const SHOP_ID   = '69bd47f623f7b2a6b4e6b937';
const SHOP_NAME = 'AISSMS College Xerox Centre';

const UserDashboard = () => {
  const { user } = useAuth();
  const [orders, setOrders]         = useState([]);
  const [activeTab, setActiveTab]   = useState('orders');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading]       = useState(true);

  // New order form state
  const [file, setFile]             = useState(null);
  const [copies, setCopies]         = useState(1);
  const [colorType, setColorType]   = useState('bw');
  const [paperSize, setPaperSize]   = useState('A4');
  const [doubleSided, setDoubleSided]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadStep, setUploadStep] = useState('');

  const fetchOrders = useCallback(async () => {
    try {
      const res = await orderAPI.getMyOrders();
      setOrders(res.data.data?.orders || res.data.orders || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchOrders().finally(() => setLoading(false));
  }, [fetchOrders]);

  useEffect(() => {
    const cleanup = onOrderUpdate((data) => {
      setOrders((prev) =>
        prev.map((o) => o._id === data.orderId ? { ...o, status: data.status } : o)
      );
      setSelectedOrder((prev) =>
        prev?._id === data.orderId ? { ...prev, status: data.status } : prev
      );
      toast.info(`Order: ${statusLabels[data.status] || data.status}`);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = onPaymentSuccess(() => {
      fetchOrders();
      toast.success('Payment confirmed! Order is in queue.');
    });
    return cleanup;
  }, [fetchOrders]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      toast.error('Please select a file to upload');
      return;
    }
    setSubmitting(true);
    try {
      // STEP 1 — Upload file to S3
      setUploadStep('Uploading document...');
      const uploadRes = await uploadAPI.uploadFile(file);
      const doc = uploadRes.data.data || uploadRes.data;

      // STEP 2 — Create order
      setUploadStep('Creating order...');
      const orderRes = await orderAPI.create({
        shopId: SHOP_ID,
        documents: [{
          originalName: file.name,
          s3Url:        doc.s3Url,
          s3Key:        doc.s3Key,
          fileSize:     file.size,
          pages:        doc.detectedPages || 1,
          colorType,
          paperSize,
          copies,
          doubleSided,
        }],
      });

      const { order, razorpay } = orderRes.data.data;

      // STEP 3 — Open Razorpay
      setUploadStep('Opening payment...');
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
            toast.success('Payment successful! Order placed. ✅');
            fetchOrders();
            setActiveTab('orders');
          } catch {
            toast.error('Payment verification failed. Contact support — Order ID: ' + order._id);
          }
        },
        modal: {
          ondismiss: () => {
            toast.info('Payment cancelled. Complete it anytime from My Orders → Pay Now.');
          },
        },
        prefill: { name: user?.name, email: user?.email, contact: user?.phone },
        theme:   { color: '#f97316' },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
      setFile(null);
      setCopies(1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
      setUploadStep('');
    }
  };

  const estimatedCost = () => {
    const rate = colorType === 'color' ? 5 : 1;
    return (rate * copies).toFixed(2);
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="font-heading text-3xl font-bold">Hello, {user?.name} 👋</h1>
          <p className="text-muted-foreground">Manage your printing orders</p>
        </div>

        <div className="mb-6 flex gap-2">
          {['orders','new'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-xl px-5 py-2.5 text-sm font-medium transition-all capitalize ${activeTab === tab ? 'sunrise-gradient text-primary-foreground sunrise-shadow-sm' : 'bg-secondary text-secondary-foreground'}`}
            >
              {tab === 'orders' ? 'My Orders' : 'New Order'}
            </button>
          ))}
        </div>

        {/* ── New Order Form ─────────────────────────────────────── */}
        {activeTab === 'new' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6 max-w-2xl">
            <h2 className="font-heading text-xl font-semibold mb-6">Place New Order</h2>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label>Upload Document</Label>
                <div className="mt-1.5 border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors">
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.jpg,.png"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="hidden"
                    id="file-upload"
                  />
                  <label htmlFor="file-upload" className="cursor-pointer">
                    <Upload className="mx-auto h-10 w-10 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {file ? file.name : 'Click to upload or drag & drop'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">PDF, DOC, JPG, PNG (Max 20MB)</p>
                  </label>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Copies</Label>
                  <Input type="number" min={1} max={100} value={copies} onChange={(e) => setCopies(Number(e.target.value))} className="mt-1.5" />
                </div>
                <div>
                  <Label>Color Type</Label>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    {['bw','color'].map((t) => (
                      <button key={t} type="button" onClick={() => setColorType(t)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${colorType === t ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                        {t === 'bw' ? 'B&W' : 'Color'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Paper Size</Label>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {['A4','A3','Letter'].map((s) => (
                      <button key={s} type="button" onClick={() => setPaperSize(s)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${paperSize === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Print Sides</Label>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    {[false,true].map((d) => (
                      <button key={String(d)} type="button" onClick={() => setDoubleSided(d)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${doubleSided === d ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                        {d ? 'Double' : 'Single'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-xl bg-secondary/50 border border-border px-4 py-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground font-medium">📍 Shop</span>
                <span className="font-semibold">{SHOP_NAME}</span>
              </div>

              <div className="flex items-center justify-between rounded-xl bg-secondary p-4">
                <span className="font-medium">Estimated Cost</span>
                <span className="font-heading text-xl font-bold text-primary">₹{estimatedCost()}</span>
              </div>

              <Button type="submit" className="w-full sunrise-gradient text-primary-foreground sunrise-shadow-sm" disabled={submitting}>
                {submitting
                  ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{uploadStep || 'Processing...'}</span>
                  : 'Place Order & Pay'}
              </Button>
            </form>
          </motion.div>
        )}

        {/* ── Orders List ────────────────────────────────────────── */}
        {activeTab === 'orders' && (
          <div className="space-y-4">
            {loading ? (
              <div className="text-center py-12 text-muted-foreground">Loading orders...</div>
            ) : orders.length === 0 ? (
              <div className="text-center py-12">
                <Package className="mx-auto h-12 w-12 text-muted-foreground mb-3" />
                <p className="text-muted-foreground">No orders yet</p>
                <Button className="mt-4 sunrise-gradient text-primary-foreground" onClick={() => setActiveTab('new')}>
                  Place Your First Order
                </Button>
              </div>
            ) : (
              orders.map((order, i) => (
                <motion.div
                  key={order._id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="glass-card p-5 cursor-pointer hover:sunrise-shadow-sm transition-all"
                  onClick={() => { setSelectedOrder(order); joinOrderRoom(order._id); }}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">
                          {order.documents?.[0]?.fileName || `Order #${order._id.slice(-6).toUpperCase()}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(order.createdAt).toLocaleDateString('en-IN')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusColors[order.status] || 'bg-muted text-muted-foreground'}`}>
                        {statusLabels[order.status] || order.status}
                      </span>
                      {order.pricing?.total != null && (
                        <span className="font-heading font-bold text-primary">₹{order.pricing.total}</span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* ── Order Detail Modal ─────────────────────────────────── */}
        {selectedOrder && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 backdrop-blur-sm p-4" onClick={() => setSelectedOrder(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass-card p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-heading text-lg font-semibold">Order Details</h3>
                <button onClick={() => setSelectedOrder(null)}><X className="h-5 w-5" /></button>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order Number</span>
                  <span className="font-medium">#{selectedOrder.orderNumber || selectedOrder._id.slice(-8).toUpperCase()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[selectedOrder.status] || ''}`}>
                    {statusLabels[selectedOrder.status] || selectedOrder.status}
                  </span>
                </div>
                {selectedOrder.documents?.[0] && (
                  <>
                    <div className="flex justify-between"><span className="text-muted-foreground">File</span><span>{selectedOrder.documents[0].fileName}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Copies</span><span>{selectedOrder.documents[0].copies}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Color</span><span>{selectedOrder.documents[0].colorType === 'color' ? 'Color' : 'B&W'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Paper</span><span>{selectedOrder.documents[0].paperSize}</span></div>
                  </>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-bold text-primary">₹{selectedOrder.pricing?.total}</span>
                </div>
                {selectedOrder.shop && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Shop</span>
                    <span>{selectedOrder.shop?.name}</span>
                  </div>
                )}
              </div>

              {/* When ready — just show a note, OTP goes to email */}
              {selectedOrder.status === 'ready' && (
                <div className="mt-4 rounded-xl bg-green-50 border border-green-200 p-4 text-center">
                  <p className="text-sm text-green-700 font-semibold">✅ Your order is ready for pickup!</p>
                  <p className="text-xs text-green-600 mt-1">Check your email for the pickup OTP.</p>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
};

export default UserDashboard;