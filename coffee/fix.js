/**
 * rescue-db.js — exports all data from corrupted DB, rebuilds clean, re-imports
 * Run from your project folder: node rescue-db.js
 */
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const dbPath      = path.join(__dirname, 'velvetbean.db');
const backupPath  = path.join(__dirname, 'velvetbean.backup.db');
const exportPath  = path.join(__dirname, 'db-export.json');

// ── Step 1: Try to read what we can from the broken DB ────────────────────
console.log('📦  Opening (possibly broken) database…');
let exported = { customers: [], invoices: [], order_items: [], menu_items: [], ingredients: [], menu_item_ingredients: [] };

try {
  const old = new Database(dbPath, { readonly: true });

  const safeAll = (sql) => { try { return old.prepare(sql).all(); } catch(e) { console.warn(`  ⚠️  Could not read: ${sql} — ${e.message}`); return []; } };

  exported.customers              = safeAll('SELECT * FROM customers');
  exported.invoices               = safeAll('SELECT * FROM invoices');
  exported.order_items            = safeAll('SELECT * FROM order_items');
  exported.menu_items             = safeAll('SELECT * FROM menu_items');
  exported.ingredients            = safeAll('SELECT * FROM ingredients');
  exported.menu_item_ingredients  = safeAll('SELECT * FROM menu_item_ingredients');

  old.close();
  console.log(`✅  Exported:
     customers:             ${exported.customers.length}
     invoices:              ${exported.invoices.length}
     order_items:           ${exported.order_items.length}
     menu_items:            ${exported.menu_items.length}
     ingredients:           ${exported.ingredients.length}
     menu_item_ingredients: ${exported.menu_item_ingredients.length}`);
} catch(e) {
  console.error('❌  Could not open DB at all:', e.message);
  process.exit(1);
}

fs.writeFileSync(exportPath, JSON.stringify(exported, null, 2));
console.log(`💾  Saved export to db-export.json`);

// ── Step 2: Backup old DB, delete it ──────────────────────────────────────
fs.copyFileSync(dbPath, backupPath);
fs.unlinkSync(dbPath);
console.log('🗑️   Deleted broken DB (backup saved as velvetbean.backup.db)');

// ── Step 3: Create fresh DB with correct schema ───────────────────────────
console.log('🏗️   Building fresh database…');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL UNIQUE,
    email      TEXT,
    address    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceNo   TEXT    NOT NULL UNIQUE,
    location    TEXT    NOT NULL DEFAULT 'guntupalli',
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
  CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceId INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    qty       INTEGER NOT NULL,
    rate      INTEGER NOT NULL,
    amount    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ingredients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    location     TEXT    NOT NULL DEFAULT 'guntupalli',
    name         TEXT    NOT NULL,
    unit         TEXT    NOT NULL DEFAULT 'units',
    currentQty   REAL    NOT NULL DEFAULT 0,
    reorderLevel REAL    NOT NULL DEFAULT 10,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(location, name)
  );
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
  CREATE TABLE IF NOT EXISTS menu_item_ingredients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    menuItemId    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredientId  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qtyPerServing REAL    NOT NULL DEFAULT 1,
    UNIQUE(menuItemId, ingredientId)
  );
  CREATE TABLE IF NOT EXISTS inventory_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId    INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    logType   TEXT    NOT NULL,
    delta     REAL    NOT NULL,
    newQty    REAL    NOT NULL,
    note      TEXT,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_inv_cust  ON invoices(customerId);
  CREATE INDEX IF NOT EXISTS idx_inv_ts    ON invoices(timestamp);
  CREATE INDEX IF NOT EXISTS idx_inv_loc   ON invoices(location);
  CREATE INDEX IF NOT EXISTS idx_oi_inv    ON order_items(invoiceId);
  CREATE INDEX IF NOT EXISTS idx_ing_loc   ON ingredients(location);
  CREATE INDEX IF NOT EXISTS idx_mii_item  ON menu_item_ingredients(menuItemId);
`);

// ── Step 4: Re-import data ─────────────────────────────────────────────────
console.log('📥  Re-importing data…');

db.transaction(() => {
  // Customers
  const insCust = db.prepare(`INSERT OR IGNORE INTO customers (id,name,phone,email,address,created_at) VALUES (?,?,?,?,?,?)`);
  for (const c of exported.customers)
    insCust.run(c.id, c.name, c.phone, c.email||null, c.address||null, c.created_at);

  // Ingredients — add location if missing (old schema had no location column)
  const insIng = db.prepare(`INSERT OR IGNORE INTO ingredients (id,location,name,unit,currentQty,reorderLevel,created_at) VALUES (?,?,?,?,?,?,?)`);
  for (const i of exported.ingredients)
    insIng.run(i.id, i.location||'guntupalli', i.name, i.unit, i.currentQty, i.reorderLevel, i.created_at);

  // Menu items
  const insMenu = db.prepare(`INSERT OR IGNORE INTO menu_items (id,name,price,emoji,section,category,badge,description,isFeatured,isAvailable) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const m of exported.menu_items)
    insMenu.run(m.id, m.name, m.price, m.emoji, m.section, m.category||'beverage', m.badge||null, m.description||null, m.isFeatured||0, m.isAvailable??1);

  // menu_item_ingredients
  const insMii = db.prepare(`INSERT OR IGNORE INTO menu_item_ingredients (id,menuItemId,ingredientId,qtyPerServing) VALUES (?,?,?,?)`);
  for (const r of exported.menu_item_ingredients)
    insMii.run(r.id, r.menuItemId, r.ingredientId, r.qtyPerServing);

  // Invoices — add location if missing
  const insInv = db.prepare(`INSERT OR IGNORE INTO invoices (id,invoiceNo,location,customerId,tableNo,paymentMode,status,subtotal,cgst,sgst,grand,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const inv of exported.invoices)
    insInv.run(inv.id, inv.invoiceNo, inv.location||'guntupalli', inv.customerId, inv.tableNo||'Counter', inv.paymentMode||'Cash', inv.status||'PENDING', inv.subtotal, inv.cgst, inv.sgst, inv.grand, inv.timestamp);

  // Order items
  const insOi = db.prepare(`INSERT OR IGNORE INTO order_items (id,invoiceId,name,qty,rate,amount) VALUES (?,?,?,?,?,?)`);
  for (const oi of exported.order_items)
    insOi.run(oi.id, oi.invoiceId, oi.name, oi.qty, oi.rate, oi.amount);
})();

db.close();

console.log(`
✅  Done! Fresh database created.
   • Old broken DB backed up → velvetbean.backup.db
   • All data exported        → db-export.json
   
▶  Now run: node server.js
`);