import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { orderAPI, paymentAPI, shopAPI, uploadAPI } from '@/lib/api';
import { onOrderUpdate, onPaymentSuccess, joinOrderRoom, joinShopRoom, onShopStatusUpdate } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { Upload, FileText, Package, X, Loader2, Plus, Trash2 } from 'lucide-react';
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

const UserDashboard = () => {
  const { user } = useAuth();
  const [orders, setOrders]         = useState([]);
  const [activeTab, setActiveTab]   = useState('orders');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading]       = useState(true);

  // New order form state
  const [file, setFile]             = useState(null);
  const [fileData, setFileData]     = useState(null);  // Stores: { s3Url, s3Key, fileSize, detectedPages }
  const [shopInfo, setShopInfo]     = useState(null);
  const [configs, setConfigs]       = useState([{ id: Date.now(), rangeStart: 1, rangeEnd: 1, copies: 1, colorMode: 'bw', sides: 'single' }]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadStep, setUploadStep] = useState('');
  const [spiralBinding, setSpiralBinding] = useState(false);
  const [filePageCount, setFilePageCount] = useState(null);
  const [manualCountRequired, setManualCountRequired] = useState(false);
  const [manualCountConfirmed, setManualCountConfirmed] = useState(false);

  // Get shop ID from user (auto-linked during registration)
  const SHOP_ID = user?.shop?._id || user?.shop || null;
  const shopId = SHOP_ID ? String(SHOP_ID) : null;

  const effectivePageCount = filePageCount || 1;

  useEffect(() => {
    const loadShopInfo = async () => {
      if (!shopId) {
        setShopInfo(null);
        return;
      }
      try {
        const res = await shopAPI.getById(shopId);
        setShopInfo(res.data.data?.shop || res.data?.shop || res.data || null);
      } catch {
        setShopInfo(null);
      }
    };
    loadShopInfo();
  }, [shopId]);

  useEffect(() => {
    if (!shopId) return;
    const cleanup = onShopStatusUpdate((payload) => {
      if (payload?.isOpen === undefined) return;
      setShopInfo((prev) => prev ? { ...prev, isOpen: payload.isOpen } : prev);
      toast(`${payload.isOpen ? 'Shop is now open' : 'Shop is now closed'}`);
    });
    joinShopRoom(shopId);
    return cleanup;
  }, [shopId]);

  const addConfig = () => {
    setConfigs([...configs, { id: Date.now(), rangeStart: 1, rangeEnd: effectivePageCount, copies: 1, colorMode: 'bw', sides: 'single' }]);
  };

  const handleManualPageCountChange = (value) => {
    const pages = Number(value) || 0;
    setFilePageCount(pages > 0 ? pages : null);
    setConfigs([{ id: Date.now(), rangeStart: 1, rangeEnd: pages > 0 ? pages : 1, copies: 1, colorMode: 'bw', sides: 'single' }]);
    if (manualCountConfirmed) {
      setManualCountConfirmed(false);
    }
  };

  const removeConfig = (id) => {
    if (configs.length > 1) {
      setConfigs(configs.filter(c => c.id !== id));
    }
  };

  const updateConfig = (id, field, value) => {
    setConfigs(configs.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  // Auto-upload file when selected to detect pages
  const handleFileSelect = async (selectedFile) => {
    if (!selectedFile) {
      setFile(null);
      setFileData(null);
      setFilePageCount(null);
      return;
    }

    setFile(selectedFile);
    setUploadStep('Detecting pages...');
    
    try {
      const uploadRes = await uploadAPI.uploadFile(selectedFile);
      const doc = uploadRes.data.data || uploadRes.data;
      const detectedPages = doc.detectedPages || 0;
      const isWord = selectedFile?.name?.toLowerCase().endsWith('.docx') || selectedFile?.name?.toLowerCase().endsWith('.doc');
      const manualRequired = Boolean(doc.manualCountRequired || (isWord && detectedPages === 0));

      // Store the uploaded file info for later use
      setFileData({
        s3Url: doc.s3Url,
        s3Key: doc.s3Key,
        fileSize: doc.fileSize || selectedFile.size,
        detectedPages,
      });
      setManualCountRequired(manualRequired);
      setUploadStep('');

      if (detectedPages > 0) {
        setFilePageCount(detectedPages);
        setConfigs([{ id: Date.now(), rangeStart: 1, rangeEnd: detectedPages, copies: 1, colorMode: 'bw', sides: 'single' }]);
        toast.success(`✅ ${detectedPages} pages detected`);
      } else if (manualRequired) {
        setFilePageCount(null);
        setManualCountConfirmed(false);
        setConfigs([{ id: Date.now(), rangeStart: 1, rangeEnd: 1, copies: 1, colorMode: 'bw', sides: 'single' }]);
        toast('Please enter total pages for DOC/DOCX file before placing the order.');
      } else {
        setFile(null);
        setFileData(null);
        setFilePageCount(null);
        setConfigs([{ id: Date.now(), rangeStart: 1, rangeEnd: 1, copies: 1, colorMode: 'bw', sides: 'single' }]);
        toast.error('Page count could not be detected. Please upload a supported document.');
      }
    } catch (err) {
      setUploadStep('');
      setFile(null);
      setFileData(null);
      setFilePageCount(null);
      setManualCountRequired(false);
      toast.error(err.response?.data?.message || 'Failed to upload file');
    }
  };

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
    if (!file || !fileData) {
      toast.error('Please upload a document first');
      return;
    }
    if (!SHOP_ID) {
      toast.error('Error: Shop not found. Please try logging in again.');
      return;
    }

    setSubmitting(true);
    setUploadStep('');
    
    try {
      const totalPages = filePageCount;

      if (manualCountRequired && !manualCountConfirmed) {
        toast.error('Please confirm the manual page count before placing the order.');
        setSubmitting(false);
        return;
      }

      if (!totalPages || totalPages <= 0) {
        toast.error(manualCountRequired ? 'Please enter the total number of pages for your DOC/DOCX file.' : 'Page count was not detected. Upload a supported DOC/DOCX/PDF file.');
        setSubmitting(false);
        return;
      }

      if (shopInfo && shopInfo.isOpen === false) {
        toast.error('This shop is currently closed. Please place your order when the shop is open.');
        setSubmitting(false);
        return;
      }
      
      // Validate page ranges
      for (let [index, config] of configs.entries()) {
        if (config.rangeStart === '' || config.rangeEnd === '' || config.copies === '') {
          toast.error(`Required fields are missing for page range ${index + 1}. Please fill Start Page, End Page, and Copies.`);
          setSubmitting(false);
          return;
        }

        if (config.rangeStart < 1 || config.rangeEnd > totalPages || config.rangeStart > config.rangeEnd) {
          toast.error(`Invalid page range: ${config.rangeStart}-${config.rangeEnd} (document has ${totalPages} pages)`);
          setSubmitting(false);
          return;
        }

        if (config.copies < 1 || config.copies > 100) {
          toast.error(`Copies must be between 1 and 100 for page range ${index + 1}.`);
          setSubmitting(false);
          return;
        }
      }

      setUploadStep('Creating order...');
      const orderRes = await orderAPI.create({
        shopId: shopId,
        documents: [{
          originalName: file.name,
          s3Url:        fileData.s3Url,
          s3Key:        fileData.s3Key,
          fileSize:     fileData.fileSize,
          detectedPages: totalPages,
          printingOptions: {
            paperSize: 'A4',
            orientation: 'auto',
          },
          printingRanges: configs.map(c => ({
            rangeStart: c.rangeStart,
            rangeEnd: c.rangeEnd,
            copies: c.copies,
            colorMode: c.colorMode,
            sides: c.sides,
          })),
        }],
        additionalServices: {
          spiralBinding,
        },
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
      setFileData(null);
      setFilePageCount(null);
      setSpiralBinding(false);
      setConfigs([{ id: Date.now(), rangeStart: 1, rangeEnd: 1, copies: 1, colorMode: 'bw', sides: 'single' }]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
      setUploadStep('');
    }
  };

  // Calculate frontend cost estimate
  const estimatedCost = () => {
    let cost = 0;
    configs.forEach(c => {
      const start = Number(c.rangeStart) || 0;
      const end = Number(c.rangeEnd) || 0;
      const pagesInRange = Math.max(end - start + 1, 0);
      const rate = c.colorMode === 'color' ? 5 : 1;
      const effectiveSheets = c.sides === 'double' ? Math.ceil(pagesInRange / 2) : pagesInRange;
      cost += rate * effectiveSheets * (Number(c.copies) || 0);
    });
    // Add spiral binding estimate: ₹30 per document
    if (spiralBinding) {
      cost += 30;
    }
    return cost.toFixed(2);
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
                    onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                    className="hidden"
                    id="file-upload"
                    disabled={uploadStep !== ''}
                  />
                  <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
                    <Upload className="mx-auto h-10 w-10 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {uploadStep ? uploadStep : (file ? `✅ ${file.name}` : 'Click to upload or drag & drop')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">PDF, DOC, JPG, PNG (Max 20MB)</p>
                  </label>
                </div>
              </div>

              {manualCountRequired && (
                <div className="rounded-xl border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800 space-y-3">
                  <p className="font-medium">Please enter the total number of pages for your DOC/DOCX file.</p>
                  <p className="text-xs text-yellow-700">If this value is wrong, the order will use the page count you provide and printed pages may be incomplete or incorrect.</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label>Total Pages</Label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={filePageCount ?? ''}
                        onChange={(e) => handleManualPageCountChange(e.target.value)}
                        className="mt-1 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="confirm-manual-pages"
                      type="checkbox"
                      checked={manualCountConfirmed}
                      onChange={(e) => setManualCountConfirmed(e.target.checked)}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <label htmlFor="confirm-manual-pages" className="text-sm text-yellow-900">
                      I confirm this page count is correct for my document.
                    </label>
                  </div>
                </div>
              )}

              {/* Advanced Range-Based Printing Options */}
              {filePageCount && (
                <div className="space-y-4">
                  <div className="rounded-xl bg-blue-500/10 border border-blue-500/30 p-4">
                    <p className="text-sm text-blue-700 dark:text-blue-400">
                      📄 <strong>{filePageCount} pages detected</strong> - Configure printing options for each page range
                    </p>
                  </div>

                  {/* Spi Binding Toggle */}
                  <div className="flex items-center gap-3 rounded-lg border border-border p-4 bg-secondary/20">
                    <input
                      type="checkbox"
                      id="spiral-binding"
                      checked={spiralBinding}
                      onChange={(e) => setSpiralBinding(e.target.checked)}
                      className="h-5 w-5 rounded border-border cursor-pointer"
                    />
                    <label htmlFor="spiral-binding" className="cursor-pointer flex-1">
                      <p className="font-medium">Add Spiral Binding</p>
                      <p className="text-xs text-muted-foreground">₹30 - Durable binding for all pages</p>
                    </label>
                    {spiralBinding && <span className="text-sm font-semibold text-primary">+₹30</span>}
                  </div>

                  {/* Per-Range Configurations */}
                  {configs.map((config, index) => (
                    <div key={config.id} className="relative rounded-xl border border-border p-5 bg-secondary/30">
                      <div className="flex items-center justify-between mb-4 border-b border-border/50 pb-3">
                        <div>
                          <h4 className="font-semibold text-primary">Page Range {index + 1}</h4>
                          <p className="text-xs text-muted-foreground">Configure this section individually</p>
                        </div>
                        {configs.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeConfig(config.id)}
                            className="text-red-500 hover:text-red-600 transition-colors p-2"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>

                      <div className="grid gap-4 sm:grid-cols-4">
                        {/* Range Start */}
                        <div>
                          <Label className="text-xs">Start Page</Label>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={filePageCount}
                            value={config.rangeStart}
                            required
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') {
                                updateConfig(config.id, 'rangeStart', '');
                                return;
                              }
                              const val = Number(raw);
                              const maxEnd = config.rangeEnd === '' ? filePageCount : Number(config.rangeEnd);
                              if (!Number.isNaN(val) && val >= 1 && val <= filePageCount && val <= maxEnd) {
                                updateConfig(config.id, 'rangeStart', val);
                              }
                            }}
                            className="mt-1 text-sm"
                          />
                        </div>

                        {/* Range End */}
                        <div>
                          <Label className="text-xs">End Page</Label>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={config.rangeStart || 1}
                            max={effectivePageCount}
                            value={config.rangeEnd}
                            required
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') {
                                updateConfig(config.id, 'rangeEnd', '');
                                return;
                              }
                              const val = Number(raw);
                              const minStart = config.rangeStart === '' ? 1 : Number(config.rangeStart);
                              if (!Number.isNaN(val) && val >= minStart && val <= effectivePageCount) {
                                updateConfig(config.id, 'rangeEnd', val);
                              }
                            }}
                            className="mt-1 text-sm"
                          />
                        </div>

                        {/* Copies */}
                        <div>
                          <Label className="text-xs">Copies</Label>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={100}
                            value={config.copies}
                            required
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') {
                                updateConfig(config.id, 'copies', '');
                                return;
                              }
                              const val = Number(raw);
                              if (!Number.isNaN(val) && val >= 1 && val <= 100) {
                                updateConfig(config.id, 'copies', val);
                              }
                            }}
                            className="mt-1 text-sm"
                          />
                        </div>

                        {/* Sides */}
                        <div>
                          <Label className="text-xs">Print Sides</Label>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            {['single', 'double'].map((side) => (
                              <button
                                key={side}
                                type="button"
                                onClick={() => updateConfig(config.id, 'sides', side)}
                                className={`rounded border px-2 py-1.5 text-xs font-medium transition-all ${
                                  config.sides === side
                                    ? 'border-primary bg-primary/20 text-primary'
                                    : 'border-border text-muted-foreground hover:bg-secondary'
                                }`}
                              >
                                {side === 'single' ? 'Single' : 'Double'}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Color Mode - Full Width */}
                        <div className="sm:col-span-4">
                          <Label className="text-xs">Color Mode</Label>
                          <div className="mt-1 grid grid-cols-2 gap-3">
                            {['bw', 'color'].map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => updateConfig(config.id, 'colorMode', mode)}
                                className={`rounded-lg border-2 px-4 py-2 text-sm font-medium transition-all ${
                                  config.colorMode === mode
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border text-muted-foreground hover:bg-secondary'
                                }`}
                              >
                                {mode === 'bw' ? '⬛ B&W (₹1/sheet)' : '🌈 Color (₹5/sheet)'}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Range Summary - Enhanced Visual */}
                        <div className="sm:col-span-4 rounded-lg border-2 p-4 transition-all" style={{
                          borderColor: config.colorMode === 'color' ? '#ef4444' : '#6b7280',
                          backgroundColor: config.colorMode === 'color' ? '#fef2f2' : '#f9fafb'
                        }}>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="text-center">
                              <p className="text-xs text-muted-foreground font-medium mb-1">Pages</p>
                              <p className="font-bold text-sm">{config.rangeStart || '?'}-{config.rangeEnd || '?'}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">({Math.max(Number(config.rangeEnd) - Number(config.rangeStart) + 1, 0)} pages)</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-muted-foreground font-medium mb-1">Copies</p>
                              <p className="font-bold text-sm">{Number(config.copies) || '?'}x</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-muted-foreground font-medium mb-1">Color</p>
                              <p className="font-bold text-sm">{config.colorMode === 'color' ? '🌈 Color' : '⬛ B&W'}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-muted-foreground font-medium mb-1">Sides</p>
                              <p className="font-bold text-sm">{config.sides === 'double' ? '📄📄 Double' : '📄 Single'}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-dashed flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors"
                    onClick={addConfig}
                    disabled={!effectivePageCount}
                  >
                    <Plus className="h-4 w-4" /> Add Another Page Range
                  </Button>
                </div>
              )}

              {/* Help Text */}

              <div className="rounded-xl bg-secondary/50 border border-border px-4 py-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium">📍 Shop</span>
                  <span className="font-semibold">{shopInfo?.name || (SHOP_ID ? 'AISSMS College Xerox Centre' : '⚠️ Shop not linked')}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{SHOP_ID ? 'Shop availability' : 'No shop selected'}</span>
                  {SHOP_ID ? (
                    shopInfo ? (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${shopInfo.isOpen ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {shopInfo.isOpen ? '🟢 Open' : '🔴 Closed'}
                      </span>
                    ) : (
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-secondary text-muted-foreground">Checking status...</span>
                    )
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl bg-secondary p-4">
                <span className="font-medium">Estimated Cost</span>
                <span className="font-heading text-xl font-bold text-primary">₹{estimatedCost()}</span>
              </div>

              <Button
                type="submit"
                className="w-full sunrise-gradient text-primary-foreground sunrise-shadow-sm"
                disabled={submitting || !SHOP_ID || shopInfo?.isOpen === false}
              >
                {!SHOP_ID
                  ? '⚠️ Shop Not Found'
                  : shopInfo?.isOpen === false
                  ? '🔴 Shop Closed'
                  : submitting
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