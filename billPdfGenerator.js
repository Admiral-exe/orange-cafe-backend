import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildOrderPdfBuffer(order) {
  return new Promise((resolve, reject) => {
    const subtotal = order.subtotal || 0;
    const bogoDiscount = order.bogoDiscount || 0;
    const netSubtotal = Math.max(0, subtotal - bogoDiscount);
    const serviceCharge = order.serviceCharge !== undefined 
      ? order.serviceCharge 
      : (order.taxes !== undefined ? order.taxes : Math.round(netSubtotal * 0.10 * 100) / 100);
    const grandTotal = order.grandTotal || (netSubtotal + serviceCharge);

    const items = order.items || [];

    // Pre-calculate exact heights using temporary measurer doc
    const dummyDoc = new PDFDocument({ margin: 10, size: [250, 3000] });
    dummyDoc.fontSize(7.5).font('Helvetica');

    let itemTableHeight = 0;
    items.forEach((item, idx) => {
      const h = dummyDoc.heightOfString(`${idx + 1}. ${item.name}`, { width: 105 });
      itemTableHeight += Math.max(h, 12) + 3;
    });

    const boxContentHeight = 125 + itemTableHeight + (bogoDiscount > 0 ? 14 : 0);
    const totalPageHeight = Math.ceil(240 + boxContentHeight + 60);

    const doc = new PDFDocument({ 
      margin: 10, 
      size: [250, totalPageHeight],
      autoFirstPage: true 
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Header Logo & Name
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 45, 12, { width: 22 });
      doc.fontSize(13).font('Helvetica-Bold').text('ORANGE CAFE', 75, 16);
    } else {
      doc.fontSize(13).font('Helvetica-Bold').text('ORANGE CAFE', { align: 'center' });
    }

    doc.y = 42;

    // Metadata 2-column layout
    const yStart = doc.y;
    doc.fontSize(7.5).font('Helvetica');
    
    // Left column
    doc.fillColor('#555555').text('Order Number', 20, yStart);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9.5).text((order.id || '').replace('ORD-', ''), 20, yStart + 10);

    doc.fillColor('#555555').font('Helvetica').fontSize(7.5).text('Order amount', 20, yStart + 26);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9.5).text(`Rs.${Number(grandTotal).toFixed(0)}`, 20, yStart + 36);

    doc.fillColor('#555555').font('Helvetica').fontSize(7.5).text('Biller Name', 20, yStart + 52);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.5).text('biller', 20, yStart + 62);

    // Right column
    doc.fillColor('#555555').font('Helvetica').fontSize(7.5).text('Date', 130, yStart);
    const dateFormatted = order.createdAt ? new Date(order.createdAt).toLocaleString('en-IN') : new Date().toLocaleString('en-IN');
    doc.fillColor('#000000').font('Helvetica').fontSize(8).text(dateFormatted, 130, yStart + 10);

    doc.fillColor('#555555').font('Helvetica').fontSize(7.5).text('Order type', 130, yStart + 36);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.5).text(order.type === 'dine_in' ? `Dine In: ${order.tableNumber || 1}` : 'Online Delivery', 130, yStart + 46);

    doc.y = yStart + 78;
    
    // Customer Details
    doc.fillColor('#555555').fontSize(7.5).font('Helvetica').text('Customer Details', 20, doc.y);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text(order.customerName || 'Customer', 20, doc.y + 10);
    doc.font('Helvetica').fontSize(8.5).text(order.phone || '', 20, doc.y + 22);
    
    doc.y = doc.y + 36;

    // Receipt Box with Dynamic Height
    const boxY = doc.y;

    doc.rect(15, boxY, 220, boxContentHeight).strokeColor('#cbd5e1').lineWidth(0.8).stroke();
    
    doc.fontSize(7.5).font('Helvetica-Bold').text('GF-38, BAKROL SQUARE, BAKROL,', 20, boxY + 6, { align: 'center', width: 210 });
    doc.text('V V NAGAR ANAND - 388115', 20, boxY + 16, { align: 'center', width: 210 });
    doc.text('M- 07623007043', 20, boxY + 26, { align: 'center', width: 210 });

    doc.moveTo(20, boxY + 36).lineTo(230, boxY + 36).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

    // Items table header
    doc.fontSize(7.5).font('Helvetica-Bold').text('No. Name', 20, boxY + 40);
    doc.text('Qty.', 130, boxY + 40);
    doc.text('Rate(Rs.)', 158, boxY + 40);
    doc.text('Price(Rs.)', 192, boxY + 40);

    doc.moveTo(20, boxY + 50).lineTo(230, boxY + 50).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

    let itemY = boxY + 54;
    let totalQty = 0;

    items.forEach((item, idx) => {
      totalQty += item.quantity;
      doc.fontSize(7.5).font('Helvetica').text(`${idx + 1}. ${item.name}`, 20, itemY, { width: 105 });
      doc.text(`${item.quantity}`, 132, itemY);
      doc.text(`${item.price}`, 162, itemY);
      doc.text(`${item.price * item.quantity}`, 196, itemY);
      
      const itemHeight = doc.heightOfString(`${idx + 1}. ${item.name}`, { width: 105 });
      itemY += Math.max(itemHeight, 12) + 3;
    });

    doc.moveTo(20, itemY).lineTo(230, itemY).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    itemY += 6;

    doc.fontSize(7.5).font('Helvetica-Bold').text('Quantity', 20, itemY);
    doc.text(`${totalQty}`, 200, itemY);
    itemY += 12;

    doc.font('Helvetica').text('Sub Total', 20, itemY);
    doc.text(`Rs.${Number(subtotal).toFixed(2)}`, 180, itemY);
    itemY += 12;

    if (bogoDiscount > 0) {
      doc.font('Helvetica-Bold').fillColor('#15803d').text('Discount (Fixed)', 20, itemY);
      doc.text(`-Rs.${Number(bogoDiscount).toFixed(2)}`, 180, itemY);
      doc.fillColor('#000000');
      itemY += 12;
    }

    doc.font('Helvetica').text('Service Charge (10%)', 20, itemY);
    doc.text(`Rs.${Number(serviceCharge).toFixed(2)}`, 180, itemY);
    itemY += 14;

    doc.moveTo(20, itemY).lineTo(230, itemY).strokeColor('#94a3b8').lineWidth(0.5).stroke();
    itemY += 6;

    doc.font('Helvetica-Bold').fontSize(8.5).text('Total Payable Amount:', 20, itemY);
    doc.text(`Rs.${Number(grandTotal).toFixed(2)}`, 175, itemY);
    itemY += 14;

    doc.font('Helvetica').fontSize(7.5).text(`Payment mode (${order.status === 'completed' ? 'Paid' : 'Not Paid'})`, 20, itemY);

    doc.fontSize(7.5).font('Helvetica').text('Thank you for Choosing Us. Please Visit again', 20, boxY + boxContentHeight + 10, { align: 'center', width: 210 });

    doc.end();
  });
}
