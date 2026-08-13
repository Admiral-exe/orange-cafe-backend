import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Structured Data Directories
const dataDir = path.join(__dirname, 'Data');
const ordersDir = path.join(dataDir, 'Orders');
const testOrdersDir = path.join(dataDir, 'TestOrders');
const reservationsDir = path.join(dataDir, 'Reservations');
const testReservationsDir = path.join(dataDir, 'TestReservations');
const menuDir = path.join(dataDir, 'Menu');
const stockDir = path.join(dataDir, 'Stock');
const settingsDir = path.join(dataDir, 'Settings');

[dataDir, ordersDir, testOrdersDir, reservationsDir, testReservationsDir, menuDir, stockDir, settingsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// File paths
const menuStorePath = path.join(menuDir, 'menuStore.json');
const itemHistoryCatalogPath = path.join(menuDir, 'itemHistoryCatalog.json');
const stockFilePath = path.join(stockDir, 'stock.json');
const settingsFilePath = path.join(settingsDir, 'settings.json');

// Get file path for a specific date (YYYY-MM-DD)
const getOrdersFilePath = (dateStr, isTest = false) => {
  const date = dateStr || new Date().toISOString().split('T')[0];
  const targetDir = isTest ? testOrdersDir : ordersDir;
  const prefix = isTest ? 'test-orders' : 'orders';
  return path.join(targetDir, `${prefix}-${date}.json`);
};

// Helper to read orders for a date
const readOrdersForDate = (dateStr, isTest = false) => {
  const filePath = getOrdersFilePath(dateStr, isTest);
  if (!fs.existsSync(filePath)) {
    if (!isTest) {
      // Migration check from old ServerSide/Orders directory
      const oldPath = path.join(__dirname, 'Orders', `orders-${dateStr}.json`);
      if (fs.existsSync(oldPath)) {
        try {
          const oldData = fs.readFileSync(oldPath, 'utf-8');
          fs.writeFileSync(filePath, oldData);
          return JSON.parse(oldData || '[]');
        } catch (e) {}
      }
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

const writeOrdersForDate = (dateStr, orders, isTest = false) => {
  const filePath = getOrdersFilePath(dateStr, isTest);
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

// Save a new order or append items to an active running order for today
export const saveOrder = async (orderData, isTest = false) => {

  const today = new Date().toISOString().split('T')[0];
  const orders = readOrdersForDate(today, isTest);
  const isTestFlag = Boolean(isTest || orderData.isTest);

  // Check if an existing open order exists for this table (dine-in) or phone number (online) that is NOT closed/terminal
  const CLOSED_STATUSES = ['completed', 'rejected', 'cancelled'];
  let existingIndex = -1;
  if (orderData.type === 'dine_in' && orderData.tableNumber) {
    existingIndex = orders.findIndex(o =>
      o.type === 'dine_in' &&
      String(o.tableNumber) === String(orderData.tableNumber) &&
      !CLOSED_STATUSES.includes(o.status)
    );
  } else if (orderData.phone) {
    const cleanPhone = String(orderData.phone).replace(/\D/g, '');
    if (cleanPhone.length >= 10) {
      existingIndex = orders.findIndex(o =>
        (o.type || 'dine_in') === 'online' &&
        String(o.phone || '').replace(/\D/g, '') === cleanPhone &&
        !CLOSED_STATUSES.includes(o.status)
      );
    }
  }

  if (existingIndex !== -1) {
    // Append / merge items into existing active order
    const existingOrder = orders[existingIndex];
    const combinedItems = [...(existingOrder.items || [])];

    (orderData.items || []).forEach((newItem) => {
      const idx = combinedItems.findIndex(i => i.name === newItem.name && Number(i.price) === Number(newItem.price));
      if (idx !== -1) {
        combinedItems[idx].quantity += newItem.quantity;
      } else {
        combinedItems.push({ ...newItem });
      }
    });

    // Re-calculate financial totals for all combined items
    const sub = combinedItems.reduce((sum, i) => sum + (Number(i.price) * Number(i.quantity)), 0);
    
    // Calculate BOGO discount if applicable
    let bogoDiscount = 0;
    const bogoPrices = [];
    combinedItems.forEach(i => {
      if (i.name.toLowerCase().includes('pizza')) {
        for (let q = 0; q < i.quantity; q++) bogoPrices.push(Number(i.price));
      }
    });
    bogoPrices.sort((a, b) => a - b);
    const freeCount = Math.floor(bogoPrices.length / 2);
    for (let f = 0; f < freeCount; f++) bogoDiscount += bogoPrices[f];

    const afterDiscount = Math.max(0, sub - bogoDiscount);
    const sc = Math.round(afterDiscount * 0.025 * 100) / 100;
    const gt = Math.round((afterDiscount + (sc * 2)) * 100) / 100;

    existingOrder.items = combinedItems;
    existingOrder.subtotal = sub;
    existingOrder.bogoDiscount = bogoDiscount;
    existingOrder.serviceCharge = sc;
    existingOrder.taxes = sc;
    existingOrder.grandTotal = gt;
    existingOrder.updatedAt = new Date().toISOString();
    existingOrder.isTest = isTestFlag;
    if (orderData.paymentMethod) existingOrder.paymentMethod = orderData.paymentMethod;
    if (orderData.paymentStatus) existingOrder.paymentStatus = orderData.paymentStatus;
    if (orderData.razorpayPaymentId) existingOrder.razorpayPaymentId = orderData.razorpayPaymentId;
    if (orderData.razorpayOrderId) existingOrder.razorpayOrderId = orderData.razorpayOrderId;
    delete existingOrder.rejectionReason;

    writeOrdersForDate(today, orders, isTestFlag);
    return existingOrder;
  }

  // Create brand new order
  const fileOrders = readOrdersForDate(today, isTestFlag);
  const nextNumber = fileOrders.length + 1;
  const orderId = `#${nextNumber}`;

  const items = orderData.items || [];
  const sub = items.reduce((sum, i) => sum + (Number(i.price) * Number(i.quantity)), 0);
  
  let bogo = 0;
  const bp = [];
  items.forEach(i => {
    if (i.name.toLowerCase().includes('pizza')) {
      for (let q = 0; q < i.quantity; q++) bp.push(Number(i.price));
    }
  });
  bp.sort((a, b) => a - b);
  const fc = Math.floor(bp.length / 2);
  for (let f = 0; f < fc; f++) bogo += bp[f];

  const ad = Math.max(0, sub - bogo);
  const sc = Math.round(ad * 0.025 * 100) / 100;
  const gt = Math.round((ad + (sc * 2)) * 100) / 100;

  const newOrder = {
    id: orderId,
    type: orderData.type || 'dine_in',
    tableNumber: orderData.tableNumber || null,
    customerName: orderData.customerName || 'Customer',
    phone: orderData.phone || '',
    address: orderData.address || '',
    deliveryAddress: orderData.deliveryAddress || null,
    mapUrl: orderData.mapUrl || '',
    paymentMethod: orderData.paymentMethod || 'Cash (Paid)',
    paymentStatus: orderData.paymentStatus || (orderData.paymentMethod === 'Cash on Delivery' ? 'Pending - Cash on Delivery' : 'Paid'),
    razorpayPaymentId: orderData.razorpayPaymentId || null,
    razorpayOrderId: orderData.razorpayOrderId || null,
    items: items,
    subtotal: sub,
    bogoDiscount: bogo,
    serviceCharge: sc,
    taxes: sc,
    grandTotal: gt,
    status: orderData.status || 'pending',
    createdAt: orderData.createdAt || new Date().toISOString(),
    isTest: isTestFlag
  };

  orders.unshift(newOrder);
  writeOrdersForDate(today, orders, isTestFlag);
  return newOrder;
};

// Fetch all orders for today
export const getTodayOrders = async (isTest = false) => {
  const today = new Date().toISOString().split('T')[0];
  return readOrdersForDate(today, isTest);
};

// Helper for matching order IDs flexibly across formats (#1, 1, %231, ORD-1)
const isOrderIdMatch = (order, targetId) => {
  if (!order || !order.id || !targetId) return false;
  const rawTarget = String(targetId).trim().toLowerCase();
  const cleanTarget = decodeURIComponent(rawTarget).replace(/^#/, '');
  const rawCurrent = String(order.id).trim().toLowerCase();
  const cleanCurrent = rawCurrent.replace(/^#/, '');
  return rawCurrent === rawTarget || cleanCurrent === cleanTarget || rawCurrent === decodeURIComponent(rawTarget);
};

// Fetch order by ID
export const getOrderById = async (orderId) => {
  if (!orderId) return null;
  const today = new Date().toISOString().split('T')[0];

  // 1. Check today's production & test orders
  let orders = readOrdersForDate(today, false);
  let found = orders.find(o => isOrderIdMatch(o, orderId));
  if (found) return found;

  let testOrders = readOrdersForDate(today, true);
  found = testOrders.find(o => isOrderIdMatch(o, orderId));
  if (found) return found;

  // 2. Check legacy root orders.json
  const rootPath = path.join(__dirname, 'orders.json');
  if (fs.existsSync(rootPath)) {
    try {
      const rootOrders = JSON.parse(fs.readFileSync(rootPath, 'utf-8') || '[]');
      found = rootOrders.find(o => isOrderIdMatch(o, orderId));
      if (found) return found;
    } catch (e) {}
  }

  // 3. Check all historical files in ordersDir and testOrdersDir
  const searchDirs = [ordersDir, testOrdersDir];
  for (const targetDir of searchDirs) {
    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(targetDir, file);
          try {
            const fileOrders = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
            found = fileOrders.find(o => isOrderIdMatch(o, orderId));
            if (found) return found;
          } catch (e) {}
        }
      }
    }
  }
  return null;
};

// Update status of an existing order
export const updateOrderStatus = async (orderId, status, rejectionReason = '') => {
  if (!orderId) return null;
  const today = new Date().toISOString().split('T')[0];

  // 1. Check today's production orders
  let orders = readOrdersForDate(today, false);
  let index = orders.findIndex(o => isOrderIdMatch(o, orderId));
  if (index !== -1) {
    orders[index].status = status;
    if (rejectionReason) {
      orders[index].rejectionReason = rejectionReason;
    }
    orders[index].updatedAt = new Date().toISOString();
    writeOrdersForDate(today, orders, false);
    return orders[index];
  }

  // 2. Check today's test orders
  let testOrders = readOrdersForDate(today, true);
  index = testOrders.findIndex(o => isOrderIdMatch(o, orderId));
  if (index !== -1) {
    testOrders[index].status = status;
    if (rejectionReason) {
      testOrders[index].rejectionReason = rejectionReason;
    }
    testOrders[index].updatedAt = new Date().toISOString();
    writeOrdersForDate(today, testOrders, true);
    return testOrders[index];
  }

  // 3. Check historical order files
  const searchDirs = [ordersDir, testOrdersDir];
  for (const targetDir of searchDirs) {
    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(targetDir, file);
          try {
            const fileOrders = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '[]');
            const idx = fileOrders.findIndex(o => isOrderIdMatch(o, orderId));
            if (idx !== -1) {
              fileOrders[idx].status = status;
              if (rejectionReason) {
                fileOrders[idx].rejectionReason = rejectionReason;
              }
              fileOrders[idx].updatedAt = new Date().toISOString();
              const tempPath = filePath + '.tmp';
              fs.writeFileSync(tempPath, JSON.stringify(fileOrders, null, 2), 'utf-8');
              fs.renameSync(tempPath, filePath);
              return fileOrders[idx];
            }
          } catch (e) {}
        }
      }
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

// Default fallback categories if menuStore.json does not exist
const DEFAULT_MENU_CATEGORIES = [
  { id: 'pizzas', name: '🍕 Pizzas (BOGO Offer)' },
  { id: 'burgers', name: '🍔 Burgers' },
  { id: 'sandwiches', name: '🥪 Sandwiches' },
  { id: 'garlic_breads', name: '🧄 Garlic Breads' },
  { id: 'fries', name: '🍟 Fries' },
  { id: 'pastas', name: '🍝 Pastas' },
  { id: 'frankies', name: '🌯 Frankies' },
  { id: 'orange_drinks', name: '🍹 Orange Special Drinks' },
  { id: 'shakes_coffee', name: '🥤 Shakes & Coffee' },
  { id: 'combos', name: '🎁 Special Value Combos' }
];

// Dynamic Menu Store Management
export const getMenuStore = () => {
  let store = { categories: [], items: [] };
  if (fs.existsSync(menuStorePath)) {
    try {
      store = JSON.parse(fs.readFileSync(menuStorePath, 'utf-8') || '{"categories":[],"items":[]}');
    } catch (e) {}
  }

  const combinedCategories = [...DEFAULT_MENU_CATEGORIES];
  (store.categories || []).forEach(c => {
    if (!combinedCategories.some(existing => existing.id === c.id)) {
      combinedCategories.push(c);
    }
  });

  return {
    categories: combinedCategories,
    items: store.items || []
  };
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

// System Settings Helper
export const getMaintenanceSettings = () => {
  const defaultSettings = {
    maintenance: false,
    message: "This site is under maintenance, please come back later.",
    onlineDelivery: true
  };
  if (fs.existsSync(settingsFilePath)) {
    try {
      const content = fs.readFileSync(settingsFilePath, 'utf-8');
      return { ...defaultSettings, ...JSON.parse(content || '{}') };
    } catch (e) {
      return defaultSettings;
    }
  }
  return defaultSettings;
};

export const updateMaintenanceSettings = (newSettings) => {
  const current = getMaintenanceSettings();
  const updated = { ...current, ...newSettings };
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(updated, null, 2));
    return updated;
  } catch (e) {
    return current;
  }
};

// Geofence & Table PIN Security Constants & Verifier
export const SERVER_CAFE_LOCATION = {
  lat: 22.5532,
  lng: 72.9238,
  maxRadiusMeters: 100
};

export const SERVER_TABLE_PINS = {
  '1': '101',
  '2': '102',
  '3': '103',
  '4': '104',
  '5': '105',
  '6': '106'
};

export const calculateDistanceMeters = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
};

export const verifyDineInSecurity = (tableNumber, tablePin, lat, lng) => {
  const cleanTable = String(tableNumber || '1').trim();
  const cleanPin = String(tablePin || '').trim();

  // 1. Table PIN Check
  const expectedPin = SERVER_TABLE_PINS[cleanTable];
  if (expectedPin && cleanPin === expectedPin) {
    return { valid: true, method: 'TABLE_PIN', tableNumber: cleanTable };
  }

  // 2. Geofence Check
  if (lat && lng) {
    const dist = calculateDistanceMeters(Number(lat), Number(lng), SERVER_CAFE_LOCATION.lat, SERVER_CAFE_LOCATION.lng);
    if (dist <= SERVER_CAFE_LOCATION.maxRadiusMeters) {
      return { valid: true, method: 'GPS_GEOFENCE', distance: dist, tableNumber: cleanTable };
    }
    return {
      valid: false,
      reason: `GPS distance (${dist}m) exceeds ${SERVER_CAFE_LOCATION.maxRadiusMeters}m radius and Table PIN is invalid.`
    };
  }

  return {
    valid: false,
    reason: `Missing valid 3-digit Table PIN (e.g. ${expectedPin || '101'}) or GPS location.`
  };
};
