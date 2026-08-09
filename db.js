import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure Orders folder exists
const ordersDir = path.join(__dirname, 'Orders');
if (!fs.existsSync(ordersDir)) {
  fs.mkdirSync(ordersDir, { recursive: true });
}

// Get file path for a specific date (YYYY-MM-DD)
const getOrdersFilePath = (dateStr) => {
  const date = dateStr || new Date().toISOString().split('T')[0];
  return path.join(ordersDir, `orders-${date}.json`);
};

// Helper to read orders for a date
const readOrdersForDate = (dateStr) => {
  const filePath = getOrdersFilePath(dateStr);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return [];
  }
};

// Helper to write orders for a date atomically
const writeOrdersForDate = (dateStr, orders) => {
  const filePath = getOrdersFilePath(dateStr);
  const tempPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tempPath, JSON.stringify(orders, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
};

// Save a new order to today's file
export const saveOrder = async (orderData) => {
  const today = new Date().toISOString().split('T')[0];
  const orders = readOrdersForDate(today);

  const newOrder = {
    id: orderData.id || 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    type: orderData.type || 'dine_in',
    tableNumber: orderData.tableNumber || '',
    customerName: orderData.customerName || 'Guest',
    phone: orderData.phone || '',
    address: orderData.address || '',
    mapUrl: orderData.mapUrl || '',
    subtotal: orderData.subtotal || 0,
    bogoDiscount: orderData.bogoDiscount || 0,
    serviceCharge: orderData.serviceCharge !== undefined 
      ? orderData.serviceCharge 
      : (orderData.taxes !== undefined && !orderData.serviceCharge ? orderData.taxes : Math.round(Math.max(0, (orderData.subtotal || 0) - (orderData.bogoDiscount || 0)) * 0.10 * 100) / 100),
    taxes: orderData.taxes !== undefined ? orderData.taxes : (orderData.serviceCharge || 0),
    grandTotal: orderData.grandTotal || 0,
    status: orderData.status || 'pending', // 'pending' | 'preparing' | 'ready' | 'completed' | 'cancelled'
    date: today,
    createdAt: orderData.createdAt || new Date().toISOString(),
    items: orderData.items || []
  };

  orders.unshift(newOrder); // Newest first
  writeOrdersForDate(today, orders);
  return newOrder;
};

// Get today's orders
export const getTodayOrders = async () => {
  const today = new Date().toISOString().split('T')[0];
  return readOrdersForDate(today);
};

// Get a single order by ID (searches today's orders, root orders.json, and archive files)
export const getOrderById = async (orderId) => {
  const today = new Date().toISOString().split('T')[0];
  const orders = readOrdersForDate(today);
  let found = orders.find(o => o.id === orderId);
  if (found) return found;

  // Search root orders.json
  const mainPath = path.join(__dirname, 'orders.json');
  if (fs.existsSync(mainPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(mainPath, 'utf-8') || '[]');
      found = data.find(o => o.id === orderId);
      if (found) return found;
    } catch(e) {}
  }

  // Search across all files in Orders folder if not in today
  if (fs.existsSync(ordersDir)) {
    const files = fs.readdirSync(ordersDir).filter(f => f.startsWith('orders-') && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(ordersDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
        found = data.find(o => o.id === orderId);
        if (found) return found;
      } catch(e) {}
    }
  }
  return null;
};

// Update order status across files
export const updateOrderStatus = async (orderId, newStatus) => {
  const files = fs.readdirSync(ordersDir).filter(f => f.startsWith('orders-') && f.endsWith('.json'));
  
  for (const file of files) {
    const dateStr = file.replace('orders-', '').replace('.json', '');
    const orders = readOrdersForDate(dateStr);
    const orderIndex = orders.findIndex(o => o.id === orderId);

    if (orderIndex !== -1) {
      orders[orderIndex].status = newStatus;
      orders[orderIndex].updatedAt = new Date().toISOString();
      writeOrdersForDate(dateStr, orders);
      return { order: orders[orderIndex] };
    }
  }

  throw new Error(`Order ${orderId} not found`);
};

// Get Past Orders History (grouped by date excluding today or including all)
export const getPastOrdersHistory = async () => {
  const files = fs.readdirSync(ordersDir).filter(f => f.startsWith('orders-') && f.endsWith('.json'));
  const history = [];

  for (const file of files) {
    const dateStr = file.replace('orders-', '').replace('.json', '');
    const orders = readOrdersForDate(dateStr);
    
    if (orders.length > 0) {
      const totalRevenue = orders.reduce((sum, o) => sum + (o.grandTotal || 0), 0);
      const completedCount = orders.filter(o => o.status === 'completed').length;
      
      history.push({
        date: dateStr,
        totalOrders: orders.length,
        completedOrders: completedCount,
        totalRevenue
      });
    }
  }

  // Sort by date descending
  history.sort((a, b) => new Date(b.date) - new Date(a.date));
  return history;
};

// Get detailed orders for a specific past date
export const getOrdersByDate = async (dateStr) => {
  return readOrdersForDate(dateStr);
};

// ==========================================
// TABLE RESERVATIONS SYSTEM PERSISTENCE
// ==========================================

const reservationsDir = path.join(__dirname, 'Reservations');
if (!fs.existsSync(reservationsDir)) {
  fs.mkdirSync(reservationsDir, { recursive: true });
}

const getReservationsFilePath = (dateStr) => {
  const date = dateStr || new Date().toISOString().split('T')[0];
  return path.join(reservationsDir, `reservations-${date}.json`);
};

const readReservationsForDate = (dateStr) => {
  const filePath = getReservationsFilePath(dateStr);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return [];
  }
};

const writeReservationsForDate = (dateStr, reservations) => {
  const filePath = getReservationsFilePath(dateStr);
  const tempPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tempPath, JSON.stringify(reservations, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    return false;
  }
};

export const saveReservation = async (data) => {
  const today = new Date().toISOString().split('T')[0];
  const dateStr = data.date || today;
  const reservations = readReservationsForDate(dateStr);

  const newReservation = {
    id: data.id || 'RES-' + Math.floor(100000 + Math.random() * 900000),
    customerName: data.customerName || data.name || 'Guest',
    phone: data.phone || '',
    date: dateStr,
    time: data.time || '18:00',
    guests: data.guests || '2 Guests',
    specialNotes: data.specialNotes || '',
    status: data.status || 'pending', // 'pending' | 'confirmed' | 'seated' | 'cancelled'
    createdAt: data.createdAt || new Date().toISOString()
  };

  reservations.unshift(newReservation);
  writeReservationsForDate(dateStr, reservations);
  return newReservation;
};

export const getTodayReservations = async () => {
  const today = new Date().toISOString().split('T')[0];
  return readReservationsForDate(today);
};

export const getAllReservations = async () => {
  const files = fs.existsSync(reservationsDir) ? fs.readdirSync(reservationsDir).filter(f => f.startsWith('reservations-') && f.endsWith('.json')) : [];
  let all = [];
  for (const file of files) {
    const dateStr = file.replace('reservations-', '').replace('.json', '');
    const list = readReservationsForDate(dateStr);
    all = all.concat(list);
  }
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return all;
};

export const updateReservationStatus = async (id, newStatus) => {
  const files = fs.existsSync(reservationsDir) ? fs.readdirSync(reservationsDir).filter(f => f.startsWith('reservations-') && f.endsWith('.json')) : [];
  for (const file of files) {
    const dateStr = file.replace('reservations-', '').replace('.json', '');
    const reservations = readReservationsForDate(dateStr);
    const index = reservations.findIndex(r => r.id === id);
    if (index !== -1) {
      reservations[index].status = newStatus;
      reservations[index].updatedAt = new Date().toISOString();
      writeReservationsForDate(dateStr, reservations);
      return { reservation: reservations[index] };
    }
  }
  throw new Error(`Reservation ${id} not found`);
};

// ==========================================
// MENU ITEM STOCK MANAGEMENT HELPERS
// ==========================================
const stockFilePath = path.join(__dirname, 'stock.json');

export const getMenuStock = () => {
  if (!fs.existsSync(stockFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(stockFilePath, 'utf-8') || '{}');
  } catch (e) {
    return {};
  }
};

export const updateMenuStock = (itemId, inStock) => {
  const stock = getMenuStock();
  stock[itemId] = inStock;
  fs.writeFileSync(stockFilePath, JSON.stringify(stock, null, 2), 'utf-8');
  return stock;
};

