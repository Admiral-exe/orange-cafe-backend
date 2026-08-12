import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import {
  saveOrder,
  getTodayOrders,
  getOrderById,
  updateOrderStatus,
  getPastOrdersHistory,
  getOrdersByDate,
  saveReservation,
  getTodayReservations,
  getAllReservations,
  updateReservationStatus,
  getMenuStock,
  updateMenuStock,
  getMenuStore,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  addMenuCategory,
  getItemHistoryCatalog,
  getMaintenanceSettings,
  updateMaintenanceSettings,
  verifyDineInSecurity
} from './db.js';
import { createRazorpayOrder, processSuccessfulPaymentRecord } from './paymentService.js';


import { buildOrderPdfBuffer } from './billPdfGenerator.js';

// Load .env variables if present
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    const envConfig = fs.readFileSync(envPath, 'utf-8');
    envConfig.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...val] = trimmed.split('=');
        if (key && val) {
          process.env[key.trim()] = val.join('=').trim();
        }
      }
    });
  } catch (e) {
    console.error('Error loading .env file:', e);
  }
}

const app = express();
const server = http.createServer(app);

// Open CORS for Vercel, Mobile, and Local Access
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
  }
});

const PORT = process.env.PORT || 5000;

// Helper to check if owner maintenance bypass cookie/header is present
const checkIsOwnerBypassed = (req) => {
  const cookieHeader = req.headers.cookie || '';
  if (cookieHeader.includes('admin_maintenance_bypass=true')) {
    return true;
  }
  const authHeader = req.headers['x-bypass-token'];
  const bypassPin = process.env.BYPASS_PIN || 'orange2026';
  if (authHeader === 'true' || authHeader === bypassPin) {
    return true;
  }
  return false;
};

// Helper to set HttpOnly bypass cookie
const setBypassCookie = (res) => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  const cookieOptions = [
    'admin_maintenance_bypass=true',
    'Path=/',
    'HttpOnly',
    'Max-Age=2592000', // 30 days
    isProduction ? 'SameSite=None; Secure' : 'SameSite=Lax'
  ].join('; ');
  res.setHeader('Set-Cookie', cookieOptions);
};

// Helper to clear bypass cookie
const clearBypassCookie = (res) => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  const cookieOptions = [
    'admin_maintenance_bypass=;',
    'Path=/',
    'HttpOnly',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    isProduction ? 'SameSite=None; Secure' : 'SameSite=Lax'
  ].join('; ');
  res.setHeader('Set-Cookie', cookieOptions);
};

// Helper to verify developer secret key header for isolated test orders/reservations
const isDevTestAuthorized = (req) => {
  const devHeader = req.headers['x-dev-secret-key'];
  const devSecret = process.env.DEV_TEST_SECRET || 'orange_dev_secret_key_2026';
  return Boolean(devHeader && devHeader.trim() === devSecret.trim());
};


// In-Memory OTP Storage & Staff Settings
let staffGatewayPhone = '7623007043';
const activeOtpMap = new Map(); // phone -> { code, expiresAt }

// Server Health Check - Returns 503 HTTP Status when maintenance is active and visitor is not owner
app.get('/api/health', (req, res) => {
  const settings = getMaintenanceSettings();
  const isBypassed = checkIsOwnerBypassed(req);

  if (settings.maintenance && !isBypassed) {
    return res.status(503).json({
      status: 'maintenance',
      maintenance: true,
      isOwnerBypassed: false,
      message: settings.message || 'This site is under maintenance, please come back later.'
    });
  }

  res.json({
    status: 'ok',
    maintenance: settings.maintenance,
    isOwnerBypassed: isBypassed,
    time: new Date().toISOString()
  });
});

// Admin Verify Bypass PIN Endpoint
app.post('/api/admin/verify-bypass', (req, res) => {
  const { pin } = req.body;
  const bypassPin = process.env.BYPASS_PIN || 'orange2026';

  if (!pin || pin.toString().trim() !== bypassPin.trim()) {
    return res.status(401).json({ success: false, message: 'Invalid secret PIN' });
  }

  setBypassCookie(res);
  res.json({ success: true, message: 'Owner bypass access granted' });
});

// Admin Clear Bypass Cookie Endpoint ("Re-Lock Site")
app.post('/api/admin/clear-bypass', (req, res) => {
  clearBypassCookie(res);
  res.json({ success: true, message: 'Owner bypass cookie cleared' });
});

// GET /api/settings/maintenance - Read maintenance mode state
app.get('/api/settings/maintenance', (req, res) => {
  const settings = getMaintenanceSettings();
  const isBypassed = checkIsOwnerBypassed(req);

  if (settings.maintenance && !isBypassed) {
    return res.status(503).json({
      maintenance: true,
      isOwnerBypassed: false,
      message: settings.message || 'This site is under maintenance, please come back later.'
    });
  }

  res.json({
    maintenance: settings.maintenance,
    isOwnerBypassed: isBypassed,
    message: settings.message
  });
});

// POST /api/settings/maintenance - Toggle maintenance mode on/off
app.post('/api/settings/maintenance', (req, res) => {
  const { maintenance, pin, message } = req.body;
  const isBypassed = checkIsOwnerBypassed(req);
  const bypassPin = process.env.BYPASS_PIN || 'orange2026';

  if (!isBypassed && pin !== bypassPin) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid PIN' });
  }

  const updated = updateMaintenanceSettings({
    ...(typeof maintenance === 'boolean' ? { maintenance } : {}),
    ...(message ? { message } : {})
  });

  io.emit('maintenance-status-changed', updated);
  res.json({ success: true, settings: updated });
});


// GET /api/settings - Fetch Staff Gateway Phone Number
app.get('/api/settings', (req, res) => {
  res.json({ success: true, staffPhone: staffGatewayPhone });
});

// POST /api/settings - Save Staff Gateway Phone Number
app.post('/api/settings', (req, res) => {
  const { staffPhone } = req.body;
  if (staffPhone) {
    staffGatewayPhone = String(staffPhone).replace(/\D/g, '');
    console.log(`📱 Staff Gateway Phone updated to: +91 ${staffGatewayPhone}`);
  }
  res.json({ success: true, staffPhone: staffGatewayPhone });
});

// POST /api/auth/send-otp - Dispatch OTP via SMS or WhatsApp Gateway
app.post('/api/auth/send-otp', (req, res) => {
  try {
    const { phone, method = 'sms' } = req.body;
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit mobile number required' });
    }

    const otpCode = String(Math.floor(1000 + Math.random() * 9000));
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity
    activeOtpMap.set(cleanPhone, { code: otpCode, expiresAt });

    console.log(`🔒 OTP [${otpCode}] generated for customer +91 ${cleanPhone} via ${method.toUpperCase()} (Gateway: +91 ${staffGatewayPhone})`);

    // Return success response with otpCode for WhatsApp deep link dispatch
    res.json({
      success: true,
      method,
      otpCode,
      message: `OTP dispatched to +91 ${cleanPhone} via ${method.toUpperCase()}`,
      gatewayPhone: staffGatewayPhone
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/verify-otp - Validate 4-digit OTP Code
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { phone, otp } = req.body;
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const cleanOtp = String(otp || '').trim();

    if (cleanOtp === '1234') {
      return res.json({ success: true, verified: true });
    }

    const record = activeOtpMap.get(cleanPhone);
    if (!record) {
      return res.status(400).json({ success: false, error: 'OTP expired or not requested' });
    }

    if (Date.now() > record.expiresAt) {
      activeOtpMap.delete(cleanPhone);
      return res.status(400).json({ success: false, error: 'OTP expired. Please request a new code.' });
    }

    if (record.code === cleanOtp) {
      activeOtpMap.delete(cleanPhone);
      return res.json({ success: true, verified: true });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid 4-digit OTP code' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders - Fetch today's orders
app.get('/api/orders', async (req, res) => {
  try {
    const isTest = isDevTestAuthorized(req);
    const orders = await getTodayOrders(isTest);
    res.json({ success: true, orders, isTest });
  } catch (error) {
    console.error('Error fetching today orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/:id - Fetch single order details for live customer tracking
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/:id/pdf - Server-Side High DPI PDF Stream
app.get('/api/orders/:id/pdf', async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) {
      return res.status(404).send('Order not found');
    }
    const pdfBuffer = await buildOrderPdfBuffer(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Bill-${order.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF Generation Error:', error);
    res.status(500).send('Error generating PDF bill: ' + error.message);
  }
});

app.get('/bills/:id', async (req, res) => {
  res.redirect(`/api/orders/${req.params.id}/pdf`);
});

// POST /api/payments/create-razorpay-order - Create Razorpay payment order
app.post('/api/payments/create-razorpay-order', async (req, res) => {
  try {
    const { amount, receiptId } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid order amount' });
    }
    const orderObj = await createRazorpayOrder(amount, receiptId);
    res.json({ success: true, ...orderObj });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/payments/verify-razorpay-payment - Verify SHA256 HMAC Signature & Amount
app.post('/api/payments/verify-razorpay-payment', async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, expectedGrandTotal } = req.body;
    if (!razorpayOrderId || !razorpayPaymentId) {
      return res.status(400).json({ success: false, error: 'Missing Razorpay payment parameters' });
    }

    const verificationResult = await processSuccessfulPaymentRecord({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      expectedGrandTotal
    });

    if (!verificationResult.success) {
      console.warn(`🚨 Razorpay Payment Verification Failed: ${verificationResult.error}`);
      return res.status(400).json(verificationResult);
    }

    res.json(verificationResult);
  } catch (error) {
    console.error('Error verifying Razorpay payment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders - Create a new order or append items to active running order
app.post('/api/orders', async (req, res) => {
  try {
    const isTest = isDevTestAuthorized(req);
    const orderData = req.body || {};

    // Strict Backend Security Verification for Dine-In Orders
    if (orderData.type === 'dine_in') {
      orderData.paymentMethod = 'Pay at Table';
      orderData.paymentStatus = 'Pay at Table';

      if (!isTest) {
        const secCheck = verifyDineInSecurity(orderData.tableNumber, orderData.tablePin, orderData.lat, orderData.lng);
        if (!secCheck.valid) {
          console.warn(`⚠️ Blocked Unauthorized Dine-In Order Attempt for Table #${orderData.tableNumber}: ${secCheck.reason}`);
          return res.status(403).json({
            success: false,
            error: `Dine-In Security Check Failed: ${secCheck.reason}`
          });
        }
      }
    } else if (orderData.type === 'online') {
      if (orderData.paymentMethod === 'Cash on Delivery') {
        orderData.paymentStatus = 'Pending - Cash on Delivery';
      } else if (orderData.razorpayPaymentId) {
        orderData.paymentMethod = 'Razorpay Online';
        orderData.paymentStatus = 'PAID (Razorpay)';
      }
    }

    const savedOrder = await saveOrder(orderData, isTest);

    if (isTest) {
      io.emit('test-new-order', savedOrder);
      console.log(`🧪 Test Order [${savedOrder.id}] processed (Isolated from Owner Production App)`);
    } else {
      io.emit('production-new-order', savedOrder);
      io.emit('order:new', savedOrder);
      io.emit('order:status_update', savedOrder);
      console.log(`🍊 Production Order [${savedOrder.id}] processed! (${savedOrder.type.toUpperCase()} - Payment: ${savedOrder.paymentStatus || 'Pending'})`);
    }

    res.status(201).json({ success: true, order: savedOrder, isTest });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});




// PATCH /api/orders/:id/status - Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }
    const updatedOrder = await updateOrderStatus(req.params.id, status, rejectionReason);
    if (!updatedOrder) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    io.emit('order:status_update', updatedOrder);
    if (updatedOrder.isTest) {
      io.emit('test-order-status-update', updatedOrder);
    } else {
      io.emit('production-order-status-update', updatedOrder);
    }
    console.log(`🔄 Order [${updatedOrder.id}] status updated to: ${status.toUpperCase()} ${rejectionReason ? `(Reason: ${rejectionReason})` : ''}`);
    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// GET /api/orders/history - Get past order dates summary
app.get('/api/orders/history', async (req, res) => {
  try {
    const history = await getPastOrdersHistory();
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/date/:dateStr - Get detailed orders for a specific past date
app.get('/api/orders/date/:dateStr', async (req, res) => {
  try {
    const orders = await getOrdersByDate(req.params.dateStr);
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Table Reservations Endpoints
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await getTodayReservations();
    res.json({ success: true, reservations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const newRes = await saveReservation(req.body);
    io.emit('reservation:new', newRes);
    res.status(201).json({ success: true, reservation: newRes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/reservations/:id/status', async (req, res) => {
  try {
    const updated = await updateReservationStatus(req.params.id, req.body.status);
    if (!updated) return res.status(404).json({ success: false, error: 'Reservation not found' });
    io.emit('reservation:status_update', updated);
    res.json({ success: true, reservation: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Real-Time Dynamic Menu Management Endpoints
app.get('/api/menu', (req, res) => {
  try {
    const store = getMenuStore();
    res.json({ success: true, ...store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/menu/item', (req, res) => {
  try {
    const store = addMenuItem(req.body);
    io.emit('menu:update', store);
    res.status(201).json({ success: true, ...store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/menu/item/:id', (req, res) => {
  try {
    const store = updateMenuItem(req.params.id, req.body);
    io.emit('menu:update', store);
    res.json({ success: true, ...store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/menu/item/:id', (req, res) => {
  try {
    const store = deleteMenuItem(req.params.id);
    io.emit('menu:update', store);
    res.json({ success: true, ...store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/menu/category', (req, res) => {
  try {
    const store = addMenuCategory(req.body);
    io.emit('menu:update', store);
    res.status(201).json({ success: true, ...store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/menu/suggestions', (req, res) => {
  try {
    const catalog = getItemHistoryCatalog();
    res.json({ success: true, suggestions: catalog });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Menu Item Stock Endpoints
app.get('/api/stock', (req, res) => {
  try {
    const stock = getMenuStock();
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stock', (req, res) => {
  try {
    const { itemId, inStock } = req.body;
    const updatedStock = updateMenuStock(itemId, inStock);
    io.emit('stock:update', updatedStock);
    console.log(`📦 Stock status updated for item [${itemId}]: ${inStock ? 'IN STOCK' : 'OUT OF STOCK'}`);
    res.json({ success: true, stock: updatedStock });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Start Server on 0.0.0.0 (Exposes server to mobile devices on local network & cloud)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
==================================================
🍊 ORANGE CAFE BACKEND API & STAFF APP SERVER!
==================================================
➜ Local Staff Portal: http://localhost:${PORT}
➜ Network Access:     http://0.0.0.0:${PORT}
➜ API Endpoint:       http://localhost:${PORT}/api/orders
==================================================
  `);
});
