import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { orderAPI } from '@/lib/api';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Printer, ArrowLeft, CheckCircle2, FileText, Settings2, RefreshCw, AlertCircle } from 'lucide-react';

const WebPrintAgent = () => {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [docUrl, setDocUrl] = useState(null);
  const [updating, setUpdating] = useState(false);
  const iframeRef = useRef(null);

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        const res = await orderAPI.getById(orderId);
        const fetchedOrder = res.data.data?.order || res.data.order;
        setOrder(fetchedOrder);

        // Fetch document URL if exists
        if (fetchedOrder.documents?.[0]) {
          const urlRes = await orderAPI.getDocumentUrl(fetchedOrder._id, fetchedOrder.documents[0]._id);
          setDocUrl(urlRes.data.data?.downloadUrl);
        }
      } catch (err) {
        toast.error('Failed to load order for printing');
      } finally {
        setLoading(false);
      }
    };
    fetchDetails();
  }, [orderId]);

  const handlePrint = async () => {
    try {
      toast.info('Sending to Desktop Print Agent...');
      // 1. Signal backend (socket.io)
      await orderAPI.triggerPrint(orderId);
      // 2. Open/Focus desktop app via deep link
      window.location.href = `smartxerox://print/${orderId}`;
      toast.success('Print signal sent! Desktop Agent should now be processing.');
    } catch (err) {
      toast.error('Failed to reach Desktop Print Agent. Make sure the Smart Xerox Print Agent app is running on this PC.');
    }
  };


  const handleMarkReady = async () => {
    setUpdating(true);
    try {
      await orderAPI.updateStatus(orderId, 'ready');
      toast.success('Order marked as Ready! OTP sent to customer.');
      navigate('/shop');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update order status');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <Navbar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />
            Loading print agent...
          </div>
        </div>
      </div>
    );
  }

  if (!order || !order.documents?.[0]) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <Navbar />
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <div>
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">No Document Found</h2>
            <p className="text-muted-foreground mb-6">Could not load the document for this order.</p>
            <Button variant="outline" onClick={() => navigate('/shop')}>Return to Dashboard</Button>
          </div>
        </div>
      </div>
    );
  }

  const doc = order.documents[0];
  const printOpts = doc.printingOptions || doc;
  const copies = parseInt(printOpts.copies || doc.copies || 1);
  const colorMode = printOpts.colorMode || doc.colorType || 'bw';
  const paperSize = printOpts.paperSize || doc.paperSize || 'A4';
  const sides = printOpts.sides || (doc.doubleSided ? 'double' : 'single');

  return (
    <div className="min-h-screen bg-background flex flex-col overflow-hidden">
      <Navbar />
      
      {/* Top Action Bar */}
      <div className="border-b bg-card/50 backdrop-blur-md sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate('/shop')} className="gap-2 shrink-0">
            <ArrowLeft className="h-4 w-4" /> Back to Queue
          </Button>
          
          <div className="text-center hidden sm:block">
            <h1 className="font-heading font-bold text-lg flex items-center gap-2 justify-center">
              <Printer className="h-5 w-5 text-primary" /> Web Print Agent
            </h1>
            <p className="text-xs text-muted-foreground">Order #{order.orderNumber || order._id.slice(-6).toUpperCase()}</p>
          </div>

          <Button 
            onClick={handleMarkReady} 
            disabled={updating}
            className="bg-green-600 hover:bg-green-700 text-white gap-2 shrink-0"
          >
            {updating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            <span className="hidden sm:inline">Mark as Printed & Ready</span>
            <span className="sm:hidden">Done</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row container mx-auto p-4 gap-6 h-[calc(100vh-140px)]">
        
        {/* Left Panel: Settings */}
        <div className="w-full lg:w-[350px] shrink-0 flex flex-col gap-6 overflow-y-auto pr-2">
          
          <div className="glass-card p-5 border-l-4 border-l-primary">
            <h3 className="font-semibold flex items-center gap-2 mb-4 text-primary">
              <Settings2 className="h-5 w-5" /> Print Specifications
            </h3>
            
            <div className="space-y-4">
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-sm text-muted-foreground">Copies</span>
                <span className="font-mono text-lg font-bold">{copies}</span>
              </div>
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-sm text-muted-foreground">Color Mode</span>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${colorMode === 'color' ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-800'}`}>
                  {colorMode === 'color' ? 'Color' : 'Black & White'}
                </span>
              </div>
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-sm text-muted-foreground">Sides</span>
                <span className={`text-sm font-semibold capitalize ${sides === 'double' ? 'text-primary' : ''}`}>
                  {sides}-Sided
                </span>
              </div>
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-sm text-muted-foreground">Paper Size</span>
                <span className="text-sm font-semibold uppercase">{paperSize}</span>
              </div>
            </div>

            <div className="mt-6">
              <Button onClick={handlePrint} size="lg" className="w-full sunrise-gradient text-primary-foreground font-bold shadow-lg gap-2 text-lg h-14 hover:scale-[1.02] transition-transform">
                <Printer className="h-6 w-6" /> Send to Desktop Agent
              </Button>
              <p className="text-[10px] text-center text-muted-foreground mt-3">
                Sends the document and specs to the <strong>Smart Xerox Print Agent</strong> desktop app running on this PC.
              </p>
            </div>
          </div>

          <div className="glass-card p-4 text-sm">
            <h4 className="font-semibold flex items-center gap-1.5 mb-2">
              <FileText className="h-4 w-4 text-muted-foreground" /> Customer Note
            </h4>
            <p className="text-muted-foreground italic bg-secondary/50 p-3 rounded-lg border">
              {order.specialInstructions || "No special instructions provided."}
            </p>
          </div>

        </div>

        {/* Right Panel: PDF Viewer */}
        <div className="flex-1 glass-card overflow-hidden flex flex-col shadow-inner bg-secondary/20 relative">
          <div className="p-3 border-b bg-card absolute top-0 w-full z-10 flex justify-between items-center shadow-sm">
             <span className="text-sm font-medium truncate max-w-[300px]">{doc.originalName || 'document.pdf'}</span>
             <a href={docUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Open in new tab ↗</a>
          </div>
          <div className="flex-1 mt-12 w-full h-full p-2">
            {docUrl ? (
              <iframe 
                ref={iframeRef}
                src={docUrl} 
                className="w-full h-full rounded border bg-white shadow-sm"
                title="PDF Preview"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground bg-secondary/30 rounded border border-dashed">
                <RefreshCw className="h-6 w-6 animate-spin mr-2" /> Loading PDF securely...
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default WebPrintAgent;
