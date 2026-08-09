import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Structured Data Directories
const dataDir = path.join(__dirname, 'Data');
const ordersDir = path.join(dataDir, 'Orders');
const reservationsDir = path.join(dataDir, 'Reservations');
const menuDir = path.join(dataDir, 'Menu');
const stockDir = path.join(dataDir, 'Stock');

[dataDir, ordersDir, reservationsDir, menuDir, stockDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// File paths
const menuStorePath = path.join(menuDir, 'menuStore.json');
const itemHistoryCatalogPath = path.join(menuDir, 'itemHistoryCatalog.json');
const stockFilePath = path.join(stockDir, 'stock.json');

// Get file path for a specific date (YYYY-MM-DD)
const getOrdersFilePath = (dateStr) => {
  const date = dateStr || new Date().toISOString().split('T')[0];
  return path.join(ordersDir, `orders-${date}.json`);
};

// Helper to read orders for a date
const readOrdersForDate = (dateStr) => {
  const filePath = getOrdersFilePath(dateStr);
  if (!fs.existsSync(filePath)) {
    // Migration check from old ServerSide/Orders directory
    const oldPath = path.join(__dirname, 'Orders', `orders-${dateStr}.json`);
    if (fs.existsSync(oldPath)) {
      try {
        const oldData = fs.readFileSync(oldPath, 'utf-8');
        fs.writeFileSync(filePath, oldData);
        return JSON.parse(oldData || '[]');
      } catch (e) {}
    }
    return [];
  }
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
  
  const sub = Number(orderData.subtotal || 0);
  const bogo = Number(orderData.bogoDiscount || 0);
  const netSub = Math.max(0, sub - bogo);
  const sc = orderData.serviceCharge !== undefined 
    ? Number(orderData.serviceCharge)
    : (orderData.taxes !== undefined ? Number(orderData.taxes) : Math.round(netSub * 0.10 * 100) / 100);
  const gt = orderData.grandTotal !== undefined ? Number(orderData.grandTotal) : netSub + sc;

  const newOrder = {
    id: orderData.id || `ORD-${Math.floor(100000 + Math.random() * 900000)}`,
    type: orderData.type || 'dine_in',
    tableNumber: orderData.tableNumber || null,
    customerName: orderData.customerName || 'Customer',
    phone: orderData.phone || '',
    address: orderData.address || '',
    paymentMethod: orderData.paymentMethod || 'Cash (Paid)',
    items: orderData.items || [],
    subtotal: sub,
    bogoDiscount: bogo,
    serviceCharge: sc,
    taxes: sc,
    grandTotal: gt,
    status: orderData.status || 'pending',
    createdAt: orderData.createdAt || new Date().toISOString()
  };

  orders.unshift(newOrder);
  writeOrdersForDate(today, orders);
  return newOrder;
};

// Fetch all orders for today
export const getTodayOrders = async () => {
  const today = new Date().toISOString().split('T')[0];
  return readOrdersForDate(today);
};

// Fetch order by ID
export const getOrderById = async (orderId) => {
  const today = new Date().toISOString().split('T')[0];
  let orders = readOrdersForDate(today);
  let found = orders.find((o) => o.id === orderId);
  if (found) return found;

  const rootPath = path.join(__dirname, 'orders.json');
  if (fs.existsSync(rootPath)) {
    try {
      const rootOrders = JSON.parse(fs.readFileSync(rootPath, 'utf-8') || '[]');
      found = rootOrders.find((o) => o.id === orderId);
      if (found) return found;
    } catch (e) {}
  }

  const files = fs.readdirSync(ordersDir);
  for (const file of files) {
    if (file.startsWith('orders-') && file.endsWith('.json')) {
      const filePath = path.join(ordersDir, file);
      try {
        const fileOrders = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
        found = fileOrders.find((o) => o.id === orderId);
        if (found) return found;
      } catch (e) {}
    }
  }
  return null;
};

// Update status of an existing order
export const updateOrderStatus = async (orderId, status) => {
  const today = new Date().toISOString().split('T')[0];
  let orders = readOrdersForDate(today);
  const index = orders.findIndex((o) => o.id === orderId);

  if (index !== -1) {
    orders[index].status = status;
    orders[index].updatedAt = new Date().toISOString();
    writeOrdersForDate(today, orders);
    return orders[index];
  }

  const files = fs.readdirSync(ordersDir);
  for (const file of files) {
    if (file.startsWith('orders-') && file.endsWith('.json')) {
      const filePath = path.join(ordersDir, file);
      try {
        const fileOrders = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
        const idx = fileOrders.findIndex((o) => o.id === orderId);
        if (idx !== -1) {
          fileOrders[idx].status = status;
          fileOrders[idx].updatedAt = new Date().toISOString();
          const tempPath = filePath + '.tmp';
          fs.writeFileSync(tempPath, JSON.stringify(fileOrders, null, 2), 'utf-8');
          fs.renameSync(tempPath, filePath);
          return fileOrders[idx];
        }
      } catch (e) {}
    }
  }
  return null;
};

// Get list of past dates with summaries
export const getPastOrdersHistory = async () => {
  if (!fs.existsSync(ordersDir)) return [];
  const files = fs.readdirSync(ordersDir);
  const history = [];

  for (const file of files) {
    if (file.startsWith('orders-') && file.endsWith('.json')) {
      const dateStr = file.replace('orders-', '').replace('.json', '');
      const filePath = path.join(ordersDir, file);
      try {
        const fileOrders = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
        const totalRevenue = fileOrders.reduce((sum, o) => sum + (o.grandTotal || 0), 0);
        history.push({
          date: dateStr,
          totalOrders: fileOrders.length,
          totalRevenue: Math.round(totalRevenue * 100) / 100
        });
      } catch (e) {}
    }
  }
  return history.sort((a, b) => b.date.localeCompare(a.date));
};

// Get orders for a specific date
export const getOrdersByDate = async (dateStr) => {
  return readOrdersForDate(dateStr);
};

// Table Reservations Helper
const reservationsFilePath = path.join(reservationsDir, 'reservations.json');

export const saveReservation = async (resData) => {
  let reservations = [];
  if (fs.existsSync(reservationsFilePath)) {
    try {
      reservations = JSON.parse(fs.readFileSync(reservationsFilePath, 'utf-8') || '[]');
    } catch (e) {}
  }
  const newRes = {
    id: `RES-${Math.floor(1000 + Math.random() * 9000)}`,
    ...resData,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  reservations.unshift(newRes);
  fs.writeFileSync(reservationsFilePath, JSON.stringify(reservations, null, 2));
  return newRes;
};

export const getTodayReservations = async () => {
  if (!fs.existsSync(reservationsFilePath)) return [];
  try {
    const reservations = JSON.parse(fs.readFileSync(reservationsFilePath, 'utf-8') || '[]');
    const todayStr = new Date().toISOString().split('T')[0];
    return reservations.filter(r => r.date === todayStr);
  } catch (e) {
    return [];
  }
};

export const getAllReservations = async () => {
  if (!fs.existsSync(reservationsFilePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(reservationsFilePath, 'utf-8') || '[]');
  } catch (e) {
    return [];
  }
};

export const updateReservationStatus = async (resId, status) => {
  if (!fs.existsSync(reservationsFilePath)) return null;
  try {
    const reservations = JSON.parse(fs.readFileSync(reservationsFilePath, 'utf-8') || '[]');
    const idx = reservations.findIndex(r => r.id === resId);
    if (idx !== -1) {
      reservations[idx].status = status;
      fs.writeFileSync(reservationsFilePath, JSON.stringify(reservations, null, 2));
      return reservations[idx];
    }
  } catch (e) {}
  return null;
};

// Dynamic Menu Store Management
export const getMenuStore = () => {
  if (!fs.existsSync(menuStorePath)) {
    return { categories: [], items: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(menuStorePath, 'utf-8') || '{"categories":[],"items":[]}');
  } catch (e) {
    return { categories: [], items: [] };
  }
};

export const saveMenuStore = (store) => {
  const tempPath = menuStorePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
  fs.renameSync(tempPath, menuStorePath);
  return store;
};

export const getItemHistoryCatalog = () => {
  if (!fs.existsSync(itemHistoryCatalogPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(itemHistoryCatalogPath, 'utf-8') || '[]');
  } catch (e) {
    return [];
  }
};

export const addMenuItem = (itemData) => {
  const store = getMenuStore();
  const newId = itemData.id || `item-${Date.now()}`;
  const newItem = {
    id: newId,
    name: itemData.name,
    category: itemData.category || 'pizzas',
    price: Number(itemData.price || 0),
    mediumPrice: itemData.mediumPrice ? Number(itemData.mediumPrice) : null,
    hasSizes: Boolean(itemData.mediumPrice),
    sizes: itemData.mediumPrice ? [
      { size: 'Regular', price: Number(itemData.price || 0) },
      { size: 'Medium', price: Number(itemData.mediumPrice) }
    ] : null,
    isBogoEligible: Boolean(itemData.isBogoEligible),
    description: itemData.description || '',
    isVeg: itemData.isVeg !== undefined ? itemData.isVeg : true,
    rating: 4.8,
    prepTime: itemData.prepTime || '10 min',
    image: itemData.image || '/assets/images/pizza.png',
    inStock: true
  };

  store.items.unshift(newItem);
  saveMenuStore(store);

  // Add to item history catalog as seed
  let catalog = getItemHistoryCatalog();
  if (!catalog.some(c => c.name.toLowerCase() === newItem.name.toLowerCase())) {
    catalog.unshift(newItem);
    fs.writeFileSync(itemHistoryCatalogPath, JSON.stringify(catalog, null, 2));
  }

  return store;
};

export const updateMenuItem = (itemId, updates) => {
  const store = getMenuStore();
  const idx = store.items.findIndex(i => i.id === itemId);
  if (idx !== -1) {
    store.items[idx] = { ...store.items[idx], ...updates };
    if (updates.price || updates.mediumPrice) {
      if (store.items[idx].mediumPrice) {
        store.items[idx].sizes = [
          { size: 'Regular', price: Number(store.items[idx].price) },
          { size: 'Medium', price: Number(store.items[idx].mediumPrice) }
        ];
      }
    }
    saveMenuStore(store);
  }
  return store;
};

export const deleteMenuItem = (itemId) => {
  const store = getMenuStore();
  store.items = store.items.filter(i => i.id !== itemId);
  saveMenuStore(store);
  return store;
};

export const addMenuCategory = (categoryData) => {
  const store = getMenuStore();
  const newCat = {
    id: categoryData.id || `cat-${Date.now()}`,
    name: categoryData.name
  };
  if (!store.categories.some(c => c.id === newCat.id)) {
    store.categories.push(newCat);
    saveMenuStore(store);
  }
  return store;
};

// Stock Management Helper
export const getMenuStock = () => {
  if (fs.existsSync(stockFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(stockFilePath, 'utf-8') || '{}');
    } catch (e) {}
  }
  const store = getMenuStore();
  const map = {};
  store.items.forEach(i => { map[i.id] = i.inStock !== false; });
  return map;
};

export const updateMenuStock = (itemId, inStock) => {
  const map = getMenuStock();
  map[itemId] = inStock;
  fs.writeFileSync(stockFilePath, JSON.stringify(map, null, 2));
  updateMenuItem(itemId, { inStock });
  return map;
};
