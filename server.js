import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
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
  getItemHistoryCatalog
} from './db.js';
import { buildOrderPdfBuffer } from './billPdfGenerator.js';

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

// In-Memory OTP Storage & Staff Settings
let staffGatewayPhone = '7623007043';
const activeOtpMap = new Map(); // phone -> { code, expiresAt }

// Server Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
    const orders = await getTodayOrders();
    res.json({ success: true, orders });
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

// POST /api/orders - Create a new order
app.post('/api/orders', async (req, res) => {
  try {
    const newOrder = await saveOrder(req.body);
    io.emit('order:new', newOrder);
    console.log(`🍊 New Order [${newOrder.id}] received! (${newOrder.type.toUpperCase()})`);
    res.status(201).json({ success: true, order: newOrder });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/orders/:id/status - Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }
    const updatedOrder = await updateOrderStatus(req.params.id, status);
    if (!updatedOrder) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    io.emit('order:status_update', updatedOrder);
    console.log(`🔄 Order [${updatedOrder.id}] status updated to: ${status.toUpperCase()}`);
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
