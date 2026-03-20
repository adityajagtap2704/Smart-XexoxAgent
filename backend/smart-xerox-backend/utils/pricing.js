/**
 * Calculate order pricing based on documents, shop pricing, and platform margin
 */
const calculateOrderPrice = (documents, shop, additionalServices = {}) => {
  let subtotal = 0;
  const documentPrices = [];

  documents.forEach((doc) => {
    const { printingOptions, detectedPages } = doc;
    const pages = detectedPages || 1;
    const copies = printingOptions?.copies || 1;
    const colorMode = printingOptions?.colorMode || 'bw';
    const sides = printingOptions?.sides || 'single';

    // Effective pages considering double-sided
    const effectivePages = sides === 'double' ? Math.ceil(pages / 2) : pages;

    // Base price per page from shop
    const sidePriceKey = sides === 'double' ? 'doubleSided' : 'singleSided';
    const basePrice = shop.pricing[colorMode][sidePriceKey];

    const docPrice = basePrice * effectivePages * copies;
    documentPrices.push(docPrice);
    subtotal += docPrice;
  });

  // Additional services
  let additionalCharge = 0;
  const totalDocs = documents.length;
  const totalPages = documents.reduce((sum, d) => sum + (d.detectedPages || 1), 0);

  if (additionalServices.binding) {
    additionalCharge += (shop.pricing.bindingPerDocument || 20) * totalDocs;
  }
  if (additionalServices.lamination) {
    additionalCharge += (shop.pricing.laminationPerPage || 10) * totalPages;
  }
  if (additionalServices.urgentPrinting) {
    additionalCharge += Math.ceil(subtotal * 0.2); // 20% urgent surcharge
  }

  // Platform margin
  const platformMarginAmount = Math.ceil(((subtotal + additionalCharge) * (shop.platformMargin || 0)) / 100);

  const total = subtotal + additionalCharge + platformMarginAmount;
  const shopReceivable = subtotal + additionalCharge; // Shop gets base amount (margin goes to platform)

  return {
    subtotal,
    documentPrices,
    additionalCharge,
    platformMargin: platformMarginAmount,
    total,
    shopReceivable,
  };
};

/**
 * Get pricing breakdown text for display
 */
const getPricingBreakdown = (order) => {
  const lines = [];
  order.documents.forEach((doc, i) => {
    lines.push(`Document ${i + 1} (${doc.originalName}): ₹${doc.price}`);
  });
  if (order.pricing.additionalServicesCharge > 0) {
    lines.push(`Additional Services: ₹${order.pricing.additionalServicesCharge}`);
  }
  if (order.pricing.platformMargin > 0) {
    lines.push(`Platform Fee: ₹${order.pricing.platformMargin}`);
  }
  lines.push(`Total: ₹${order.pricing.total}`);
  return lines.join('\n');
};

module.exports = { calculateOrderPrice, getPricingBreakdown };
