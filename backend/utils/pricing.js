/**
 * Helper to parse a page range string (e.g., '1-5,7,10-12') and return exact page count.
 */
function getPageCountFromRange(rangeStr, totalPages) {
  if (!rangeStr || rangeStr.toLowerCase() === 'all') return totalPages;
  const indices = new Set();
  const parts = rangeStr.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
        const actualEnd = Math.min(end, totalPages);
        for (let i = start; i <= actualEnd; i++) indices.add(i);
      }
    } else {
      const single = parseInt(trimmed, 10);
      if (!isNaN(single) && single > 0 && single <= totalPages) {
        indices.add(single);
      }
    }
  }
  return indices.size > 0 ? indices.size : totalPages;
}

/**
 * Calculate order pricing based on documents, shop pricing, and platform margin
 */
const calculateOrderPrice = (documents, shop, additionalServices = {}) => {
  let subtotal = 0;
  let totalPrintedSheets = 0;
  const documentPrices = [];

  documents.forEach((doc) => {
    const { printingRanges, detectedPages } = doc;
    let docPrice = 0;

    if (!printingRanges || printingRanges.length === 0) {
      // Fallback: if no ranges specified, treat as single range covering all pages
      printingRanges = [{
        rangeStart: 1,
        rangeEnd: detectedPages,
        copies: 1,
        colorMode: 'bw',
        sides: 'single'
      }];
    }

    // Process each printing range
    printingRanges.forEach((range) => {
      const { rangeStart, rangeEnd, copies, colorMode, sides } = range;
      const pagesInRange = rangeEnd - rangeStart + 1;
      
      // Effective sheets considering double-sided (only half sheets used)
      const effectiveSheets = sides === 'double' ? Math.ceil(pagesInRange / 2) : pagesInRange;
      totalPrintedSheets += effectiveSheets * copies;

      // Base price per sheet from shop with fallbacks
      const sidePriceKey = sides === 'double' ? 'doubleSided' : 'singleSided';
      const shopPricing = shop.pricing || {};
      const colorPricing = shopPricing[colorMode] || shopPricing['bw'] || {};
      const basePrice = colorPricing[sidePriceKey] || (colorMode === 'color' ? 5 : 1);

      docPrice += basePrice * effectiveSheets * copies;
    });

    documentPrices.push(docPrice);
    subtotal += docPrice;
  });

  // Additional services with updated pricing
  let additionalCharge = 0;
  const totalDocs = documents.length;

  if (additionalServices.spiralBinding) {
    additionalCharge += (shop.pricing.spiralBindingPerDocument || 30) * totalDocs;
  }
  if (additionalServices.lamination) {
    additionalCharge += (shop.pricing.laminationPerPage || 10) * totalPrintedSheets;
  }
  if (additionalServices.urgentPrinting) {
    additionalCharge += Math.ceil(subtotal * 0.2); // 20% urgent surcharge
  }

  // Platform margin
  const platformMarginAmount = Math.ceil(((subtotal + additionalCharge) * (shop.platformMargin || 0)) / 100);

  const total = subtotal + additionalCharge + platformMarginAmount;
  const shopReceivable = subtotal + additionalCharge;

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