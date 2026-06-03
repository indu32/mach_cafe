/**
 * MACH Cafe — server.js
 * Stack: Node.js · Express · better-sqlite3
 *
 * npm install express cors better-sqlite3 jsonwebtoken bcryptjs
 * node server.js
 *
 * Database viewer:
 *   npx @sqlite-viewer/app velvetbean.db   (browser UI)
 *   sqlite3 velvetbean.db                  (terminal)
 *
 * ── WHO USES WHAT ──────────────────────────────────────
 *  Guest   → static files only (index, menu, contact)
 *  Kitchen → static kitchen_inventory.html  (password: client-side)
 *  Cashier → static menu.html, printer_dashboard.html (password: client-side)
 *  Manager → all static pages              (password: client-side)
 *  Owner   → /api/owner/login (JWT) + all protected API routes
 * ───────────────────────────────────────────────────────
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

const app  = express();
const PORT = 3000;

// ── Change these two values before going live ──────────
const OWNER_PASSWORD_HASH = bcrypt.hashSync('velvetbean2024', 10);
const JWT_SECRET          = 'mach-cafe-secret-change-me';
// ───────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve SheetJS from node_modules so menu.html can load it locally (avoids CDN issues)
app.get('/xlsx.full.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
});

// ═══════════════════════════════════════════════════════
//  DATABASE SETUP
// ═══════════════════════════════════════════════════════

const db = new Database(path.join(__dirname, 'velvetbean.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── MIGRATION: add location column to existing DB if missing ──
(function migrate() {
  // Check if tables exist first — on a fresh DB they won't exist yet
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const hasInvoices    = tables.includes('invoices');
  const hasIngredients = tables.includes('ingredients');

  if (hasInvoices) {
    const invCols = db.pragma('table_info(invoices)').map(c => c.name);
    if (!invCols.includes('location')) {
      console.log('🔧  Migration: adding location to invoices…');
      db.exec(`ALTER TABLE invoices ADD COLUMN location TEXT NOT NULL DEFAULT 'guntupalli'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_loc ON invoices(location);`);
  }

  if (hasIngredients) {
    const ingCols = db.pragma('table_info(ingredients)').map(c => c.name);
    if (!ingCols.includes('location')) {
      console.log('🔧  Migration: adding location to ingredients…');
      db.exec(`ALTER TABLE ingredients ADD COLUMN location TEXT NOT NULL DEFAULT 'guntupalli'`);
    }
    if (!ingCols.includes('category')) {
      console.log('🔧  Migration: adding category to ingredients…');
      db.exec(`ALTER TABLE ingredients ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ing_loc ON ingredients(location);`);
  }

  if (!hasIngredients) return; // fresh DB — tables just created, no migration needed

  // ── "Espresso Beans" migration removed ────────────────────────────────────
  // This one-time migration (which replaced old fake ingredients with hardcoded
  // "real" Excel data) has been removed. Ingredients are now exclusively managed
  // via the DB (owner dashboard) and Excel uploads. No hardcoded re-seeding here.
  // ──────────────────────────────────────────────────────────────────────────

  // NOTE: Per-location ingredient cloning (ongole / kodaikanal) has also been
  // removed. Each location's inventory should be uploaded independently via Excel.
})();


db.exec(`
  /* ── Customers ─────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL UNIQUE,
    email      TEXT,
    address    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  /* ── Invoices ──────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS invoices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceNo   TEXT    NOT NULL UNIQUE,
    customerId  INTEGER NOT NULL REFERENCES customers(id),
    tableNo     TEXT    NOT NULL DEFAULT 'Counter',
    paymentMode TEXT    NOT NULL DEFAULT 'Cash',
    status      TEXT    NOT NULL DEFAULT 'PENDING',
    subtotal    INTEGER NOT NULL,
    cgst        INTEGER NOT NULL,
    sgst        INTEGER NOT NULL,
    grand       INTEGER NOT NULL,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  /* ── Order line-items ──────────────────────────────── */
  CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceId INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    qty       INTEGER NOT NULL,
    rate      INTEGER NOT NULL,
    amount    INTEGER NOT NULL
  );

  /* ── Ingredients master list ───────────────────────── */
  CREATE TABLE IF NOT EXISTS ingredients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    location     TEXT    NOT NULL DEFAULT 'guntupalli',
    name         TEXT    NOT NULL,
    unit         TEXT    NOT NULL DEFAULT 'units',
    currentQty   REAL    NOT NULL DEFAULT 0,
    reorderLevel REAL    NOT NULL DEFAULT 10,
    category     TEXT    NOT NULL DEFAULT 'Other',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(location, name)
  );

  /* ── Menu items ────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS menu_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    price       INTEGER NOT NULL,
    emoji       TEXT    NOT NULL DEFAULT '☕',
    section     TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT 'beverage',
    badge       TEXT,
    description TEXT,
    isFeatured  INTEGER NOT NULL DEFAULT 0,
    isAvailable INTEGER NOT NULL DEFAULT 1
  );

  /* ── Recipe: ingredients per menu item ─────────────── */
  CREATE TABLE IF NOT EXISTS menu_item_ingredients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    menuItemId    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredientId  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qtyPerServing REAL    NOT NULL DEFAULT 1,
    UNIQUE(menuItemId, ingredientId)
  );

  /* ── Ingredient movement log ───────────────────────── */
  CREATE TABLE IF NOT EXISTS inventory_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId    INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    logType   TEXT    NOT NULL,
    delta     REAL    NOT NULL,
    newQty    REAL    NOT NULL,
    note      TEXT,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  /* ── Parked Orders ─────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS parked_orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT    NOT NULL UNIQUE,
    location   TEXT    NOT NULL DEFAULT 'guntupalli',
    tableNo    TEXT    NOT NULL DEFAULT 'Counter',
    subtotal   INTEGER NOT NULL DEFAULT 0,
    gst        INTEGER NOT NULL DEFAULT 0,
    grand      INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'PARKED',
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS parked_order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    parkedOrderId INTEGER NOT NULL REFERENCES parked_orders(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    emoji         TEXT    NOT NULL DEFAULT '☕',
    qty           INTEGER NOT NULL,
    rate          INTEGER NOT NULL,
    amount        INTEGER NOT NULL
  );

  /* ── Indexes ────────────────────────────────────────── */
  CREATE INDEX IF NOT EXISTS idx_inv_cust  ON invoices(customerId);
  CREATE INDEX IF NOT EXISTS idx_inv_ts    ON invoices(timestamp);
  CREATE INDEX IF NOT EXISTS idx_oi_inv    ON order_items(invoiceId);
  CREATE INDEX IF NOT EXISTS idx_mii_item  ON menu_item_ingredients(menuItemId);
  CREATE INDEX IF NOT EXISTS idx_log_item  ON inventory_logs(itemId);
`);

// ── MIGRATION: replace generic seeded menu items with real menu ──
(function migrateMenu() {
  const hasOldMenu = db.prepare("SELECT 1 FROM menu_items WHERE name = 'Espresso' LIMIT 1").get();
  if (hasOldMenu) {
    console.log('🔄  Migration: replacing generic menu items with your real menu…');
    db.transaction(() => {
      db.prepare('DELETE FROM menu_item_ingredients').run();
      db.prepare('DELETE FROM menu_items').run();
    })();
    console.log('✅  Old menu cleared — real menu will be seeded on next step.');
  }
})();


// ═══════════════════════════════════════════════════════
//  SEED  — No hardcoded data. Menu items and ingredients
//  are managed entirely via the DB (owner dashboard) and
//  Excel upload. This function is intentionally a no-op.
// ═══════════════════════════════════════════════════════

function seed() {
  // Data is loaded from the database and Excel uploads — nothing to seed here.
  // Use the owner dashboard (/api/menu and /api/ingredients) to manage items,
  // or upload your Excel inventory via the kitchen inventory page.
  const menuCount = db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c;
  const ingCount  = db.prepare('SELECT COUNT(*) AS c FROM ingredients').get().c;
  console.log(`📋  DB ready — ${menuCount} menu items, ${ingCount} ingredients loaded from database.`);

  // ── DEAD CODE REMOVED ──────────────────────────────────────────────────────
  // Previously this function contained ~150 hardcoded ingredients and ~126
  // hardcoded menu items (all with price = 0). Those were placeholder/fake data
  // that conflicted with the real data coming from your DB and Excel uploads.
  //
  // DO NOT re-add hardcoded seed data here. All menu and ingredient management
  // should go through:
  //   • Owner dashboard API  → POST /api/menu, POST /api/ingredients
  //   • Excel upload         → POST /api/ingredients/import-excel
  // ──────────────────────────────────────────────────────────────────────────

}
// ═══════════════════════════════════════════════════════
//  AUTH MIDDLEWARE  — used by Owner-only API routes
// ═══════════════════════════════════════════════════════

function requireOwner(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'No token' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ═══════════════════════════════════════════════════════
//  API — OWNER LOGIN  (called by login.html for Owner card)
//  POST /api/owner/login  { password }
//  Returns { success, token }
// ═══════════════════════════════════════════════════════

app.post('/api/owner/login', (req, res) => {
  const { password } = req.body;
  if (!password || !bcrypt.compareSync(password, OWNER_PASSWORD_HASH))
    return res.status(401).json({ success: false, error: 'Wrong password' });

  const token = jwt.sign({ role: 'owner' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ success: true, token });
});

// ═══════════════════════════════════════════════════════
//  API — MENU  (Guest / Cashier / Manager / Owner)
// ═══════════════════════════════════════════════════════

/* GET full menu — public, used by menu.html */
app.get('/api/menu', (req, res) => {
  const items = db.prepare('SELECT * FROM menu_items ORDER BY section, name').all();
  res.json({ success: true, items });
});

/* GET single item */
app.get('/api/menu/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, item });
});

/* ADD menu item — Owner only */
app.post('/api/menu', requireOwner, (req, res) => {
  const { name, price, emoji, section, category, badge, description, isFeatured } = req.body;
  if (!name || !price || !section)
    return res.status(400).json({ success: false, error: 'name, price, section required' });
  const r = db.prepare(`
    INSERT INTO menu_items (name, price, emoji, section, category, badge, description, isFeatured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, price, emoji || '☕', section, category || 'beverage', badge || null, description || null, isFeatured ? 1 : 0);
  res.status(201).json({ success: true, id: r.lastInsertRowid });
});

/* UPDATE menu item — Owner only */
app.put('/api/menu/:id', requireOwner, (req, res) => {
  const old = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ success: false, error: 'Not found' });
  const { name, price, emoji, section, category, badge, description, isFeatured, isAvailable } = req.body;
  db.prepare(`
    UPDATE menu_items SET name=?, price=?, emoji=?, section=?, category=?, badge=?, description=?, isFeatured=?, isAvailable=? WHERE id=?
  `).run(
    name        ?? old.name,
    price       ?? old.price,
    emoji       ?? old.emoji,
    section     ?? old.section,
    category    ?? old.category,
    badge       ?? old.badge,
    description ?? old.description,
    isFeatured  != null ? (isFeatured ? 1 : 0) : old.isFeatured,
    isAvailable != null ? (isAvailable ? 1 : 0) : old.isAvailable,
    req.params.id
  );
  res.json({ success: true });
});

/* POST import menu from Excel — used by menu.html "Update Menu" button */
// Clears all existing menu items and re-inserts from the uploaded Excel.
// Handles duplicate names within same section by using "Name (Description)" as the stored name.
// Skips the header-instruction row (row 2 in your Excel) and the partial duplicate sheet at the bottom.
app.post('/api/menu/import-excel', (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  function parseBool(v, def) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return v !== 0;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }

  const errors   = [];
  const inserted = [];
  const validSections = new Set(['coffees','cold','shakes','food','snacks','desserts','icecreams','biscuits']);
  // Track names already inserted this import to detect duplicates within batch
  const seenNames = new Set();

  db.transaction(() => {
    // Clear existing items before fresh import
    db.prepare('DELETE FROM menu_items').run();

    for (const [idx, row] of rows.entries()) {
      // Normalise column names
      let name  = (row['Item Name'] || row.name  || row.Name  || '').toString().trim();
      const rawPrice = row['Price (INR)'] || row['price'] || row['Price'] || 0;
      const price = parseInt(rawPrice, 10);
      const section = (row['Section'] || row.section || row.Section || '').toString().trim().toLowerCase();
      const desc    = (row['Description'] || row.description || row.Description || '').toString().trim() || null;
      const emoji   = (row['Emoji'] || row.emoji || row.Emoji || '☕').toString().trim() || '☕';
      const rawBadge = (row['Badge'] || row.badge || row.Badge || '').toString().trim();
      // Fix typo in your Excel: "premiujm" → "premium"
      const badge = rawBadge ? rawBadge.replace('premiujm', 'premium') : null;
      const category = (row['Category'] || row.category || row.Category || 'beverage').toString().trim().toLowerCase();
      const isFeatured  = parseBool(row['Featured']    || row.isFeatured  || row.featured,  false) ? 1 : 0;
      const isAvailable = parseBool(row['Available']   || row.isAvailable || row.available, true)  ? 1 : 0;

      // Skip the instruction row (row 2 in your Excel: "Item Name (required)…")
      if (name === 'Item Name (required)' || name === 'Item Name') continue;
      if (!name)  { errors.push(`Row ${idx + 2}: missing name`);  continue; }
      if (!price) { errors.push(`Row ${idx + 2}: skipped "${name}" — no price`); continue; }
      if (!validSections.has(section)) {
        // Skip rows with no section (the duplicate sheet at bottom has no section column)
        if (!section) continue;
        errors.push(`Row ${idx + 2} "${name}": unknown section "${section}"`);
        continue;
      }

      // Handle duplicate names: append description in parentheses to make unique
      // e.g. "Salted (French Fries)" and "Salted (Smiles)"
      let uniqueName = name;
      if (seenNames.has(name.toLowerCase())) {
        uniqueName = desc ? `${name} (${desc})` : `${name} (${section})`;
      }
      // If still duplicate after appending desc, add a counter
      let attempt = uniqueName;
      let counter = 2;
      while (seenNames.has(attempt.toLowerCase())) {
        attempt = `${uniqueName} ${counter++}`;
      }
      uniqueName = attempt;
      seenNames.add(uniqueName.toLowerCase());

      db.prepare(`
        INSERT INTO menu_items (name, price, emoji, section, category, badge, description, isFeatured, isAvailable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uniqueName, price, emoji, section, category || 'beverage', badge, desc, isFeatured, isAvailable);
      inserted.push(uniqueName);
    }
  })();

  res.json({ success: true, inserted: inserted.length, errors });
});

/* DELETE menu item — Owner only */
app.delete('/api/menu/:id', requireOwner, (req, res) => {
  if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.id))
    return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  API — ORDERS / INVOICES  (Cashier / Manager / Owner)
// ═══════════════════════════════════════════════════════

/* Helper — build full invoice response with line-items */
function buildInvoiceResponse(inv) {
  const items = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customerId);
  return { ...inv, items, customer };
}

/* Helper — classify item as beverage or food for printer routing */
function classifyItem(name) {
  const n = name.toLowerCase();
  const beverageKeywords = ['coffee','latte','cappuccino','espresso','mocha','chai','matcha','brew','juice','smoothie','shake','soda','water','tea','frappe'];
  return beverageKeywords.some(k => n.includes(k)) ? 'beverage' : 'food';
}

/* Helper — auto-refresh isAvailable based on ingredient stock */
function refreshAvailability() {
  const items = db.prepare('SELECT id FROM menu_items').all();
  for (const item of items) {
    const links = db.prepare('SELECT i.currentQty, mii.qtyPerServing FROM menu_item_ingredients mii JOIN ingredients i ON mii.ingredientId = i.id WHERE mii.menuItemId = ?').all(item.id);
    const canMake = links.every(l => l.currentQty >= l.qtyPerServing);
    db.prepare('UPDATE menu_items SET isAvailable = ? WHERE id = ?').run(canMake ? 1 : 0, item.id);
  }
}

/* POST new order — Cashier / Manager / Owner */
app.post('/api/orders', (req, res) => {
  const { customerName, customerPhone, customerEmail, customerAddress, tableNo, paymentMode, items, location } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'items[] required' });

  const loc = (location || 'guntupalli').toLowerCase().trim();

  try {
    const result = db.transaction(() => {
      // Upsert customer — name and phone are optional (walk-in support)
      let customer;
      if (customerPhone) {
        customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(customerPhone);
      }
      if (!customer) {
        const insertName  = customerName  || 'Walk-in';
        const insertPhone = customerPhone || ('WALKIN-' + Date.now());
        const r = db.prepare('INSERT INTO customers (name, phone, email, address) VALUES (?, ?, ?, ?)').run(insertName, insertPhone, customerEmail || null, customerAddress || null);
        customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.lastInsertRowid);
      }

      // Build invoice number in MACH-YYMMDD-XXXX format
      const _d  = new Date();
      const _yy = String(_d.getFullYear() - 2000).padStart(2, '0');
      const _mm = String(_d.getMonth() + 1).padStart(2, '0');
      const _dd = String(_d.getDate()).padStart(2, '0');
      const _rnd = String(Math.floor(1000 + Math.random() * 9000));
      const invoiceNo = `MACH-${_yy}${_mm}${_dd}-${_rnd}`;
      const subtotal  = items.reduce((s, i) => s + i.qty * i.rate, 0);
      const cgst      = Math.round(subtotal * 0.025);
      const sgst      = Math.round(subtotal * 0.025);
      const grand     = subtotal + cgst + sgst;

      const inv = db.prepare(`
        INSERT INTO invoices (invoiceNo, location, customerId, tableNo, paymentMode, subtotal, cgst, sgst, grand)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(invoiceNo, loc, customer.id, tableNo || 'Counter', paymentMode || 'Cash', subtotal, cgst, sgst, grand);

      // Line-items + deduct ingredients
      for (const item of items) {
        const amount = item.qty * item.rate;
        db.prepare('INSERT INTO order_items (invoiceId, name, qty, rate, amount) VALUES (?, ?, ?, ?, ?)').run(inv.lastInsertRowid, item.name, item.qty, item.rate, amount);

        const menuItem = db.prepare('SELECT id FROM menu_items WHERE name = ?').get(item.name);
        if (menuItem) {
          const links = db.prepare('SELECT * FROM menu_item_ingredients WHERE menuItemId = ?').all(menuItem.id);
          for (const link of links) {
            const ing    = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(link.ingredientId);
            const newQty = Math.max(0, ing.currentQty - link.qtyPerServing * item.qty);
            db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, ing.id);
            db.prepare(`INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'order_deduction', ?, ?, ?)`).run(ing.id, -(link.qtyPerServing * item.qty), newQty, `Order ${invoiceNo} [${loc}]`);
          }
        }
      }

      return { invoiceNo, grand, invoiceId: inv.lastInsertRowid, customer };
    })();

    refreshAvailability();

    // Build and return the full invoice object so menu.html can display it immediately
    const savedInv    = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(result.invoiceNo);
    const fullInvoice = buildInvoiceResponse(savedInv);

    res.status(201).json({ success: true, invoiceNo: result.invoiceNo, grand: result.grand, invoice: fullInvoice });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* PATCH order status — Manager / Owner */
app.patch('/api/orders/:invoiceNo/status', (req, res) => {
  const { status } = req.body;
  if (!['PENDING','PREPARING','READY','DONE','CANCELLED'].includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });
  const inv = db.prepare('SELECT id FROM invoices WHERE invoiceNo = ?').get(req.params.invoiceNo);
  if (!inv) return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, inv.id);
  res.json({ success: true });
});

/* GET single invoice */
app.get('/api/invoices/:invoiceNo', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(req.params.invoiceNo);
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, invoice: buildInvoiceResponse(row) });
});

/* GET all customers — Manager / Owner */
app.get('/api/customers', (req, res) => {
  res.json({ success: true, customers: db.prepare('SELECT * FROM customers ORDER BY id DESC').all() });
});

/* GET customer by phone — Manager / Owner */
app.get('/api/customers/:phone', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(req.params.phone);
  if (!c) return res.status(404).json({ success: false, error: 'Not found' });
  const invs = db.prepare('SELECT * FROM invoices WHERE customerId = ? ORDER BY id DESC').all(c.id);
  res.json({ success: true, customer: c, invoices: invs.map(buildInvoiceResponse), totalOrders: invs.length });
});

/* GET today + all-time summary — Manager / Owner */
app.get('/api/summary', (req, res) => {
  const today     = new Date().toISOString().slice(0, 10);
  const todayInvs = db.prepare('SELECT * FROM invoices WHERE timestamp LIKE ?').all(today + '%');
  const allInvs   = db.prepare('SELECT * FROM invoices').all();
  const todayItems= todayInvs.flatMap(r => db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(r.id));
  res.json({
    success: true,
    today: {
      date: today,
      orders:    todayInvs.length,
      revenue:   todayInvs.reduce((s, i) => s + i.grand, 0),
      itemsSold: todayItems.reduce((s, i) => s + i.qty, 0),
    },
    allTime: {
      orders:    allInvs.length,
      revenue:   allInvs.reduce((s, i) => s + i.grand, 0),
      customers: db.prepare('SELECT COUNT(*) AS c FROM customers').get().c,
    },
  });
});

// ═══════════════════════════════════════════════════════
//  API — PRINTER ROUTING DASHBOARD  (Cashier / Manager / Owner)
// ═══════════════════════════════════════════════════════

app.get('/api/orders/routing', (req, res) => {
  try {
    const loc  = req.query.location || 'guntupalli';  // ← branch filter
    const args = [loc];

    // Always filter by location first, then optionally by date
    let q = 'SELECT inv.*, c.name AS custName, c.phone AS custPhone FROM invoices inv JOIN customers c ON inv.customerId = c.id WHERE inv.location = ?';
    if (req.query.date) { q += ' AND inv.timestamp LIKE ?'; args.push(req.query.date + '%'); }
    q += ' ORDER BY inv.id DESC';

    const invoices = db.prepare(q).all(...args);
    const allDates = db.prepare("SELECT DISTINCT substr(timestamp,1,10) AS d FROM invoices WHERE location = ? ORDER BY d DESC").all(loc).map(r => r.d);

    const orders = invoices.map(inv => {
      const items     = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);
      const beverages = items.filter(i => classifyItem(i.name) === 'beverage').map(i => ({ name: i.name, qty: i.qty, amount: i.amount }));
      const food      = items.filter(i => classifyItem(i.name) === 'food').map(i => ({ name: i.name, qty: i.qty, amount: i.amount }));
      const printers  = [1];
      if (beverages.length) printers.push(2);
      if (food.length)      printers.push(3);
      return {
        invoiceNo:   inv.invoiceNo,   timestamp:   inv.timestamp,
        tableNo:     inv.tableNo,     status:      inv.status,
        grand:       inv.grand,       paymentMode: inv.paymentMode,  // ← added
        customer:    inv.custName,    phone:       inv.custPhone,
        printers,
        breakdown: { beverages, food, all: items.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })) },
      };
    });

    res.json({ success: true, location: loc, orders, availableDates: allDates });
  } catch (err) {
    console.error('Routing error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  API — INVENTORY  (Kitchen read / Owner full CRUD)
// ═══════════════════════════════════════════════════════

/* GET all ingredients — Kitchen + Owner */
app.get('/api/inventory', (req, res) => {
  const loc = req.query.location || 'guntupalli';
  res.json({ success: true, items: db.prepare('SELECT * FROM ingredients WHERE location = ? ORDER BY category, name').all(loc) });
});

/* GET single ingredient + recipe usage — Owner */
app.get('/api/inventory/:id', requireOwner, (req, res) => {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!ing) return res.status(404).json({ success: false, error: 'Not found' });
  const usedIn = db.prepare(`
    SELECT m.name AS menuItem, mii.qtyPerServing
    FROM menu_item_ingredients mii JOIN menu_items m ON mii.menuItemId = m.id
    WHERE mii.ingredientId = ?
  `).all(req.params.id);
  res.json({ success: true, ingredient: ing, usedIn });
});

/* ADD ingredient — Owner */
app.post('/api/inventory', requireOwner, (req, res) => {
  const { name, unit, currentQty, reorderLevel, category, location } = req.body;
  if (!name || !unit) return res.status(400).json({ success: false, error: 'name and unit required' });
  const qty = parseFloat(currentQty) || 0;
  const loc = (location || 'guntupalli').toLowerCase().trim();
  const r   = db.prepare('INSERT INTO ingredients (name, unit, currentQty, reorderLevel, category, location) VALUES (?, ?, ?, ?, ?, ?)').run(name, unit, qty, parseFloat(reorderLevel) || 0, category || 'Other', loc);
  if (qty > 0)
    db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'manual', ?, ?, 'Initial stock')").run(r.lastInsertRowid, qty, qty);
  res.status(201).json({ success: true, id: r.lastInsertRowid });
});

/* UPDATE ingredient quantity — Owner */
app.put('/api/inventory/:id', requireOwner, (req, res) => {
  const old = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ success: false, error: 'Not found' });
  const { name, unit, currentQty, reorderLevel, category } = req.body;
  const newQty = parseFloat(currentQty);
  db.prepare('UPDATE ingredients SET name=?, unit=?, currentQty=?, reorderLevel=?, category=? WHERE id=?').run(
    name || old.name, unit || old.unit, newQty,
    parseFloat(reorderLevel) || old.reorderLevel,
    category || old.category || 'Other',
    req.params.id
  );
  if (newQty !== old.currentQty)
    db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'manual', ?, ?, 'Manual update')").run(req.params.id, newQty - old.currentQty, newQty);
  refreshAvailability();
  res.json({ success: true });
});

/* Bulk daily stock entry — Owner */
app.post('/api/inventory/stock-entry', requireOwner, (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ success: false, error: 'entries[] required' });
  db.transaction(() => {
    for (const e of entries) {
      const old = db.prepare('SELECT currentQty FROM ingredients WHERE id = ?').get(e.id);
      if (!old) continue;
      const newQty = parseFloat(e.qty) || 0;
      db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, e.id);
      db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'restock', ?, ?, 'Daily stock entry')").run(e.id, newQty - old.currentQty, newQty);
    }
  })();
  refreshAvailability();
  res.json({ success: true, updated: entries.length });
});

/* DELETE ingredient — Owner */
app.delete('/api/inventory/:id', requireOwner, (req, res) => {
  if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(req.params.id))
    return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM ingredients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

/* GET inventory logs — Owner */
app.get('/api/inventory/logs', requireOwner, (req, res) => {
  let q = 'SELECT l.*, i.name AS itemName FROM inventory_logs l JOIN ingredients i ON l.itemId = i.id';
  const args = [];
  if (req.query.date) { q += ' WHERE l.createdAt LIKE ?'; args.push(req.query.date + '%'); }
  q += ' ORDER BY l.id DESC LIMIT 500';
  res.json({ success: true, logs: db.prepare(q).all(...args) });
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  API — INVENTORY IMPORT (clear + reload from Excel)
// ═══════════════════════════════════════════════════════

/* POST /api/inventory/import
   Body: { rows: [{name,unit,currentQty,reorderLevel,category}], location, clearFirst }
   clearFirst=true wipes existing rows for that location before inserting */
app.post('/api/inventory/import', (req, res) => {
  const { rows, location, clearFirst } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });
  const loc = (location || 'guntupalli').toLowerCase().trim();

  try {
    let inserted = 0, updated = 0;
    const errors = [];
    db.transaction(() => {
      if (clearFirst) {
        const ids = db.prepare('SELECT id FROM ingredients WHERE location = ?').all(loc).map(r => r.id);
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(`DELETE FROM menu_item_ingredients WHERE ingredientId IN (${ph})`).run(...ids);
          db.prepare(`DELETE FROM inventory_logs WHERE itemId IN (${ph})`).run(...ids);
        }
        db.prepare('DELETE FROM ingredients WHERE location = ?').run(loc);
      }

      const upsert = db.prepare(`
        INSERT INTO ingredients (location, name, unit, currentQty, reorderLevel, category)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(location, name) DO UPDATE SET
          unit         = excluded.unit,
          currentQty   = excluded.currentQty,
          reorderLevel = excluded.reorderLevel,
          category     = excluded.category
      `);

      for (const [idx, r] of rows.entries()) {
        const name = (r.name || '').toString().trim();
        if (!name) { errors.push(`Row ${idx + 1}: missing name`); continue; }
        const info = upsert.run(
          loc, name,
          (r.unit || 'units').toString().trim(),
          parseFloat(r.currentQty) || 0,
          parseFloat(r.reorderLevel) || 0,
          (r.category || 'Other').toString().trim()
        );
        if (info.lastInsertRowid > 0 && info.changes === 1) inserted++;
        else updated++;
      }
    })();
    refreshAvailability();
    res.json({ success: true, inserted, updated, errors });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  API — RECIPES  (menu item -> ingredient mappings)
// ═══════════════════════════════════════════════════════

/* GET /api/recipes */
app.get('/api/recipes', (req, res) => {
  const menuItems = db.prepare('SELECT id, name, section, category FROM menu_items ORDER BY section, name').all();
  const result = menuItems.map(item => {
    const links = db.prepare(`
      SELECT mii.id AS linkId, mii.ingredientId, mii.qtyPerServing,
             i.name AS ingredientName, i.unit, i.currentQty, i.category AS ingCategory
      FROM menu_item_ingredients mii
      JOIN ingredients i ON mii.ingredientId = i.id
      WHERE mii.menuItemId = ?
      ORDER BY i.name
    `).all(item.id);
    return { ...item, ingredients: links };
  });
  res.json({ success: true, recipes: result });
});

/* GET /api/recipes/:menuItemId */
app.get('/api/recipes/:menuItemId', (req, res) => {
  const item = db.prepare('SELECT id, name, section FROM menu_items WHERE id = ?').get(req.params.menuItemId);
  if (!item) return res.status(404).json({ success: false, error: 'Menu item not found' });
  const links = db.prepare(`
    SELECT mii.id AS linkId, mii.ingredientId, mii.qtyPerServing,
           i.name AS ingredientName, i.unit, i.currentQty
    FROM menu_item_ingredients mii
    JOIN ingredients i ON mii.ingredientId = i.id
    WHERE mii.menuItemId = ?
    ORDER BY i.name
  `).all(item.id);
  res.json({ success: true, recipe: { ...item, ingredients: links } });
});

/* POST /api/recipes/:menuItemId/ingredients */
app.post('/api/recipes/:menuItemId/ingredients', requireOwner, (req, res) => {
  const { ingredientId, qtyPerServing } = req.body;
  if (!ingredientId || !qtyPerServing)
    return res.status(400).json({ success: false, error: 'ingredientId and qtyPerServing required' });
  if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.menuItemId))
    return res.status(404).json({ success: false, error: 'Menu item not found' });
  if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(ingredientId))
    return res.status(404).json({ success: false, error: 'Ingredient not found' });
  try {
    const r = db.prepare(`
      INSERT INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
      VALUES (?, ?, ?)
      ON CONFLICT(menuItemId, ingredientId) DO UPDATE SET qtyPerServing = excluded.qtyPerServing
    `).run(req.params.menuItemId, ingredientId, parseFloat(qtyPerServing));
    refreshAvailability();
    res.status(201).json({ success: true, linkId: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/* PUT /api/recipes/links/:linkId */
app.put('/api/recipes/links/:linkId', requireOwner, (req, res) => {
  const { qtyPerServing } = req.body;
  if (!qtyPerServing) return res.status(400).json({ success: false, error: 'qtyPerServing required' });
  const r = db.prepare('UPDATE menu_item_ingredients SET qtyPerServing = ? WHERE id = ?').run(parseFloat(qtyPerServing), req.params.linkId);
  if (!r.changes) return res.status(404).json({ success: false, error: 'Link not found' });
  refreshAvailability();
  res.json({ success: true });
});

/* DELETE /api/recipes/links/:linkId */
app.delete('/api/recipes/links/:linkId', requireOwner, (req, res) => {
  const r = db.prepare('DELETE FROM menu_item_ingredients WHERE id = ?').run(req.params.linkId);
  if (!r.changes) return res.status(404).json({ success: false, error: 'Link not found' });
  refreshAvailability();
  res.json({ success: true });
});

/* DELETE /api/recipes/:menuItemId — clear all ingredients from a recipe */
app.delete('/api/recipes/:menuItemId', requireOwner, (req, res) => {
  db.prepare('DELETE FROM menu_item_ingredients WHERE menuItemId = ?').run(req.params.menuItemId);
  refreshAvailability();
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  API — RECIPE IMPORT FROM EXCEL
//  POST /api/recipes/import
//  Body: { rows: [{menuItem, ingredient, qtyPerServing, unit}], clearFirst, location }
//  clearFirst=true wipes all existing recipe links before inserting
// ═══════════════════════════════════════════════════════

app.post('/api/recipes/import', requireOwner, (req, res) => {
  const { rows, clearFirst, location } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  const loc = (location || 'guntupalli').toLowerCase().trim();

  try {
    const errors   = [];
    const skipped  = [];
    let   linked   = 0;

    db.transaction(() => {
      if (clearFirst) {
        db.prepare('DELETE FROM menu_item_ingredients').run();
        console.log('🗑  Cleared all existing recipe links before import.');
      }

      for (const [idx, row] of rows.entries()) {
        const menuItemName  = (row.menuItem   || row['Menu Item']   || '').toString().trim();
        const ingredientName= (row.ingredient || row['Ingredient']  || '').toString().trim().toLowerCase();
        const qty           = parseFloat(row.qtyPerServing || row['Qty Per Serving'] || 0);

        if (!menuItemName)    { errors.push(`Row ${idx+1}: missing Menu Item`);   continue; }
        if (!ingredientName)  { errors.push(`Row ${idx+1}: missing Ingredient`);  continue; }
        if (!qty || qty <= 0) { errors.push(`Row ${idx+1} "${menuItemName} → ${ingredientName}": qty must be > 0`); continue; }

        // Look up menu item (case-insensitive)
        const menuItem = db.prepare(
          "SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?)"
        ).get(menuItemName);

        if (!menuItem) {
          skipped.push(`"${menuItemName}" — not found in menu_items (add it first)`);
          continue;
        }

        // Look up ingredient by name + location
        const ingredient = db.prepare(
          "SELECT id FROM ingredients WHERE LOWER(name) = LOWER(?) AND location = ?"
        ).get(ingredientName, loc);

        if (!ingredient) {
          skipped.push(`"${ingredientName}" — not found in ingredients for ${loc}`);
          continue;
        }

        // Upsert the link
        db.prepare(`
          INSERT INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
          VALUES (?, ?, ?)
          ON CONFLICT(menuItemId, ingredientId) DO UPDATE SET qtyPerServing = excluded.qtyPerServing
        `).run(menuItem.id, ingredient.id, qty);

        linked++;
      }
    })();

    refreshAvailability();
    res.json({ success: true, linked, skipped: skipped.length, errors, skippedItems: skipped });
  } catch (err) {
    console.error('Recipe import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════
//  API — PARKED ORDERS  (Cashier / Manager / Owner)
// ═══════════════════════════════════════════════════════

/* POST /api/orders/park
   Body: { token, tableNo, location, items[], subtotal, gst, grand }
   Creates a parked (on-hold) order. Returns the parked order id. */
app.post('/api/orders/park', (req, res) => {
  const { token, tableNo, location, items, subtotal, gst, grand } = req.body;
  if (!token || !Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'token and items[] required' });

  const loc = (location || 'guntupalli').toLowerCase().trim();

  try {
    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO parked_orders (token, location, tableNo, subtotal, gst, grand)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(token, loc, tableNo || 'Counter', subtotal || 0, gst || 0, grand || 0);

      const parkedId = r.lastInsertRowid;
      const addItem = db.prepare(`
        INSERT INTO parked_order_items (parkedOrderId, name, emoji, qty, rate, amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of items)
        addItem.run(parkedId, item.name, item.emoji || '☕', item.qty, item.rate, item.amount);

      return parkedId;
    })();

    res.status(201).json({ success: true, id: result, token });
  } catch (err) {
    console.error('Park order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* GET /api/orders/parked?location=guntupalli
   Returns all currently PARKED orders for a branch. */
app.get('/api/orders/parked', (req, res) => {
  const loc = req.query.location || 'guntupalli';
  try {
    const orders = db.prepare(`
      SELECT * FROM parked_orders WHERE location = ? AND status = 'PARKED' ORDER BY id DESC
    `).all(loc);

    const result = orders.map(o => {
      const items = db.prepare('SELECT * FROM parked_order_items WHERE parkedOrderId = ?').all(o.id);
      return { ...o, items };
    });

    res.json({ success: true, orders: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* PATCH /api/orders/parked/:token/status
   Body: { status: 'RESUMED' | 'CANCELLED' }
   Marks a parked order as resumed or cancelled. */
app.patch('/api/orders/parked/:token/status', (req, res) => {
  const { status } = req.body;
  if (!['RESUMED', 'CANCELLED'].includes(status))
    return res.status(400).json({ success: false, error: 'status must be RESUMED or CANCELLED' });

  const order = db.prepare("SELECT id FROM parked_orders WHERE token = ? AND status = 'PARKED'").get(req.params.token);
  if (!order)
    return res.status(404).json({ success: false, error: 'Parked order not found or already resolved' });

  db.prepare('UPDATE parked_orders SET status = ? WHERE id = ?').run(status, order.id);
  res.json({ success: true });
});

/* GET /api/orders/parked/:token
   Returns a single parked order with its items. */
app.get('/api/orders/parked/:token', (req, res) => {
  const order = db.prepare('SELECT * FROM parked_orders WHERE token = ?').get(req.params.token);
  if (!order) return res.status(404).json({ success: false, error: 'Not found' });
  const items = db.prepare('SELECT * FROM parked_order_items WHERE parkedOrderId = ?').all(order.id);
  res.json({ success: true, order: { ...order, items } });
});


seed();

// ═══════════════════════════════════════════════════════
//  THERMAL PRINTER — ESC/POS DIRECT PRINT
//
//  This sends receipts directly to your thermal printer
//  without opening a browser print dialog.
//
//  ── SETUP ──────────────────────────────────────────────
//  1. Install the printer library:
//       npm install node-thermal-printer
//
//  2. Find your printer connection type and set it below:
//
//     USB (most common for desktop POS):
//       type: PrinterTypes.EPSON  (or STAR)
//       interface: 'usb'          ← works on Linux/Mac
//       On Windows, install Zadig driver and use:
//       interface: 'printer:YourPrinterName'
//       (get name from: Control Panel → Devices and Printers)
//
//     Network / Ethernet (IP-connected printer):
//       interface: 'tcp://192.168.1.87:9100'
//       ← replace with your printer's IP and port (usually 9100)
//       To find the IP: print a self-test page on your printer
//
//     Serial port (older printers, rare):
//       interface: '/dev/ttyUSB0'       (Linux)
//       interface: 'COM3'               (Windows)
//
//  3. Set THERMAL_PRINTER_WIDTH_MM below to match your roll:
//       58  → 50 mm paper (narrow roll, ~32 chars/line)
//       80  → 80 mm paper (wide roll,   ~48 chars/line)
//
//  4. If you're NOT using direct ESC/POS printing, just leave
//     this section as-is — the browser popup print path
//     in men_m.html will still work fine.
// ═══════════════════════════════════════════════════════

// ▼▼▼ EDIT THESE TWO LINES ▼▼▼
const THERMAL_PRINTER_INTERFACE  = 'tcp://192.168.1.87:9100'; // ← your printer IP:port or 'usb'
const THERMAL_PRINTER_WIDTH_MM   = 80;                         // ← 58 or 80
// ▲▲▲ EDIT THESE TWO LINES ▲▲▲

let ThermalPrinter, PrinterTypes, CharacterSet;
try {
  const ntp = require('node-thermal-printer');
  ThermalPrinter = ntp.printer;
  PrinterTypes   = ntp.types;
  CharacterSet   = ntp.CharacterSet;
} catch (e) {
  console.warn('⚠️  node-thermal-printer not installed. Direct ESC/POS printing disabled.');
  console.warn('   Run: npm install node-thermal-printer  to enable it.');
  console.warn('   Browser popup printing (men_m.html) still works without it.');
}

/* POST /api/print
   Body: { invoiceNo }  — fetches invoice from DB and sends to thermal printer.
   The frontend calls this as a background request after generating the invoice.
   If this fails (printer offline), the browser popup print path is used as fallback. */
app.post('/api/print', async (req, res) => {
  if (!ThermalPrinter) {
    return res.status(503).json({ success: false, error: 'node-thermal-printer not installed. Use browser print instead.' });
  }

  const { invoiceNo } = req.body;
  if (!invoiceNo) return res.status(400).json({ success: false, error: 'invoiceNo required' });

  const inv = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(invoiceNo);
  if (!inv)  return res.status(404).json({ success: false, error: 'Invoice not found' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customerId);
  const items    = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);

  // ── Character widths per paper size ──
  const lineWidth   = THERMAL_PRINTER_WIDTH_MM >= 80 ? 48 : 32;
  const colNameW    = THERMAL_PRINTER_WIDTH_MM >= 80 ? 28 : 18;
  const colQtyW     = 4;
  const colAmtW     = lineWidth - colNameW - colQtyW;

  function pad(str, len, right = false) {
    const s = String(str).slice(0, len);
    return right ? s.padStart(len) : s.padEnd(len);
  }
  function divider(char = '-') { return char.repeat(lineWidth); }

  try {
    const printer = new ThermalPrinter({
      type:      PrinterTypes.EPSON,       // ← change to PrinterTypes.STAR if you have a Star printer
      interface: THERMAL_PRINTER_INTERFACE,
      width:     lineWidth,
      removeSpecialCharacters: false,
      lineCharacter: '-',
    });

    const isConnected = await printer.isPrinterConnected();
    if (!isConnected) throw new Error('Printer not reachable at ' + THERMAL_PRINTER_INTERFACE);

    // ── Header ──
    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println('MACH CAFE');
    printer.bold(false);
    printer.setTextNormal();
    printer.println('Every cup crafted with care');
    printer.drawLine();

    // ── Meta ──
    printer.alignLeft();
    const ts = new Date(inv.timestamp);
    printer.println(`${inv.invoiceNo}`);
    printer.println(`${ts.toLocaleDateString('en-IN')} ${ts.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`);
    printer.println(`Table: ${inv.tableNo || 'Counter'}   Payment: ${inv.paymentMode || 'Cash'}`);
    if (customer) printer.println(`Customer: ${customer.name}${customer.phone ? ' · ' + customer.phone : ''}`);
    printer.drawLine();

    // ── Column header ──
    printer.println(
      pad('Item', colNameW) + pad('Qty', colQtyW) + pad('Amt', colAmtW, true)
    );
    printer.println(divider());

    // ── Items ──
    for (const item of items) {
      const nameLine = pad(item.name, colNameW);
      const qtyLine  = pad(item.qty, colQtyW);
      const amtLine  = pad('Rs.' + item.amount, colAmtW, true);
      printer.println(nameLine + qtyLine + amtLine);
    }
    printer.drawLine();

    // ── Totals ──
    printer.println(pad('Subtotal', lineWidth - 10) + pad('Rs.' + inv.subtotal, 10, true));
    printer.println(pad('CGST 2.5%', lineWidth - 10) + pad('Rs.' + inv.cgst, 10, true));
    printer.println(pad('SGST 2.5%', lineWidth - 10) + pad('Rs.' + inv.sgst, 10, true));
    printer.println(divider('='));
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(pad('TOTAL', lineWidth - 12) + pad('Rs.' + inv.grand, 12, true));
    printer.bold(false);
    printer.setTextNormal();
    printer.drawLine();

    // ── Footer ──
    printer.alignCenter();
    printer.println('Thank you for visiting!');
    printer.println('hello@mach.in');
    printer.cut();
    printer.beep();   // optional beep on cut — remove if your printer doesn't support it

    await printer.execute();
    res.json({ success: true, message: 'Printed successfully' });

  } catch (err) {
    console.error('Thermal print error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`\n☕  MACH Cafe running at http://localhost:${PORT}`);
  console.log(`\n📋  HOW TO VIEW THE DATABASE:`);
  console.log(`    Option 1 (browser UI): npx @sqlite-viewer/app velvetbean.db`);
  console.log(`    Option 2 (terminal):   sqlite3 velvetbean.db`);
  console.log(`\n    Default owner password: velvetbean2024`);
  console.log(`    ⚠️  Change OWNER_PASSWORD_HASH and JWT_SECRET before going live!`);
});
