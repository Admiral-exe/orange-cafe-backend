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
  updateMenuStock
} from './db.js';
import { buildOrderPdfBuffer } from './billPdfGenerator.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Server Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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

// GET /api/orders/history - Fetch past orders daily summary list
app.get('/api/orders/history', async (req, res) => {
  try {
    const history = await getPastOrdersHistory();
    res.json({ success: true, history });
  } catch (error) {
    console.error('Error fetching past orders history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/history/:date - Fetch detailed orders for a specific date
app.get('/api/orders/history/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const orders = await getOrdersByDate(date);
    res.json({ success: true, date, orders });
  } catch (error) {
    console.error('Error fetching orders for date:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/:id - Fetch single order live status
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderById(id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order });
  } catch (error) {
    console.error('Error fetching single order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/:id/pdf - Stream PDF Bill
app.get(['/api/orders/:id/pdf', '/bills/:id'], async (req, res) => {
  try {
    let { id } = req.params;
    if (id.endsWith('.pdf')) id = id.replace('.pdf', '');
    const order = await getOrderById(id);
    if (!order) {
      return res.status(404).send('Order not found');
    }

    const pdfBuffer = await buildOrderPdfBuffer(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=OrangeCafe_Bill_${order.id}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF bill:', error);
    res.status(500).send('Error generating PDF bill: ' + error.message);
  }
});

// POST /api/orders - Create new order (Dine-In or Online)
app.post('/api/orders', async (req, res) => {
  try {
    const orderPayload = req.body;
    
    if (!orderPayload.id) {
      orderPayload.id = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
    }
    orderPayload.createdAt = new Date().toISOString();
    orderPayload.status = orderPayload.status || 'pending';

    const saved = await saveOrder(orderPayload);

    // Broadcast Socket.io event to all staff screens
    io.emit('order:new', saved);
    console.log(`🍊 New Order [${saved.id}] received! (${saved.type.toUpperCase()})`);

    res.status(201).json({ success: true, order: saved });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/orders/:id/status - Staff status transition
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'preparing', 'ready', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const { order } = await updateOrderStatus(id, status);
    
    // Broadcast status change to staff and customer
    io.emit('order:status_update', { id, status, order });
    console.log(`🔄 Order [${id}] status updated to: ${status.toUpperCase()}`);

    res.json({ success: true, id, status, order });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// TABLE RESERVATIONS API ENDPOINTS
// ==========================================

// GET /api/reservations - Fetch table reservations
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await getAllReservations();
    res.json({ success: true, reservations });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reservations - Create table reservation
app.post('/api/reservations', async (req, res) => {
  try {
    const reservationPayload = req.body;
    const saved = await saveReservation(reservationPayload);

    // Broadcast socket event to staff
    io.emit('reservation:new', saved);
    console.log(`📅 New Table Reservation [${saved.id}] received from ${saved.customerName}!`);

    res.status(201).json({ success: true, reservation: saved });
  } catch (error) {
    console.error('Error saving reservation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/reservations/:id/status - Update reservation status
app.patch('/api/reservations/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const { reservation } = await updateReservationStatus(id, status);
    io.emit('reservation:status_update', { id, status, reservation });
    console.log(`🔄 Reservation [${id}] status updated to: ${status}`);

    res.json({ success: true, id, status, reservation });
  } catch (error) {
    console.error('Error updating reservation status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// MENU STOCK MANAGEMENT ENDPOINTS
// ==========================================
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

// Start Server on 0.0.0.0 (Exposes server to mobile devices on local network)
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
