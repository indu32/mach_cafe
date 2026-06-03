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

  if (!hasIngredients) return; // fresh DB — nothing to migrate, seed() will handle it

  // ── Replace old fake seed ingredients with the real Excel ones ────────────
  // Detects by checking for "Espresso Beans" which only exists in the old fake seed.
  const hasFakeData = db.prepare("SELECT 1 FROM ingredients WHERE name = 'Espresso Beans' LIMIT 1").get();
  if (hasFakeData) {
    console.log('🔄  Migration: replacing old fake ingredients with real Excel inventory…');
    db.transaction(() => {
      // Clear old fake ingredients and their recipe links / logs
      const fakeIds = db.prepare("SELECT id FROM ingredients WHERE location = 'guntupalli'").all().map(r => r.id);
      if (fakeIds.length) {
        const ph = fakeIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM menu_item_ingredients WHERE ingredientId IN (${ph})`).run(...fakeIds);
        db.prepare(`DELETE FROM inventory_logs WHERE itemId IN (${ph})`).run(...fakeIds);
      }
      db.prepare("DELETE FROM ingredients WHERE location = 'guntupalli'").run();

      // Insert the real Excel ingredients
      const ins = db.prepare(`
        INSERT OR IGNORE INTO ingredients (location, name, unit, currentQty, reorderLevel, category)
        VALUES ('guntupalli', ?, ?, ?, ?, ?)
      `);
      const realIngs = [
        ['breads','unit',91,20,'Dry Goods & Pantry'],['carrot','g',1618,390,'Fresh Produce'],['beetroot','g',557,120,'Fresh Produce'],['capsicum','g',309,90,'Fresh Produce'],['cucumber','g',1927,540,'Fresh Produce'],['mayonise','unit',20,10,'Sauces, Syrups & Spices'],['chatmasala','g',65,10,'Sauces, Syrups & Spices'],['cheese','g',2405,660,'Dairy & Ice Cream'],['butter','g',717,200,'Dairy & Ice Cream'],['2 breads','unit',93,30,'Dry Goods & Pantry'],['periperipow','g',264,60,'Sauces, Syrups & Spices'],['tomato sause','unit',42,10,'Fresh Produce'],['chilli sause','unit',2,10,'Sauces, Syrups & Spices'],['greenchillisause','unit',7,10,'Sauces, Syrups & Spices'],['hot&spicy pow','g',224,50,'Sauces, Syrups & Spices'],['tandooripow','g',160,50,'Sauces, Syrups & Spices'],['onion','g',789,170,'Fresh Produce'],['mayo','g',244,50,'Sauces, Syrups & Spices'],['mushrooms','unit',27,10,'Fresh Produce'],['nutella','unit',15,10,'Dry Goods & Pantry'],['milk','ml',4892,1070,'Dairy & Ice Cream'],['sugar','g',3600,760,'Dry Goods & Pantry'],['avacado(half)','unit',23,10,'Fresh Produce'],['banana','unit',44,10,'Fresh Produce'],['beetroots','unit',28,10,'Fresh Produce'],['dragon fruit','unit',50,10,'Fresh Produce'],['icecreamvennela','scoops',49,20,'Dairy & Ice Cream'],['sugat','g',90,30,'Other'],['FRUIT','gms',937,200,'Other'],['suagr','unit',22,10,'Other'],['icecubes','unit',28,10,'Other'],['sugar syrup','l',6320,1460,'Dry Goods & Pantry'],['apple','unit',22,10,'Fresh Produce'],['lemon','unit',48,10,'Fresh Produce'],['ginger','g',1347,400,'Fresh Produce'],['pudhina','unit',39,10,'Fresh Produce'],['pine','unit',15,10,'Fresh Produce'],['tomato','unit',22,10,'Fresh Produce'],['beetrrots','unit',45,10,'Other'],['carrots','unit',19,10,'Fresh Produce'],['vene','ml',958,220,'Dairy & Ice Cream'],['buttersc','ml',762,240,'Dairy & Ice Cream'],['buttrsc crush','ml',1021,250,'Sauces, Syrups & Spices'],['chocolate','unit',8,10,'Sauces, Syrups & Spices'],['choco syrup','unit',20,10,'Sauces, Syrups & Spices'],['cocopow','unit',12,10,'Sauces, Syrups & Spices'],['kiwicrush','ml',611,160,'Fresh Produce'],['litchi','ml',758,200,'Fresh Produce'],['80mange','unit',21,10,'Other'],['mangocrush','ml',862,240,'Fresh Produce'],['rosesyrup','ml',738,230,'Sauces, Syrups & Spices'],['strawberry','unit',32,10,'Fresh Produce'],['straw crush','ml',1017,260,'Sauces, Syrups & Spices'],['ven esse','unit',13,10,'Other'],['strawcrush','ml',386,120,'Sauces, Syrups & Spices'],['ven','ml',490,110,'Other'],['mango','unit',45,10,'Fresh Produce'],['blackcurrant','unit',15,10,'Sauces, Syrups & Spices'],['blackcurrent crush','ml',988,250,'Sauces, Syrups & Spices'],['kitkat','unit',69,20,'Dry Goods & Pantry'],['dates','unit',80,30,'Dry Goods & Pantry'],['ilachi','unit',5,10,'Other'],['badam','unit',24,10,'Dry Goods & Pantry'],['badampow','g',4898,1530,'Dry Goods & Pantry'],['hazelnut','g',3286,710,'Dry Goods & Pantry'],['pistacrush','ml',1090,240,'Dry Goods & Pantry'],['cash','unit',5,10,'Other'],['cherry','unit',43,10,'Dry Goods & Pantry'],['drygrapes','unit',16,10,'Fresh Produce'],['oreopow','g',1371,450,'Dry Goods & Pantry'],['chocosyrup','unit',11,10,'Sauces, Syrups & Spices'],['buttersc crush','ml',4658,1360,'Dairy & Ice Cream'],['coffeepow','g',128,30,'Sauces, Syrups & Spices'],['strawsyrup','ml',530,150,'Sauces, Syrups & Spices'],['pista','scoops',9189,3100,'Dry Goods & Pantry'],['poma','g',356,90,'Other'],['babycash','g',59,10,'Other'],['drigrape','unit',28,10,'Fresh Produce'],['crushes','unit',11,10,'Sauces, Syrups & Spices'],['kesarpista','scoops',4446,1470,'Dry Goods & Pantry'],['dragon','g',261,60,'Fresh Produce'],['chocochips','g',298,100,'Sauces, Syrups & Spices'],['curd','ml',4863,1530,'Dairy & Ice Cream'],['icecubes(op)','unit',13,10,'Other'],['litchicrush','ml',662,150,'Fresh Produce'],['muskmelonfru','gm',2261,750,'Fresh Produce'],['blackcurrantcrush','ml',1066,370,'Sauces, Syrups & Spices'],['buttersccrush','ml',4917,1540,'Dairy & Ice Cream'],['strawberrycrush','ml',806,190,'Fresh Produce'],['sugarsyrup','ml',838,220,'Dry Goods & Pantry'],['strawberryscrush','ml',787,230,'Fresh Produce'],['icecube','unit',33,10,'Other'],['sprite','ml',4198,920,'Beverages & Mixers'],['blueberrycrush','ml',660,140,'Sauces, Syrups & Spices'],['soda','ml',672,190,'Beverages & Mixers'],['lime&mintsyrup','ml',671,190,'Sauces, Syrups & Spices'],['blue lagoonsyrup','ml',214,50,'Sauces, Syrups & Spices'],['watermeloncrush','ml',746,160,'Fresh Produce'],['bluelogoonsyrup','ml',338,110,'Sauces, Syrups & Spices'],['oreo &cream','scoops',62,10,'Dairy & Ice Cream'],['almond','scoops',4399,1060,'Dry Goods & Pantry'],['brownie cake','unit',72,20,'Dry Goods & Pantry'],['babysch','g',117,40,'Other'],['dryfuit','g',4372,1030,'Dry Goods & Pantry'],['burgur bun','unit',70,20,'Dry Goods & Pantry'],['veg patte','unit',22,10,'Meat & Protein'],['periperi sause','g',387,100,'Sauces, Syrups & Spices'],['chipotal mayo','g',266,70,'Sauces, Syrups & Spices'],['chicken patte','unit',13,10,'Meat & Protein'],['spring onions','unit',46,10,'Fresh Produce'],['red chiili','unit',30,10,'Other'],['ginger&garlic','unit',11,10,'Fresh Produce'],['salt','unit',17,10,'Other'],['red chilli pow','unit',13,10,'Fresh Produce'],['maidha','unit',45,10,'Dry Goods & Pantry'],['green chilli','unit',9,10,'Fresh Produce'],['corn floor','unit',80,20,'Dry Goods & Pantry'],['kitchenking masala','unit',19,10,'Sauces, Syrups & Spices'],['food color(opt)','unit',10,10,'Other'],['chat masala','unit',9,10,'Sauces, Syrups & Spices'],['white&black pepper','unit',17,10,'Sauces, Syrups & Spices'],['soya sause','unit',14,10,'Sauces, Syrups & Spices'],['red chilli sause','unit',15,10,'Fresh Produce'],['green chilli sause','unit',29,10,'Fresh Produce'],['venegar','unit',30,10,'Dairy & Ice Cream'],['paneer','unit',23,10,'Fresh Produce'],['mushroom','unit',40,10,'Fresh Produce'],['boneless chicken','unit',41,10,'Meat & Protein'],['maida','unit',47,10,'Dry Goods & Pantry'],['turmeric','unit',3,10,'Sauces, Syrups & Spices'],['curryleaves','unit',39,10,'Fresh Produce'],['garam masala','unit',12,10,'Sauces, Syrups & Spices'],['red chilli','unit',42,10,'Fresh Produce'],['redchilli pow','unit',18,10,'Sauces, Syrups & Spices'],['soyasause','unit',18,10,'Sauces, Syrups & Spices'],['tomatosause','unit',16,10,'Fresh Produce'],['red&green chilli sause','unit',9,10,'Fresh Produce'],['chicken wings','unit',25,10,'Meat & Protein'],['pasta','unit',82,20,'Dry Goods & Pantry'],['garlic','unit',43,10,'Fresh Produce'],['black pepper','unit',4,10,'Sauces, Syrups & Spices'],['redchilli flex','unit',20,10,'Sauces, Syrups & Spices'],['origano','unit',12,10,'Sauces, Syrups & Spices'],['muchroom(opt)','unit',18,10,'Other'],['paneer(opt','unit',25,10,'Fresh Produce'],['chicken(opt)','unit',35,10,'Meat & Protein'],['rice','unit',92,20,'Dry Goods & Pantry'],['beans','unit',25,10,'Fresh Produce'],['cabbage','unit',9,10,'Fresh Produce'],['azinamoto(opt)','unit',44,20,'Other'],['black&white pepper','unit',5,10,'Sauces, Syrups & Spices'],['mashrooms','unit',18,10,'Other'],['eggs','unit',18,10,'Meat & Protein'],['noodles','unit',18,10,'Dry Goods & Pantry'],['french fries','unit',57,10,'Dry Goods & Pantry'],['periperi pow','g',274,90,'Sauces, Syrups & Spices'],['frech fires','gms',5456,1590,'Dry Goods & Pantry'],['madras masala pow','g',463,140,'Sauces, Syrups & Spices'],['french fires','gms',628,190,'Dry Goods & Pantry'],['red chilli flex','unit',40,10,'Fresh Produce'],['coffee','g',389,80,'Sauces, Syrups & Spices'],['filter','ml',1998,440,'Sauces, Syrups & Spices'],['brownsugar','g',1445,480,'Dry Goods & Pantry'],['boost','g',1773,430,'Dry Goods & Pantry'],['horlicks','g',2225,680,'Dry Goods & Pantry'],['teapow','g',2167,660,'Dry Goods & Pantry'],['masala','g',486,120,'Sauces, Syrups & Spices'],['greentea','unit',72,20,'Dry Goods & Pantry'],['honey','g',916,200,'Dry Goods & Pantry'],['tea pow','g',266,90,'Other'],['subseeds','g',72,10,'Sauces, Syrups & Spices'],
      ];
      for (const r of realIngs) ins.run(...r);
      console.log(`✅  Replaced with ${realIngs.length} real ingredients.`);
    })();
  }

  // Seed Ongole & Kodaikanal stock from Guntupalli if empty
  for (const loc of ['ongole', 'kodaikanal']) {
    const already = db.prepare('SELECT COUNT(*) AS c FROM ingredients WHERE location = ?').get(loc).c;
    if (already === 0) {
      console.log(`🌱  Seeding ${loc} ingredients…`);
      db.prepare(`INSERT OR IGNORE INTO ingredients (location, name, unit, currentQty, reorderLevel, category)
               SELECT ?, name, unit, currentQty, reorderLevel, category
               FROM ingredients WHERE location = 'guntupalli'`).run(loc);
    }
  }
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
//  SEED  (only runs once when tables are empty)
// ═══════════════════════════════════════════════════════

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c > 0) return;
  console.log('🌱  First run — seeding database…');

  // ── Real inventory from Inventory_Template_Stocked.xlsx ──────────────────
  const addIng = db.prepare(`
    INSERT OR IGNORE INTO ingredients (location, name, unit, currentQty, reorderLevel, category)
    VALUES ('guntupalli', ?, ?, ?, ?, ?)
  `);

  const ings = [
    // name,                    unit,    currentQty, reorderLevel, category
    ['breads',                  'unit',  91,   20,  'Dry Goods & Pantry'],
    ['carrot',                  'g',     1618, 390, 'Fresh Produce'],
    ['beetroot',                'g',     557,  120, 'Fresh Produce'],
    ['capsicum',                'g',     309,  90,  'Fresh Produce'],
    ['cucumber',                'g',     1927, 540, 'Fresh Produce'],
    ['mayonise',                'unit',  20,   10,  'Sauces, Syrups & Spices'],
    ['chatmasala',              'g',     65,   10,  'Sauces, Syrups & Spices'],
    ['cheese',                  'g',     2405, 660, 'Dairy & Ice Cream'],
    ['butter',                  'g',     717,  200, 'Dairy & Ice Cream'],
    ['2 breads',                'unit',  93,   30,  'Dry Goods & Pantry'],
    ['periperipow',             'g',     264,  60,  'Sauces, Syrups & Spices'],
    ['tomato sause',            'unit',  42,   10,  'Fresh Produce'],
    ['chilli sause',            'unit',  2,    10,  'Sauces, Syrups & Spices'],
    ['greenchillisause',        'unit',  7,    10,  'Sauces, Syrups & Spices'],
    ['hot&spicy pow',           'g',     224,  50,  'Sauces, Syrups & Spices'],
    ['tandooripow',             'g',     160,  50,  'Sauces, Syrups & Spices'],
    ['onion',                   'g',     789,  170, 'Fresh Produce'],
    ['mayo',                    'g',     244,  50,  'Sauces, Syrups & Spices'],
    ['mushrooms',               'unit',  27,   10,  'Fresh Produce'],
    ['nutella',                 'unit',  15,   10,  'Dry Goods & Pantry'],
    ['milk',                    'ml',    4892, 1070,'Dairy & Ice Cream'],
    ['sugar',                   'g',     3600, 760, 'Dry Goods & Pantry'],
    ['avacado(half)',           'unit',  23,   10,  'Fresh Produce'],
    ['banana',                  'unit',  44,   10,  'Fresh Produce'],
    ['beetroots',               'unit',  28,   10,  'Fresh Produce'],
    ['dragon fruit',            'unit',  50,   10,  'Fresh Produce'],
    ['icecreamvennela',         'scoops',49,   20,  'Dairy & Ice Cream'],
    ['sugat',                   'g',     90,   30,  'Other'],
    ['FRUIT',                   'gms',   937,  200, 'Other'],
    ['suagr',                   'unit',  22,   10,  'Other'],
    ['icecubes',                'unit',  28,   10,  'Other'],
    ['sugar syrup',             'l',     6320, 1460,'Dry Goods & Pantry'],
    ['apple',                   'unit',  22,   10,  'Fresh Produce'],
    ['lemon',                   'unit',  48,   10,  'Fresh Produce'],
    ['ginger',                  'g',     1347, 400, 'Fresh Produce'],
    ['pudhina',                 'unit',  39,   10,  'Fresh Produce'],
    ['pine',                    'unit',  15,   10,  'Fresh Produce'],
    ['tomato',                  'unit',  22,   10,  'Fresh Produce'],
    ['beetrrots',               'unit',  45,   10,  'Other'],
    ['carrots',                 'unit',  19,   10,  'Fresh Produce'],
    ['vene',                    'ml',    958,  220, 'Dairy & Ice Cream'],
    ['buttersc',                'ml',    762,  240, 'Dairy & Ice Cream'],
    ['buttrsc crush',           'ml',    1021, 250, 'Sauces, Syrups & Spices'],
    ['chocolate',               'unit',  8,    10,  'Sauces, Syrups & Spices'],
    ['choco syrup',             'unit',  20,   10,  'Sauces, Syrups & Spices'],
    ['cocopow',                 'unit',  12,   10,  'Sauces, Syrups & Spices'],
    ['kiwicrush',               'ml',    611,  160, 'Fresh Produce'],
    ['litchi',                  'ml',    758,  200, 'Fresh Produce'],
    ['80mange',                 'unit',  21,   10,  'Other'],
    ['mangocrush',              'ml',    862,  240, 'Fresh Produce'],
    ['rosesyrup',               'ml',    738,  230, 'Sauces, Syrups & Spices'],
    ['strawberry',              'unit',  32,   10,  'Fresh Produce'],
    ['straw crush',             'ml',    1017, 260, 'Sauces, Syrups & Spices'],
    ['ven esse',                'unit',  13,   10,  'Other'],
    ['strawcrush',              'ml',    386,  120, 'Sauces, Syrups & Spices'],
    ['ven',                     'ml',    490,  110, 'Other'],
    ['mango',                   'unit',  45,   10,  'Fresh Produce'],
    ['blackcurrant',            'unit',  15,   10,  'Sauces, Syrups & Spices'],
    ['blackcurrent crush',      'ml',    988,  250, 'Sauces, Syrups & Spices'],
    ['kitkat',                  'unit',  69,   20,  'Dry Goods & Pantry'],
    ['dates',                   'unit',  80,   30,  'Dry Goods & Pantry'],
    ['ilachi',                  'unit',  5,    10,  'Other'],
    ['badam',                   'unit',  24,   10,  'Dry Goods & Pantry'],
    ['badampow',                'g',     4898, 1530,'Dry Goods & Pantry'],
    ['hazelnut',                'g',     3286, 710, 'Dry Goods & Pantry'],
    ['pistacrush',              'ml',    1090, 240, 'Dry Goods & Pantry'],
    ['cash',                    'unit',  5,    10,  'Other'],
    ['cherry',                  'unit',  43,   10,  'Dry Goods & Pantry'],
    ['drygrapes',               'unit',  16,   10,  'Fresh Produce'],
    ['oreopow',                 'g',     1371, 450, 'Dry Goods & Pantry'],
    ['chocosyrup',              'unit',  11,   10,  'Sauces, Syrups & Spices'],
    ['buttersc crush',          'ml',    4658, 1360,'Dairy & Ice Cream'],
    ['coffeepow',               'g',     128,  30,  'Sauces, Syrups & Spices'],
    ['strawsyrup',              'ml',    530,  150, 'Sauces, Syrups & Spices'],
    ['pista',                   'scoops',9189, 3100,'Dry Goods & Pantry'],
    ['poma',                    'g',     356,  90,  'Other'],
    ['babycash',                'g',     59,   10,  'Other'],
    ['drigrape',                'unit',  28,   10,  'Fresh Produce'],
    ['crushes',                 'unit',  11,   10,  'Sauces, Syrups & Spices'],
    ['kesarpista',              'scoops',4446, 1470,'Dry Goods & Pantry'],
    ['dragon',                  'g',     261,  60,  'Fresh Produce'],
    ['chocochips',              'g',     298,  100, 'Sauces, Syrups & Spices'],
    ['curd',                    'ml',    4863, 1530,'Dairy & Ice Cream'],
    ['icecubes(op)',            'unit',  13,   10,  'Other'],
    ['litchicrush',             'ml',    662,  150, 'Fresh Produce'],
    ['muskmelonfru',            'gm',    2261, 750, 'Fresh Produce'],
    ['blackcurrantcrush',       'ml',    1066, 370, 'Sauces, Syrups & Spices'],
    ['buttersccrush',           'ml',    4917, 1540,'Dairy & Ice Cream'],
    ['strawberrycrush',         'ml',    806,  190, 'Fresh Produce'],
    ['sugarsyrup',              'ml',    838,  220, 'Dry Goods & Pantry'],
    ['strawberryscrush',        'ml',    787,  230, 'Fresh Produce'],
    ['icecube',                 'unit',  33,   10,  'Other'],
    ['sprite',                  'ml',    4198, 920, 'Beverages & Mixers'],
    ['blueberrycrush',          'ml',    660,  140, 'Sauces, Syrups & Spices'],
    ['soda',                    'ml',    672,  190, 'Beverages & Mixers'],
    ['lime&mintsyrup',          'ml',    671,  190, 'Sauces, Syrups & Spices'],
    ['blue lagoonsyrup',        'ml',    214,  50,  'Sauces, Syrups & Spices'],
    ['watermeloncrush',         'ml',    746,  160, 'Fresh Produce'],
    ['bluelogoonsyrup',         'ml',    338,  110, 'Sauces, Syrups & Spices'],
    ['oreo &cream',             'scoops',62,   10,  'Dairy & Ice Cream'],
    ['almond',                  'scoops',4399, 1060,'Dry Goods & Pantry'],
    ['brownie cake',            'unit',  72,   20,  'Dry Goods & Pantry'],
    ['babysch',                 'g',     117,  40,  'Other'],
    ['dryfuit',                 'g',     4372, 1030,'Dry Goods & Pantry'],
    ['burgur bun',              'unit',  70,   20,  'Dry Goods & Pantry'],
    ['veg patte',               'unit',  22,   10,  'Meat & Protein'],
    ['periperi sause',          'g',     387,  100, 'Sauces, Syrups & Spices'],
    ['chipotal mayo',           'g',     266,  70,  'Sauces, Syrups & Spices'],
    ['chicken patte',           'unit',  13,   10,  'Meat & Protein'],
    ['spring onions',           'unit',  46,   10,  'Fresh Produce'],
    ['red chiili',              'unit',  30,   10,  'Other'],
    ['ginger&garlic',           'unit',  11,   10,  'Fresh Produce'],
    ['salt',                    'unit',  17,   10,  'Other'],
    ['red chilli pow',          'unit',  13,   10,  'Fresh Produce'],
    ['maidha',                  'unit',  45,   10,  'Dry Goods & Pantry'],
    ['green chilli',            'unit',  9,    10,  'Fresh Produce'],
    ['corn floor',              'unit',  80,   20,  'Dry Goods & Pantry'],
    ['kitchenking masala',      'unit',  19,   10,  'Sauces, Syrups & Spices'],
    ['food color(opt)',         'unit',  10,   10,  'Other'],
    ['chat masala',             'unit',  9,    10,  'Sauces, Syrups & Spices'],
    ['white&black pepper',      'unit',  17,   10,  'Sauces, Syrups & Spices'],
    ['soya sause',              'unit',  14,   10,  'Sauces, Syrups & Spices'],
    ['red chilli sause',        'unit',  15,   10,  'Fresh Produce'],
    ['green chilli sause',      'unit',  29,   10,  'Fresh Produce'],
    ['venegar',                 'unit',  30,   10,  'Dairy & Ice Cream'],
    ['paneer',                  'unit',  23,   10,  'Fresh Produce'],
    ['mushroom',                'unit',  40,   10,  'Fresh Produce'],
    ['boneless chicken',        'unit',  41,   10,  'Meat & Protein'],
    ['maida',                   'unit',  47,   10,  'Dry Goods & Pantry'],
    ['turmeric',                'unit',  3,    10,  'Sauces, Syrups & Spices'],
    ['curryleaves',             'unit',  39,   10,  'Fresh Produce'],
    ['garam masala',            'unit',  12,   10,  'Sauces, Syrups & Spices'],
    ['red chilli',              'unit',  42,   10,  'Fresh Produce'],
    ['redchilli pow',           'unit',  18,   10,  'Sauces, Syrups & Spices'],
    ['soyasause',               'unit',  18,   10,  'Sauces, Syrups & Spices'],
    ['tomatosause',             'unit',  16,   10,  'Fresh Produce'],
    ['red&green chilli sause',  'unit',  9,    10,  'Fresh Produce'],
    ['chicken wings',           'unit',  25,   10,  'Meat & Protein'],
    ['pasta',                   'unit',  82,   20,  'Dry Goods & Pantry'],
    ['garlic',                  'unit',  43,   10,  'Fresh Produce'],
    ['black pepper',            'unit',  4,    10,  'Sauces, Syrups & Spices'],
    ['redchilli flex',          'unit',  20,   10,  'Sauces, Syrups & Spices'],
    ['origano',                 'unit',  12,   10,  'Sauces, Syrups & Spices'],
    ['muchroom(opt)',           'unit',  18,   10,  'Other'],
    ['paneer(opt',              'unit',  25,   10,  'Fresh Produce'],
    ['chicken(opt)',            'unit',  35,   10,  'Meat & Protein'],
    ['rice',                    'unit',  92,   20,  'Dry Goods & Pantry'],
    ['beans',                   'unit',  25,   10,  'Fresh Produce'],
    ['cabbage',                 'unit',  9,    10,  'Fresh Produce'],
    ['azinamoto(opt)',          'unit',  44,   20,  'Other'],
    ['black&white pepper',      'unit',  5,    10,  'Sauces, Syrups & Spices'],
    ['mashrooms',               'unit',  18,   10,  'Other'],
    ['eggs',                    'unit',  18,   10,  'Meat & Protein'],
    ['noodles',                 'unit',  18,   10,  'Dry Goods & Pantry'],
    ['french fries',            'unit',  57,   10,  'Dry Goods & Pantry'],
    ['periperi pow',            'g',     274,  90,  'Sauces, Syrups & Spices'],
    ['frech fires',             'gms',   5456, 1590,'Dry Goods & Pantry'],
    ['madras masala pow',       'g',     463,  140, 'Sauces, Syrups & Spices'],
    ['french fires',            'gms',   628,  190, 'Dry Goods & Pantry'],
    ['red chilli flex',         'unit',  40,   10,  'Fresh Produce'],
    ['coffee',                  'g',     389,  80,  'Sauces, Syrups & Spices'],
    ['filter',                  'ml',    1998, 440, 'Sauces, Syrups & Spices'],
    ['brownsugar',              'g',     1445, 480, 'Dry Goods & Pantry'],
    ['boost',                   'g',     1773, 430, 'Dry Goods & Pantry'],
    ['horlicks',                'g',     2225, 680, 'Dry Goods & Pantry'],
    ['teapow',                  'g',     2167, 660, 'Dry Goods & Pantry'],
    ['masala',                  'g',     486,  120, 'Sauces, Syrups & Spices'],
    ['greentea',                'unit',  72,   20,  'Dry Goods & Pantry'],
    ['honey',                   'g',     916,  200, 'Dry Goods & Pantry'],
    ['tea pow',                 'g',     266,  90,  'Other'],
    ['subseeds',                'g',     72,   10,  'Sauces, Syrups & Spices'],
  ];

  db.transaction(() => {
    for (const [name, unit, qty, reorder, cat] of ings)
      addIng.run(name, unit, qty, reorder, cat);
  })();

  const addItem = db.prepare(`
    INSERT OR IGNORE INTO menu_items (name, price, emoji, section, category, badge, description, isFeatured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ── YOUR REAL MENU from inventory.xlsx (126 items) ──
   const menuItems = [
    /*['classic sandwich', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['club san', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['hot and spicy san', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['periperisan', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['veg mayo sand', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['tandoori sand', 0, '🥪', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['mushroomsna', 0, '🍄', 'Other', 'beverage', null, null, 0],
    ['nutella', 0, '🍫', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['apple juice(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['avacado(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['banana juice(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['beetroot(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['carrot juice(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['dragon(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['muskmelon(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['pomegranate(milk)', 0, '🥤', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['grapes', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['pineapple', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['watermelon', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['ABC', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['CAP', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['CAG', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['BCCT', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['beetroot de', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['carrot de', 0, '🍽️', 'Juices & Milkshakes', 'beverage', null, null, 0],
    ['buttersc sh', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['chocolate', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['kiwi', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['litchi', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['mango', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['rosemilk', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['strawberry', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['vanilla', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['buttersc strawberry', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['mangostraw', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['black currant', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['kitkat', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['seedless dates', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['almond', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['hazelnut', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['pista', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['dry fruit', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['oreo', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['buttersc oreo', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['choco oreo', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['mango oreo', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['strawberry oreo', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['cold coffee', 0, '☕', 'Shakes', 'beverage', null, null, 0],
    ['chocolate coldcofe', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['strawberrycoldcoffee', 0, '☕', 'Shakes', 'beverage', null, null, 0],
    ['Fruit&nut falooda', 0, '🍨', 'Faloodas', 'beverage', null, null, 0],
    ['kesarpista', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['buttersc falooda', 0, '🍨', 'Faloodas', 'beverage', null, null, 0],
    ['blackcurrant', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['sweet lassi', 0, '🥛', 'Lassis', 'beverage', null, null, 0],
    ['muskmelon', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['buttersc', 0, '🍽️', 'Shakes', 'beverage', null, null, 0],
    ['blushingbride mojito', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['energitic blueberry', 0, '🍽️', 'Other', 'beverage', null, null, 0],
    ['chinese gooseberry', 0, '🍽️', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['litchi lemonade', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['mango mint lemonade', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['red devil', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['rose lemonade', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['sparkling blackcurrant', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['virgin mojito', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['blue lagoon', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['wonderful watermelon', 0, '🍹', 'Other', 'beverage', null, null, 0],
    ['midnight beauty', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['sea blossoms', 0, '🍹', 'Mojitos & Coolers', 'beverage', null, null, 0],
    ['awsome sundae', 0, '🍧', 'Ice Cream Sundaes', 'food', null, null, 0],
    ['black&white', 0, '🍧', 'Ice Cream Sundaes', 'food', null, null, 0],
    ['king of fruit....', 0, '🍧', 'Ice Cream Sundaes', 'food', null, null, 0],
    ['heaven of ice cream', 0, '🍧', 'Ice Cream Sundaes', 'food', null, null, 0],
    ['choco berry with vanilla', 0, '🍧', 'Shakes', 'beverage', null, null, 0],
    ['nuts with scotch', 0, '🍧', 'Ice Cream Sundaes', 'food', null, null, 0],
    ['choco king', 0, '🍧', 'Shakes', 'beverage', null, null, 0],
    ['hot brownie fudge', 0, '🍰', 'Desserts', 'food', null, null, 0],
    ['dryfuit brownie fudge', 0, '🍰', 'Desserts', 'food', null, null, 0],
    ['hot ven fudge', 0, '🍰', 'Desserts', 'food', null, null, 0],
    ['hot choco brownie', 0, '🍰', 'Shakes', 'beverage', null, null, 0],
    ['veg burger', 0, '🍔', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['chicken burgur', 0, '🍔', 'Sandwiches & Burgers', 'food', null, null, 0],
    ['veg manchurian', 0, '🍄', 'Starters', 'food', null, null, 0],
    ['paneeer manchu', 0, '🍄', 'Starters', 'food', null, null, 0],
    ['mushroom manchu', 0, '🍄', 'Starters', 'food', null, null, 0],
    ['chicken manchu', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['chicken 65', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['mushroom 65', 0, '🍄', 'Starters', 'food', null, null, 0],
    ['paneer 65', 0, '🧀', 'Starters', 'food', null, null, 0],
    ['chilli chicken', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['pepper chicken', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['chicken lolipop', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['dragon chicken', 0, '🍗', 'Starters', 'food', null, null, 0],
    ['kalayika special chic', 0, '🍽️', 'Starters', 'food', null, null, 0],
    ['pasta', 0, '🍜', 'Mains', 'food', null, null, 0],
    ['veg fied rice', 0, '🍚', 'Mains', 'food', null, null, 0],
    ['mashroom fr', 0, '🍽️', 'Mains', 'food', null, null, 0],
    ['egg fr', 0, '🍽️', 'Mains', 'food', null, null, 0],
    ['paneer fr', 0, '🧀', 'Mains', 'food', null, null, 0],
    ['chicken fr', 0, '🍗', 'Mains', 'food', null, null, 0],
    ['veg noodles', 0, '🍜', 'Mains', 'food', null, null, 0],
    ['paneer noodles', 0, '🧀', 'Mains', 'food', null, null, 0],
    ['egg noodles', 0, '🍜', 'Mains', 'food', null, null, 0],
    ['mushroom nod', 0, '🍄', 'Mains', 'food', null, null, 0],
    ['chicken noodles', 0, '🍗', 'Mains', 'food', null, null, 0],
    ['periperifrench fires', 0, '🍟', 'Snacks', 'food', null, null, 0],
    ['fried momo', 0, '🥟', 'Snacks', 'food', null, null, 0],
    ['veg role', 0, '🌯', 'Snacks', 'food', null, null, 0],
    ['paneer role', 0, '🧀', 'Snacks', 'food', null, null, 0],
    ['veg nuggets', 0, '🍗', 'Snacks', 'food', null, null, 0],
    ['veg fingers', 0, '🍗', 'Snacks', 'food', null, null, 0],
    ['chicken role', 0, '🍗', 'Snacks', 'food', null, null, 0],
    ['salted french fries', 0, '🍟', 'Snacks', 'food', null, null, 0],
    ['madras msala ff', 0, '🍽️', 'Snacks', 'food', null, null, 0],
    ['cheesy chilli', 0, '🍽️', 'Snacks', 'food', null, null, 0],
    ['coffee(beverages)', 0, '☕', 'Hot Beverages', 'beverage', null, null, 0],
    ['filter coffee', 0, '☕', 'Hot Beverages', 'beverage', null, null, 0],
    ['karupati coffee', 0, '☕', 'Hot Beverages', 'beverage', null, null, 0],
    ['badam milk', 0, '🥛', 'Hot Beverages', 'beverage', null, null, 0],
    ['boost', 0, '🥛', 'Hot Beverages', 'beverage', null, null, 0],
    ['horlicks', 0, '🥛', 'Hot Beverages', 'beverage', null, null, 0],
    ['tea', 0, '🍵', 'Hot Beverages', 'beverage', null, null, 0],
    ['bellam tea', 0, '🍵', 'Hot Beverages', 'beverage', null, null, 0],
    ['greentea', 0, '🍵', 'Hot Beverages', 'beverage', null, null, 0],*/
    ['lemon tea', 0, '🍵', 'Hot Beverages', 'beverage', null, null, 0],
  ];

  for (const row of menuItems) addItem.run(...row);
  console.log(`✅  Seeded ${menuItems.length} menu items and ${ings.length} real ingredients from Excel.`);
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
  const validSections = new Set(['coffees','cold','shakes','food','snacks','desserts','icecreams']);
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

      // Build invoice — tagged with branch location
      const prefix    = loc.slice(0, 3).toUpperCase();
      const invoiceNo = `MACH-${prefix}-${Date.now()}`;
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

app.listen(PORT, () => {
  console.log(`\n☕  MACH Cafe running at http://localhost:${PORT}`);
  console.log(`\n📋  HOW TO VIEW THE DATABASE:`);
  console.log(`    Option 1 (browser UI): npx @sqlite-viewer/app velvetbean.db`);
  console.log(`    Option 2 (terminal):   sqlite3 velvetbean.db`);
  console.log(`\n    Default owner password: velvetbean2024`);
  console.log(`    ⚠️  Change OWNER_PASSWORD_HASH and JWT_SECRET before going live!`);
});