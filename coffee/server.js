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

// ═══════════════════════════════════════════════════════
//  DATABASE SETUP
// ═══════════════════════════════════════════════════════

const db = new Database(path.join(__dirname, 'velvetbean.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');


// ── MIGRATION: add location column + fix UNIQUE constraint + seed branches ──
(function migrate() {
  const invCols = db.pragma('table_info(invoices)').map(c => c.name);
  const ingCols = db.pragma('table_info(ingredients)').map(c => c.name);

  if (!invCols.includes('location')) {
    console.log('🔧  Migration: adding location to invoices…');
    db.exec(`ALTER TABLE invoices ADD COLUMN location TEXT NOT NULL DEFAULT 'guntupalli'`);
  }
  if (!ingCols.includes('location')) {
    console.log('🔧  Migration: adding location to ingredients…');
    db.exec(`ALTER TABLE ingredients ADD COLUMN location TEXT NOT NULL DEFAULT 'guntupalli'`);
  }

  // ── Fix: the old table schema had UNIQUE(name) globally, which blocks inserting
  //    the same ingredient name for multiple branches (ongole, kodaikanal, etc.).
  //    Detect via sqlite_autoindex and rebuild the table to UNIQUE(name, location).
  const indexes = db.pragma('index_list(ingredients)').map(i => i.name);
  const hasOldGlobalUnique = indexes.some(n => /sqlite_autoindex_ingredients/i.test(n));
  if (hasOldGlobalUnique) {
    console.log('🔧  Migration: rebuilding ingredients table — UNIQUE(name) → UNIQUE(name, location)…');
    db.exec(`
      BEGIN;
      ALTER TABLE ingredients RENAME TO _ingredients_old;
      CREATE TABLE ingredients (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        unit         TEXT    NOT NULL DEFAULT 'units',
        currentQty   REAL    NOT NULL DEFAULT 0,
        reorderLevel REAL    NOT NULL DEFAULT 10,
        location     TEXT    NOT NULL DEFAULT 'guntupalli',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(name, location)
      );
      INSERT INTO ingredients (id, name, unit, currentQty, reorderLevel, location, created_at)
        SELECT id, name, unit, currentQty, reorderLevel, location, created_at FROM _ingredients_old;
      DROP TABLE _ingredients_old;
      COMMIT;
    `);
    console.log('✅  Ingredients table rebuilt with UNIQUE(name, location).');
  } else {
    // Fresh install or already rebuilt — ensure composite unique index exists
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ing_name_loc ON ingredients(name, location)`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inv_loc ON invoices(location);
    CREATE INDEX IF NOT EXISTS idx_ing_loc  ON ingredients(location);
  `);

  // ── Seed Ongole & Kodaikanal stock from Guntupalli if their rows are missing ──
  for (const loc of ['ongole', 'kodaikanal']) {
    const already = db.prepare('SELECT COUNT(*) AS c FROM ingredients WHERE location = ?').get(loc).c;
    if (already === 0) {
      console.log(`🌱  Seeding ${loc} ingredients from guntupalli…`);
      db.exec(`
        INSERT OR IGNORE INTO ingredients (location, name, unit, currentQty, reorderLevel)
        SELECT '${loc}', name, unit, currentQty, reorderLevel
        FROM ingredients WHERE location = 'guntupalli'
      `);
      const seeded = db.prepare('SELECT COUNT(*) AS c FROM ingredients WHERE location = ?').get(loc).c;
      console.log(`✅  Seeded ${seeded} ingredients for ${loc}.`);
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
    name         TEXT    NOT NULL,
    unit         TEXT    NOT NULL DEFAULT 'units',
    currentQty   REAL    NOT NULL DEFAULT 0,
    reorderLevel REAL    NOT NULL DEFAULT 10,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
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

  /* ── Indexes ────────────────────────────────────────── */
  CREATE INDEX IF NOT EXISTS idx_inv_cust  ON invoices(customerId);
  CREATE INDEX IF NOT EXISTS idx_inv_ts    ON invoices(timestamp);
  CREATE INDEX IF NOT EXISTS idx_oi_inv    ON order_items(invoiceId);
  CREATE INDEX IF NOT EXISTS idx_mii_item  ON menu_item_ingredients(menuItemId);
  CREATE INDEX IF NOT EXISTS idx_log_item  ON inventory_logs(itemId);
`);

// ── MIGRATION: populate menu_item_ingredients if empty ──────────
(function migrateRecipes() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;
  if (count > 0) return;
  console.log('🔧  Migration: seeding recipe links...');
  const recipes = [
    ['Espresso','Espresso Beans',2],
    ['Americano','Espresso Beans',2],
    ['Cappuccino','Espresso Beans',2],
    ['Cappuccino','Whole Milk',100],
    ['Latte','Espresso Beans',2],
    ['Latte','Whole Milk',200],
    ['Mocha','Espresso Beans',2],
    ['Mocha','Whole Milk',150],
    ['Mocha','Dark Chocolate Sauce',30],
    ['Caramel Latte','Espresso Beans',2],
    ['Caramel Latte','Whole Milk',200],
    ['Caramel Latte','Caramel Syrup',30],
    ['Hazelnut Latte','Espresso Beans',2],
    ['Hazelnut Latte','Whole Milk',200],
    ['Hazelnut Latte','Hazelnut Syrup',30],
    ['Masala Chai','Masala Chai Mix',20],
    ['Masala Chai','Whole Milk',150],
    ['Matcha Latte','Matcha Powder',5],
    ['Matcha Latte','Oat Milk',200],
    ['Hot Chocolate','Dark Chocolate Sauce',40],
    ['Hot Chocolate','Whole Milk',200],
    ['Hot Chocolate','Whipped Cream',30],
    ['Cold Brew','Cold Brew Concentrate',120],
    ['Iced Latte','Espresso Beans',2],
    ['Iced Latte','Whole Milk',150],
    ['Iced Mocha','Espresso Beans',2],
    ['Iced Mocha','Dark Chocolate Sauce',30],
    ['Iced Mocha','Whole Milk',120],
    ['Caramel Cold Brew','Cold Brew Concentrate',120],
    ['Caramel Cold Brew','Caramel Syrup',30],
    ['Affogato','Espresso Beans',2],
    ['Affogato','Vanilla Ice Cream',2],
    ['Matcha Frappe','Matcha Powder',8],
    ['Matcha Frappe','Oat Milk',150],
    ['Hibiscus Cooler','Hibiscus Tea',5],
    ['Hibiscus Cooler','Lemon Juice',30],
    ['Hibiscus Cooler','Fresh Mint',3],
    ['Hibiscus Cooler','Sparkling Water',150],
    ['Blueberry Lemonade','Blueberry Reduction',40],
    ['Blueberry Lemonade','Lemon Juice',30],
    ['Blueberry Lemonade','Sparkling Water',150],
    ['Mango Lassi','Mango Pulp',100],
    ['Mango Lassi','Yoghurt',100],
    ['Mint Sparkling Water','Fresh Mint',3],
    ['Mint Sparkling Water','Sparkling Water',200],
    ['Vanilla Scoop','Vanilla Ice Cream',1],
    ['Strawberry Scoop','Strawberry Ice Cream',1],
    ['Coconut Scoop','Coconut Ice Cream',1],
    ['Two Scoop Bowl','Vanilla Ice Cream',1],
    ['Two Scoop Bowl','Strawberry Ice Cream',1],
    ['Avocado Toast','Sourdough Bread',2],
    ['Cheese Toast','Sourdough Bread',2],
    ['Cheese Toast','Cheese Blend',50],
    ['Egg Toast','Multigrain Bread',2],
    ['Egg Toast','Eggs',2],
    ['Paneer Wrap','Wheat Tortilla',1],
    ['Paneer Wrap','Paneer',80],
    ['PB Toast','White Bread',2],
    ['PB Toast','Peanut Butter',30],
    ['Veg Hakka Noodles','Hakka Noodles',100],
    ['Paneer Fried Rice','Basmati Rice',150],
    ['Paneer Fried Rice','Paneer',60],
    ['Paneer Fried Rice','Eggs',1],
    ['Butter Croissant','Croissant Dough',1],
    ['Chocolate Croissant','Croissant Dough',1],
    ['Chocolate Croissant','Chocolate Chips',20],
    ['Blueberry Muffin','Blueberries',30],
    ['Tiramisu','Mascarpone',80],
    ['Tiramisu','Savoiardi',6],
    ['Tiramisu','Espresso Beans',2],
    ['Tiramisu','Cocoa Powder',5],
    ['Coconut Panna Cotta','Coconut Milk',150],
    ['Coconut Panna Cotta','Agar Agar',3],
    ['Coconut Panna Cotta','Mango Pulp',40],
  ];
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
    SELECT m.id, i.id, ?
    FROM menu_items m, ingredients i
    WHERE m.name = ? AND i.name = ? AND i.location = 'guntupalli'
  `);
  const run = db.transaction((rows) => { for (const r of rows) stmt.run(r[2], r[0], r[1]); });
  run(recipes);
  const inserted = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;
  console.log('✅  Recipe migration done: ' + inserted + ' links created.');
})();


// ═══════════════════════════════════════════════════════
//  SEED  (only runs once when tables are empty)
// ═══════════════════════════════════════════════════════

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c > 0) return;
  console.log('🌱  First run — seeding database…');

  const addIng = db.prepare(`
    INSERT OR IGNORE INTO ingredients (name, unit, currentQty, reorderLevel, location)
    VALUES (?, ?, ?, ?, 'guntupalli')
  `);
  const ings = [
    ['Espresso Beans',       'shots',   500,  50],
    ['Whole Milk',           'ml',    10000, 1000],
    ['Oat Milk',             'ml',     5000,  500],
    ['Dark Chocolate Sauce', 'ml',     3000,  300],
    ['Caramel Syrup',        'ml',     2000,  200],
    ['Hazelnut Syrup',       'ml',     1500,  150],
    ['Matcha Powder',        'g',      1000,  100],
    ['Masala Chai Mix',      'g',      1000,  100],
    ['Cocoa Powder',         'g',       500,   50],
    ['Whipped Cream',        'ml',     2000,  200],
    ['Cold Brew Concentrate','ml',     5000,  500],
    ['Lemon Juice',          'ml',     2000,  200],
    ['Hibiscus Tea',         'g',       500,   50],
    ['Blueberry Reduction',  'ml',     1000,  100],
    ['Fresh Mint',           'g',       500,   50],
    ['Sparkling Water',      'ml',    10000, 1000],
    ['Vanilla Ice Cream',    'scoops',  200,   20],
    ['Strawberry Ice Cream', 'scoops',  150,   15],
    ['Coconut Ice Cream',    'scoops',  100,   10],
    ['Mango Pulp',           'ml',     3000,  300],
    ['Yoghurt',              'ml',     3000,  300],
    ['Sourdough Bread',      'slices',  100,   20],
    ['Cheese Blend',         'g',      2000,  200],
    ['Eggs',                 'units',   200,   30],
    ['Multigrain Bread',     'slices',  100,   20],
    ['Paneer',               'g',      2000,  300],
    ['Wheat Tortilla',       'units',   100,   20],
    ['Hakka Noodles',        'g',      3000,  300],
    ['Basmati Rice',         'g',      5000,  500],
    ['Croissant Dough',      'units',    50,   10],
    ['Chocolate Chips',      'g',      2000,  200],
    ['Blueberries',          'g',      1000,  100],
    ['White Bread',          'slices',  100,   20],
    ['Potatoes',             'g',      5000,  500],
    ['Peanut Butter',        'g',      1000,  100],
    ['Cream Cheese',         'g',      2000,  200],
    ['Mascarpone',           'g',      1000,  100],
    ['Savoiardi',            'units',   200,   30],
    ['Coconut Milk',         'ml',     3000,  300],
    ['Agar Agar',            'g',       200,   20],
  ];
  for (const [name, unit, qty, reorder] of ings) addIng.run(name, unit, qty, reorder);

  const addItem = db.prepare(`
    INSERT OR IGNORE INTO menu_items (name, price, emoji, section, category, badge, description, isFeatured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const menuItems = [
    // ── HOT COFFEES ──────────────────────────────────────
    ['Espresso',             120, '☕', 'Hot Coffees',    'beverage', null,        'Double shot of our house espresso blend', 0],
    ['Americano',            140, '☕', 'Hot Coffees',    'beverage', null,        'Espresso diluted with hot water',         0],
    ['Cappuccino',           160, '☕', 'Hot Coffees',    'beverage', 'Popular',   'Equal parts espresso, steamed milk, foam',1],
    ['Latte',                170, '☕', 'Hot Coffees',    'beverage', null,        'Espresso with steamed milk',              0],
    ['Mocha',                190, '☕', 'Hot Coffees',    'beverage', null,        'Espresso with chocolate and steamed milk', 0],
    ['Caramel Latte',        200, '🍮', 'Hot Coffees',   'beverage', null,        'Latte with house caramel syrup',           0],
    ['Hazelnut Latte',       200, '🌰', 'Hot Coffees',   'beverage', null,        'Latte with hazelnut syrup',                0],

    // ── HOT NON-COFFEE ───────────────────────────────────
    ['Masala Chai',          120, '🍵', 'Hot Non-Coffee','beverage', null,        'Spiced Indian tea with milk',              0],
    ['Matcha Latte',         180, '🍵', 'Hot Non-Coffee','beverage', 'New',       'Ceremonial matcha with steamed oat milk',  1],
    ['Hot Chocolate',        160, '🍫', 'Hot Non-Coffee','beverage', null,        'Rich dark chocolate with steamed milk',    0],

    // ── COLD COFFEES ─────────────────────────────────────
    ['Cold Brew',            180, '🧊', 'Cold Coffees',  'beverage', null,        '18-hour cold steeped concentrate',         0],
    ['Iced Latte',           180, '🧊', 'Cold Coffees',  'beverage', 'Popular',   'Espresso over ice with cold milk',         1],
    ['Iced Mocha',           200, '🧊', 'Cold Coffees',  'beverage', null,        'Iced espresso with chocolate',             0],
    ['Caramel Cold Brew',    210, '🍮', 'Cold Coffees',  'beverage', null,        'Cold brew with caramel drizzle',           0],
    ['Affogato',             220, '🍨', 'Cold Coffees',  'beverage', 'Signature', 'Espresso poured over vanilla ice cream',   1],

    // ── COLD NON-COFFEE ──────────────────────────────────
    ['Matcha Frappe',        200, '🍵', 'Cold Non-Coffee','beverage','New',       'Blended matcha with oat milk and ice',     0],
    ['Hibiscus Cooler',      160, '🌺', 'Cold Non-Coffee','beverage',null,        'Hibiscus tea with lemon and mint',         0],
    ['Blueberry Lemonade',   170, '🫐', 'Cold Non-Coffee','beverage',null,        'House blueberry reduction with lemon soda',0],
    ['Mango Lassi',          160, '🥭', 'Cold Non-Coffee','beverage',null,        'Mango pulp blended with yoghurt',          0],
    ['Mint Sparkling Water', 120, '💧', 'Cold Non-Coffee','beverage',null,        'Sparkling water with fresh mint',          0],

    // ── ICE CREAMS ───────────────────────────────────────
    ['Vanilla Scoop',        100, '🍨', 'Ice Creams',    'food',     null,        'Single scoop vanilla ice cream',           0],
    ['Strawberry Scoop',     100, '🍓', 'Ice Creams',    'food',     null,        'Single scoop strawberry ice cream',        0],
    ['Coconut Scoop',        110, '🥥', 'Ice Creams',    'food',     null,        'Single scoop coconut ice cream',           0],
    ['Two Scoop Bowl',       180, '🍨', 'Ice Creams',    'food',     'Popular',   'Any two scoops with wafer',                0],

    // ── TOASTS & SANDWICHES ──────────────────────────────
    ['Avocado Toast',        220, '🥑', 'Toasts',        'food',     null,        'Sourdough with seasoned avocado',          0],
    ['Cheese Toast',         180, '🧀', 'Toasts',        'food',     null,        'Sourdough with melted cheese blend',       0],
    ['Egg Toast',            190, '🍳', 'Toasts',        'food',     null,        'Multigrain toast with scrambled eggs',     0],
    ['Paneer Wrap',          210, '🌯', 'Toasts',        'food',     'Popular',   'Wheat tortilla with spiced paneer',        1],
    ['PB Toast',             160, '🥜', 'Toasts',        'food',     null,        'White bread with peanut butter',           0],

    // ── MAINS ────────────────────────────────────────────
    ['Veg Hakka Noodles',    240, '🍜', 'Mains',         'food',     null,        'Stir-fried noodles with vegetables',       0],
    ['Paneer Fried Rice',    260, '🍚', 'Mains',         'food',     'Chef Pick', 'Basmati rice with paneer and spices',      1],

    // ── BAKERY ───────────────────────────────────────────
    ['Butter Croissant',     140, '🥐', 'Bakery',        'food',     null,        'Freshly baked flaky croissant',            0],
    ['Chocolate Croissant',  160, '🥐', 'Bakery',        'food',     null,        'Croissant with chocolate chip filling',    0],
    ['Blueberry Muffin',     150, '🫐', 'Bakery',        'food',     null,        'Soft muffin with blueberry centre',        0],

    // ── DESSERTS ─────────────────────────────────────────
    ['Tiramisu',             280, '🍰', 'Desserts',      'food',     'Signature', 'Classic mascarpone and espresso dessert',  1],
    ['Coconut Panna Cotta',  260, '🥥', 'Desserts',      'food',     null,        'Set coconut milk pudding with mango',      0],
  ];

  for (const row of menuItems) addItem.run(...row);

  // ── RECIPES: link menu items to their ingredients ──────────────
  // Format: [ menuItemName, ingredientName, qtyPerServing ]
  // Only runs on first seed (INSERT OR IGNORE handles re-runs safely)
  const recipes = [
    // HOT COFFEES
    ['Espresso',          'Espresso Beans',        2],
    ['Americano',         'Espresso Beans',        2],
    ['Cappuccino',        'Espresso Beans',        2],
    ['Cappuccino',        'Whole Milk',          100],
    ['Latte',             'Espresso Beans',        2],
    ['Latte',             'Whole Milk',          200],
    ['Mocha',             'Espresso Beans',        2],
    ['Mocha',             'Whole Milk',          150],
    ['Mocha',             'Dark Chocolate Sauce',  30],
    ['Caramel Latte',     'Espresso Beans',        2],
    ['Caramel Latte',     'Whole Milk',          200],
    ['Caramel Latte',     'Caramel Syrup',         30],
    ['Hazelnut Latte',    'Espresso Beans',        2],
    ['Hazelnut Latte',    'Whole Milk',          200],
    ['Hazelnut Latte',    'Hazelnut Syrup',        30],
    // HOT NON-COFFEE
    ['Masala Chai',       'Masala Chai Mix',       20],
    ['Masala Chai',       'Whole Milk',           150],
    ['Matcha Latte',      'Matcha Powder',          5],
    ['Matcha Latte',      'Oat Milk',             200],
    ['Hot Chocolate',     'Dark Chocolate Sauce',  40],
    ['Hot Chocolate',     'Whole Milk',           200],
    ['Hot Chocolate',     'Whipped Cream',         30],
    // COLD COFFEES
    ['Cold Brew',             'Cold Brew Concentrate', 120],
    ['Iced Latte',            'Espresso Beans',          2],
    ['Iced Latte',            'Whole Milk',            150],
    ['Iced Mocha',            'Espresso Beans',          2],
    ['Iced Mocha',            'Dark Chocolate Sauce',   30],
    ['Iced Mocha',            'Whole Milk',            120],
    ['Caramel Cold Brew',     'Cold Brew Concentrate', 120],
    ['Caramel Cold Brew',     'Caramel Syrup',          30],
    ['Affogato',              'Espresso Beans',          2],
    ['Affogato',              'Vanilla Ice Cream',       2],
    // COLD NON-COFFEE
    ['Matcha Frappe',         'Matcha Powder',           8],
    ['Matcha Frappe',         'Oat Milk',              150],
    ['Hibiscus Cooler',       'Hibiscus Tea',            5],
    ['Hibiscus Cooler',       'Lemon Juice',            30],
    ['Hibiscus Cooler',       'Fresh Mint',              3],
    ['Hibiscus Cooler',       'Sparkling Water',       150],
    ['Blueberry Lemonade',    'Blueberry Reduction',    40],
    ['Blueberry Lemonade',    'Lemon Juice',            30],
    ['Blueberry Lemonade',    'Sparkling Water',       150],
    ['Mango Lassi',           'Mango Pulp',            100],
    ['Mango Lassi',           'Yoghurt',               100],
    ['Mint Sparkling Water',  'Fresh Mint',              3],
    ['Mint Sparkling Water',  'Sparkling Water',       200],
    // ICE CREAMS
    ['Vanilla Scoop',         'Vanilla Ice Cream',       1],
    ['Strawberry Scoop',      'Strawberry Ice Cream',    1],
    ['Coconut Scoop',         'Coconut Ice Cream',       1],
    ['Two Scoop Bowl',        'Vanilla Ice Cream',       1],
    ['Two Scoop Bowl',        'Strawberry Ice Cream',    1],
    // TOASTS & SANDWICHES
    ['Avocado Toast',         'Sourdough Bread',         2],
    ['Cheese Toast',          'Sourdough Bread',         2],
    ['Cheese Toast',          'Cheese Blend',           50],
    ['Egg Toast',             'Multigrain Bread',        2],
    ['Egg Toast',             'Eggs',                    2],
    ['Paneer Wrap',           'Wheat Tortilla',          1],
    ['Paneer Wrap',           'Paneer',                 80],
    ['PB Toast',              'White Bread',             2],
    ['PB Toast',              'Peanut Butter',          30],
    // MAINS
    ['Veg Hakka Noodles',     'Hakka Noodles',         100],
    ['Paneer Fried Rice',     'Basmati Rice',          150],
    ['Paneer Fried Rice',     'Paneer',                 60],
    ['Paneer Fried Rice',     'Eggs',                    1],
    // BAKERY
    ['Butter Croissant',      'Croissant Dough',         1],
    ['Chocolate Croissant',   'Croissant Dough',         1],
    ['Chocolate Croissant',   'Chocolate Chips',        20],
    ['Blueberry Muffin',      'Blueberries',            30],
    // DESSERTS
    ['Tiramisu',              'Mascarpone',             80],
    ['Tiramisu',              'Savoiardi',               6],
    ['Tiramisu',              'Espresso Beans',          2],
    ['Tiramisu',              'Cocoa Powder',            5],
    ['Coconut Panna Cotta',   'Coconut Milk',          150],
    ['Coconut Panna Cotta',   'Agar Agar',               3],
    ['Coconut Panna Cotta',   'Mango Pulp',             40],
  ];

  const linkRecipe = db.prepare(`
    INSERT OR IGNORE INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
    SELECT m.id, i.id, ?
    FROM menu_items m, ingredients i
    WHERE m.name = ? AND i.name = ? AND i.location = 'guntupalli'
  `);
  for (const [menuName, ingName, qty] of recipes) linkRecipe.run(qty, menuName, ingName);
  console.log(`✅  Seeded ${menuItems.length} menu items, ${ings.length} ingredients, ${recipes.length} recipe links.`);
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
// Section name → HTML section ID mapping
const SECTION_ID_MAP = {
  'hot coffees':     'coffees',
  'hot non-coffee':  'coffees',
  'cold coffees':    'cold',
  'cold non-coffee': 'cold',
  'ice creams':      'shakes',
  'shakes':          'shakes',
  'shakes & specials': 'shakes',
  'food':            'food',
  'toasts':          'food',
  'toasts & sandwiches': 'food',
  'mains':           'food',
  'snacks':          'snacks',
  'snacks & bakes':  'snacks',
  'bakery':          'snacks',
  'desserts':        'desserts',
  // pass-through for already-correct IDs
  'coffees':         'coffees',
  'cold':            'cold',
};

app.get('/api/menu', (req, res) => {
  const raw = db.prepare('SELECT * FROM menu_items ORDER BY section, name').all();
  const items = raw.map(item => ({
    ...item,
    isAvailable: item.isAvailable === 1 || item.isAvailable === true,
    isFeatured:  item.isFeatured  === 1 || item.isFeatured  === true,
    section: SECTION_ID_MAP[item.section.toLowerCase().trim()] || item.section.toLowerCase().trim(),
  }));
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

/* DELETE menu item — Owner only */
app.delete('/api/menu/:id', requireOwner, (req, res) => {
  if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.id))
    return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


// ═══════════════════════════════════════════════════════
//  API — MENU EXCEL IMPORT  (no auth — cashier/manager)
// ═══════════════════════════════════════════════════════

/* POST /api/menu/import-excel
   Accepts rows from SheetJS. Handles TWO Excel formats:
   FORMAT A (your actual file): Category | Subcategory | Item Name | Price (INR)
   FORMAT B (generic):          name | price | section | emoji | badge | description | isAvailable | isFeatured | category */
app.post('/api/menu/import-excel', (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  // Map your Category values → HTML section IDs stored in DB
  const CATEGORY_TO_SECTION = {
    'snacks':            'Snacks',
    'juices':            'Cold Non-Coffee',
    'shakes':            'Shakes',
    'falooda':           'Shakes',
    'lassi':             'Shakes',
    'mojitos':           'Cold Non-Coffee',
    'sundaes (triples)': 'Desserts',
    'sundaes':           'Desserts',
    'brownies':          'Desserts',
    'beverages':         'Hot Non-Coffee',
    'hot coffees':       'Hot Coffees',
    'hot non-coffee':    'Hot Non-Coffee',
    'cold coffees':      'Cold Coffees',
    'cold non-coffee':   'Cold Non-Coffee',
    'food':              'Food',
    'toasts':            'Toasts',
    'mains':             'Mains',
    'bakery':            'Bakery',
    'desserts':          'Desserts',
    'coffees':           'Hot Coffees',
    'cold':              'Cold Coffees',
  };

  // Emoji map by subcategory/category keyword
  function guessEmoji(cat, subcat, name) {
    const s = (cat + ' ' + subcat + ' ' + name).toLowerCase();
    if (s.includes('coffee') || s.includes('filter')) return '☕';
    if (s.includes('tea'))    return '🍵';
    if (s.includes('shake') || s.includes('milkshake')) return '🥤';
    if (s.includes('lassi'))  return '🥛';
    if (s.includes('falooda')) return '🍨';
    if (s.includes('juice'))  return '🧃';
    if (s.includes('mojito') || s.includes('lemonade')) return '🍹';
    if (s.includes('sundae') || s.includes('ice cream')) return '🍦';
    if (s.includes('brownie')) return '🍫';
    if (s.includes('sandwich')) return '🥪';
    if (s.includes('momo'))   return '🥟';
    if (s.includes('roll'))   return '🌯';
    if (s.includes('fries') || s.includes('fingers') || s.includes('nugget')) return '🍟';
    if (s.includes('snack'))  return '🍿';
    if (s.includes('badam') || s.includes('almond')) return '🥜';
    if (s.includes('mango'))  return '🥭';
    if (s.includes('strawberry')) return '🍓';
    if (s.includes('chocolate') || s.includes('choco')) return '🍫';
    if (s.includes('pista'))  return '🌿';
    if (s.includes('watermelon')) return '🍉';
    if (s.includes('banana')) return '🍌';
    return '🍽️';
  }

  function parseBool(val, def) {
    if (val === undefined || val === null || val === '') return def;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    return ['true', '1', 'yes'].includes(String(val).toLowerCase().trim());
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO menu_items (name, price, emoji, section, category, badge, description, isFeatured, isAvailable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const results = { inserted: 0, updated: 0, errors: [] };

  db.transaction(() => {
    // ── Wipe all existing menu items so only Excel items remain ──
    db.prepare('DELETE FROM menu_items').run();
    results.inserted = 0; // reset, all will be inserts now

    for (const row of rows) {
      // ── Detect format ──────────────────────────────────────────
      // Format A: has "Item Name" and "Price (INR)"
      // Format B: has "name" and "price"
      const isFormatA = ('Item Name' in row) || ('item name' in row);

      let name, price, section, emoji, badge, description, isFeatured, isAvailable, itemCategory;

      if (isFormatA) {
        // Your actual Excel format
        const cat    = String(row['Category']    || row['category']    || '').trim();
        const subcat = String(row['Subcategory'] || row['subcategory'] || '').trim();
        name         = String(row['Item Name']   || row['item name']   || '').trim();
        price        = parseInt(String(row['Price (INR)'] || row['price (inr)'] || row['Price'] || 0));
        section      = CATEGORY_TO_SECTION[cat.toLowerCase()] || 'Snacks';
        emoji        = guessEmoji(cat, subcat, name);
        badge        = subcat && subcat.toLowerCase() !== cat.toLowerCase() ? subcat : null;
        description  = String(row['Description'] || row['description'] || '').trim() || null;
        isFeatured   = 0;
        isAvailable  = 1;
        // beverages vs food classification
        const beverageCategories = ['juices','shakes','mojitos','lassi','falooda','beverages','coffees','cold coffees','hot coffees','hot non-coffee','cold non-coffee'];
        itemCategory = beverageCategories.includes(cat.toLowerCase()) ? 'beverage' : 'food';
      } else {
        // Generic format B
        name         = String(row.name  || row.Name  || '').trim();
        price        = parseInt(row.price || row.Price || 0);
        const rawSec = String(row.section || row.Section || '').trim().toLowerCase();
        section      = CATEGORY_TO_SECTION[rawSec] || String(row.section || row.Section || 'Snacks').trim();
        emoji        = String(row.emoji  || row.Emoji  || '🍽️').trim();
        badge        = String(row.badge  || row.Badge  || '').trim() || null;
        description  = String(row.description || row.Description || '').trim() || null;
        isFeatured   = parseBool(row.isFeatured || row.featured, false) ? 1 : 0;
        isAvailable  = parseBool(row.isAvailable ?? row.available, true) ? 1 : 0;
        itemCategory = String(row.category || row.Category || 'beverage').trim().toLowerCase();
      }

      if (!name || !price) {
        if (name || price) results.errors.push('Skipped (missing name or price): ' + name);
        continue;
      }

      try {
        upsert.run(name, price, emoji, section, itemCategory, badge, description, isFeatured, isAvailable);
        results.inserted++;
      } catch(e) {
        results.errors.push(name + ': ' + e.message);
      }
    }

    // ── Re-seed recipe links — DELETE FROM menu_items cascade-wiped them ──────
    const _relink = db.prepare(`
      INSERT OR IGNORE INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
      SELECT m.id, i.id, ?
      FROM menu_items m, ingredients i
      WHERE m.name = ? AND i.name = ? AND i.location = 'guntupalli'
    `);
    const _recipes = [
      ['Espresso','Espresso Beans',2],['Americano','Espresso Beans',2],
      ['Cappuccino','Espresso Beans',2],['Cappuccino','Whole Milk',100],
      ['Latte','Espresso Beans',2],['Latte','Whole Milk',200],
      ['Mocha','Espresso Beans',2],['Mocha','Whole Milk',150],['Mocha','Dark Chocolate Sauce',30],
      ['Caramel Latte','Espresso Beans',2],['Caramel Latte','Whole Milk',200],['Caramel Latte','Caramel Syrup',30],
      ['Hazelnut Latte','Espresso Beans',2],['Hazelnut Latte','Whole Milk',200],['Hazelnut Latte','Hazelnut Syrup',30],
      ['Masala Chai','Masala Chai Mix',20],['Masala Chai','Whole Milk',150],
      ['Matcha Latte','Matcha Powder',5],['Matcha Latte','Oat Milk',200],
      ['Hot Chocolate','Dark Chocolate Sauce',40],['Hot Chocolate','Whole Milk',200],['Hot Chocolate','Whipped Cream',30],
      ['Cold Brew','Cold Brew Concentrate',120],
      ['Iced Latte','Espresso Beans',2],['Iced Latte','Whole Milk',150],
      ['Iced Mocha','Espresso Beans',2],['Iced Mocha','Dark Chocolate Sauce',30],['Iced Mocha','Whole Milk',120],
      ['Caramel Cold Brew','Cold Brew Concentrate',120],['Caramel Cold Brew','Caramel Syrup',30],
      ['Affogato','Espresso Beans',2],['Affogato','Vanilla Ice Cream',2],
      ['Matcha Frappe','Matcha Powder',8],['Matcha Frappe','Oat Milk',150],
      ['Hibiscus Cooler','Hibiscus Tea',5],['Hibiscus Cooler','Lemon Juice',30],
      ['Hibiscus Cooler','Fresh Mint',3],['Hibiscus Cooler','Sparkling Water',150],
      ['Blueberry Lemonade','Blueberry Reduction',40],['Blueberry Lemonade','Lemon Juice',30],
      ['Blueberry Lemonade','Sparkling Water',150],
      ['Mango Lassi','Mango Pulp',100],['Mango Lassi','Yoghurt',100],
      ['Mint Sparkling Water','Fresh Mint',3],['Mint Sparkling Water','Sparkling Water',200],
      ['Vanilla Scoop','Vanilla Ice Cream',1],['Strawberry Scoop','Strawberry Ice Cream',1],
      ['Coconut Scoop','Coconut Ice Cream',1],
      ['Two Scoop Bowl','Vanilla Ice Cream',1],['Two Scoop Bowl','Strawberry Ice Cream',1],
      ['Avocado Toast','Sourdough Bread',2],
      ['Cheese Toast','Sourdough Bread',2],['Cheese Toast','Cheese Blend',50],
      ['Egg Toast','Multigrain Bread',2],['Egg Toast','Eggs',2],
      ['Paneer Wrap','Wheat Tortilla',1],['Paneer Wrap','Paneer',80],
      ['PB Toast','White Bread',2],['PB Toast','Peanut Butter',30],
      ['Veg Hakka Noodles','Hakka Noodles',100],
      ['Paneer Fried Rice','Basmati Rice',150],['Paneer Fried Rice','Paneer',60],['Paneer Fried Rice','Eggs',1],
      ['Butter Croissant','Croissant Dough',1],
      ['Chocolate Croissant','Croissant Dough',1],['Chocolate Croissant','Chocolate Chips',20],
      ['Blueberry Muffin','Blueberries',30],
      ['Tiramisu','Mascarpone',80],['Tiramisu','Savoiardi',6],['Tiramisu','Espresso Beans',2],['Tiramisu','Cocoa Powder',5],
      ['Coconut Panna Cotta','Coconut Milk',150],['Coconut Panna Cotta','Agar Agar',3],['Coconut Panna Cotta','Mango Pulp',40],
    ];
    for (const [mn, inn, qty] of _recipes) _relink.run(qty, mn, inn);
    const _relinked = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;
    console.log(`🔗 Re-linked ${_relinked} recipe ingredient entries after menu import.`);
  })();

  console.log(`📊 Menu import: ${results.inserted} inserted, ${results.updated} updated, ${results.errors.length} errors`);
  if (results.errors.length) console.warn('   Errors:', results.errors.slice(0, 5));
  res.json({ success: true, ...results });
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

/* Helper — availability is managed manually via Excel import or PUT /api/menu/:id.
   Items are available by default (isAvailable=1). To mark OOS, set isAvailable=0 in Excel. */
function refreshAvailability(loc) {
  // No-op: stock-level auto-marking is disabled. Availability is set explicitly.
}

/* POST new order — Cashier / Manager / Owner */
app.post('/api/orders', (req, res) => {
  const { customerName, customerPhone, customerEmail, customerAddress, tableNo, paymentMode, items, location } = req.body;
  if (!customerName || !customerPhone || !Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'customerName, customerPhone, items[] required' });

  const loc = (location || 'guntupalli').toLowerCase().trim();

  try {
    const result = db.transaction(() => {
      // Upsert customer
      let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(customerPhone);
      if (!customer) {
        const r = db.prepare('INSERT INTO customers (name, phone, email, address) VALUES (?, ?, ?, ?)').run(customerName, customerPhone, customerEmail || null, customerAddress || null);
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
        if (!menuItem) {
          console.warn(`⚠️  No menu_items row found for "${item.name}" — no ingredient deduction possible.`);
        }
        if (menuItem) {
          // Join directly to get ingredient name, then find branch-scoped row.
          // This avoids the fragile two-step ID lookup that breaks after migrations.
          const links = db.prepare(`
            SELECT mii.qtyPerServing, i.name AS ingName
            FROM menu_item_ingredients mii
            JOIN ingredients i ON i.id = mii.ingredientId
            WHERE mii.menuItemId = ?
          `).all(menuItem.id);

          if (links.length === 0) {
            console.warn(`⚠️  No recipe links for "${item.name}" (menuItemId=${menuItem.id}) — run POST /api/repair/recipe-links to fix.`);
          }

          for (const link of links) {
            const ing = db.prepare('SELECT * FROM ingredients WHERE name = ? AND location = ?').get(link.ingName, loc);
            if (!ing) {
              console.warn(`⚠️  Ingredient "${link.ingName}" not found for branch "${loc}" — skipping deduction.`);
              continue;
            }
            const deduct = link.qtyPerServing * item.qty;
            const newQty = Math.max(0, ing.currentQty - deduct);
            db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, ing.id);
            db.prepare(`INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'deduct', ?, ?, ?)`).run(ing.id, -deduct, newQty, `Order ${invoiceNo} [${loc}]`);
            console.log(`📉  Deducted ${deduct} ${ing.unit} of "${link.ingName}" → new qty: ${newQty} [${loc}]`);
          }
        }        if (menuItem) {
          const links = db.prepare('SELECT * FROM menu_item_ingredients WHERE menuItemId = ?').all(menuItem.id);
          for (const link of links) {
            // Resolve the ingredient by name scoped to this branch's location
            const masterIng = db.prepare('SELECT name FROM ingredients WHERE id = ?').get(link.ingredientId);
            if (!masterIng) continue;
            const ing = db.prepare('SELECT * FROM ingredients WHERE name = ? AND location = ?').get(masterIng.name, loc);
            if (!ing) {
              console.warn(`⚠️  Ingredient "${masterIng.name}" not found for branch "${loc}" — skipping deduction.`);
              continue;
            }
            const deduct = link.qtyPerServing * item.qty;
            const newQty = Math.max(0, ing.currentQty - deduct);
            db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, ing.id);
            db.prepare(`INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'deduct', ?, ?, ?)`).run(ing.id, -deduct, newQty, `Order ${invoiceNo} [${loc}]`);
          }
        }
      }

      // Return full invoice so the frontend can render the receipt
      const savedInv = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(invoiceNo);
      return buildInvoiceResponse(savedInv);
    })();

    refreshAvailability(loc);
    res.status(201).json({ success: true, invoice: result });
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

/* GET inventory logs — Kitchen + Owner  *** MUST be declared before /:id *** */
app.get('/api/inventory/logs', (req, res) => {
  const loc = (req.query.location || 'guntupalli').toLowerCase().trim();
  let q = 'SELECT l.*, i.name AS itemName FROM inventory_logs l JOIN ingredients i ON l.itemId = i.id WHERE i.location = ?';
  const args = [loc];
  if (req.query.date) { q += ' AND l.createdAt LIKE ?'; args.push(req.query.date + '%'); }
  q += ' ORDER BY l.id DESC LIMIT 500';
  res.json({ success: true, logs: db.prepare(q).all(...args) });
});

/* GET all ingredients — Kitchen + Owner */
app.get('/api/inventory', (req, res) => {
  const loc = (req.query.location || 'guntupalli').toLowerCase().trim();
  res.json({ success: true, items: db.prepare('SELECT * FROM ingredients WHERE location = ? ORDER BY name').all(loc) });
});

/* GET single ingredient + recipe usage — Owner */
app.get('/api/inventory/:id', requireOwner, (req, res) => {
  const loc = (req.query.location || 'guntupalli').toLowerCase().trim();
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ? AND location = ?').get(req.params.id, loc);
  if (!ing) return res.status(404).json({ success: false, error: 'Not found' });
  const usedIn = db.prepare(`
    SELECT m.name AS menuItem, mii.qtyPerServing
    FROM menu_item_ingredients mii JOIN menu_items m ON mii.menuItemId = m.id
    WHERE mii.ingredientId = ?
  `).all(req.params.id);
  res.json({ success: true, ingredient: ing, usedIn });
});

/* ADD ingredient — Kitchen + Owner */
app.post('/api/inventory', (req, res) => {
  const { name, unit, currentQty, reorderLevel, location } = req.body;
  if (!name || !unit) return res.status(400).json({ success: false, error: 'name and unit required' });
  const loc = (location || 'guntupalli').toLowerCase().trim();
  const qty = parseFloat(currentQty) || 0;
  const r   = db.prepare('INSERT INTO ingredients (name, unit, currentQty, reorderLevel, location) VALUES (?, ?, ?, ?, ?)').run(name, unit, qty, parseFloat(reorderLevel) || 0, loc);
  if (qty > 0)
    db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'manual', ?, ?, 'Initial stock')").run(r.lastInsertRowid, qty, qty);
  res.status(201).json({ success: true, id: r.lastInsertRowid });
});

/* UPDATE ingredient quantity — Kitchen + Owner */
app.put('/api/inventory/:id', (req, res) => {
  const loc = (req.body.location || req.query.location || 'guntupalli').toLowerCase().trim();
  const old = db.prepare('SELECT * FROM ingredients WHERE id = ? AND location = ?').get(req.params.id, loc);
  if (!old) return res.status(404).json({ success: false, error: 'Not found' });
  const { name, unit, currentQty, reorderLevel } = req.body;
  const newQty = parseFloat(currentQty);
  db.prepare('UPDATE ingredients SET name=?, unit=?, currentQty=?, reorderLevel=? WHERE id=?').run(name || old.name, unit || old.unit, newQty, parseFloat(reorderLevel) || old.reorderLevel, req.params.id);
  if (newQty !== old.currentQty)
    db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'manual', ?, ?, 'Manual update')").run(req.params.id, newQty - old.currentQty, newQty);
  refreshAvailability(loc);
  res.json({ success: true });
});

/* Bulk daily stock entry — Kitchen + Owner */
app.post('/api/inventory/stock-entry', (req, res) => {
  const { entries, location } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ success: false, error: 'entries[] required' });
  const loc = (location || 'guntupalli').toLowerCase().trim();
  db.transaction(() => {
    for (const e of entries) {
      const old = db.prepare('SELECT currentQty FROM ingredients WHERE id = ? AND location = ?').get(e.id, loc);
      if (!old) continue;
      const newQty = parseFloat(e.qty) || 0;
      db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ? AND location = ?').run(newQty, e.id, loc);
      db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'restock', ?, ?, 'Daily stock entry')").run(e.id, newQty - old.currentQty, newQty);
    }
  })();
  refreshAvailability(loc);
  res.json({ success: true, updated: entries.length });
});

/* DELETE ingredient — Owner */
app.delete('/api/inventory/:id', requireOwner, (req, res) => {
  const loc = (req.query.location || 'guntupalli').toLowerCase().trim();
  if (!db.prepare('SELECT id FROM ingredients WHERE id = ? AND location = ?').get(req.params.id, loc))
    return res.status(404).json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM ingredients WHERE id = ? AND location = ?').run(req.params.id, loc);
  res.json({ success: true });
});

// (logs route is declared above GET /api/inventory to avoid /:id conflict)

/* POST bulk import from Excel JSON — Kitchen + Owner */
/* The frontend parses the .xlsx with SheetJS and posts the rows as JSON */
app.post('/api/inventory/import', (req, res) => {
  const { rows, location } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });
  const loc = (location || 'guntupalli').toLowerCase().trim();

  const results = { inserted: 0, updated: 0, errors: [] };
  db.transaction(() => {
    for (const row of rows) {
      const name     = (row.name || row.Name || '').toString().trim();
      const unit     = (row.unit || row.Unit || 'units').toString().trim();
      const qty      = parseFloat(row.currentQty ?? row.qty ?? row.Qty ?? row.CurrentQty ?? 0) || 0;
      const reorder  = parseFloat(row.reorderLevel ?? row.reorder ?? row.ReorderLevel ?? 0) || 0;
      const category = (row.category || row.Category || '').toString().trim();

      if (!name) { results.errors.push('Row missing name: ' + JSON.stringify(row)); continue; }

      const existing = db.prepare('SELECT id, currentQty FROM ingredients WHERE name = ? AND location = ?').get(name, loc);
      if (existing) {
        db.prepare('UPDATE ingredients SET unit=?, currentQty=?, reorderLevel=? WHERE id=?')
          .run(unit, qty, reorder, existing.id);
        if (qty !== existing.currentQty)
          db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'restock', ?, ?, 'Excel import')")
            .run(existing.id, qty - existing.currentQty, qty);
        results.updated++;
      } else {
        const r = db.prepare('INSERT INTO ingredients (name, unit, currentQty, reorderLevel, location) VALUES (?, ?, ?, ?, ?)')
          .run(name, unit, qty, reorder, loc);
        if (qty > 0)
          db.prepare("INSERT INTO inventory_logs (itemId, logType, delta, newQty, note) VALUES (?, 'manual', ?, ?, 'Excel import')")
            .run(r.lastInsertRowid, qty, qty);
        results.inserted++;
      }
    }
  })();
  refreshAvailability(loc);
  res.json({ success: true, ...results });
});


// ═══════════════════════════════════════════════════════
//  API — REPAIR ROUTE  (Owner)
//  POST /api/repair/recipe-links
//  Rebuilds all menu_item_ingredients rows from the hardcoded recipe table.
//  Run once after upgrading to fix any DB that has 0 recipe links.
// ═══════════════════════════════════════════════════════
app.post('/api/repair/recipe-links', requireOwner, (req, res) => {
  const recipes = [
    ['Espresso','Espresso Beans',2],['Americano','Espresso Beans',2],
    ['Cappuccino','Espresso Beans',2],['Cappuccino','Whole Milk',100],
    ['Latte','Espresso Beans',2],['Latte','Whole Milk',200],
    ['Mocha','Espresso Beans',2],['Mocha','Whole Milk',150],['Mocha','Dark Chocolate Sauce',30],
    ['Caramel Latte','Espresso Beans',2],['Caramel Latte','Whole Milk',200],['Caramel Latte','Caramel Syrup',30],
    ['Hazelnut Latte','Espresso Beans',2],['Hazelnut Latte','Whole Milk',200],['Hazelnut Latte','Hazelnut Syrup',30],
    ['Masala Chai','Masala Chai Mix',20],['Masala Chai','Whole Milk',150],
    ['Matcha Latte','Matcha Powder',5],['Matcha Latte','Oat Milk',200],
    ['Hot Chocolate','Dark Chocolate Sauce',40],['Hot Chocolate','Whole Milk',200],['Hot Chocolate','Whipped Cream',30],
    ['Cold Brew','Cold Brew Concentrate',120],
    ['Iced Latte','Espresso Beans',2],['Iced Latte','Whole Milk',150],
    ['Iced Mocha','Espresso Beans',2],['Iced Mocha','Dark Chocolate Sauce',30],['Iced Mocha','Whole Milk',120],
    ['Caramel Cold Brew','Cold Brew Concentrate',120],['Caramel Cold Brew','Caramel Syrup',30],
    ['Affogato','Espresso Beans',2],['Affogato','Vanilla Ice Cream',2],
    ['Matcha Frappe','Matcha Powder',8],['Matcha Frappe','Oat Milk',150],
    ['Hibiscus Cooler','Hibiscus Tea',5],['Hibiscus Cooler','Lemon Juice',30],
    ['Hibiscus Cooler','Fresh Mint',3],['Hibiscus Cooler','Sparkling Water',150],
    ['Blueberry Lemonade','Blueberry Reduction',40],['Blueberry Lemonade','Lemon Juice',30],
    ['Blueberry Lemonade','Sparkling Water',150],
    ['Mango Lassi','Mango Pulp',100],['Mango Lassi','Yoghurt',100],
    ['Mint Sparkling Water','Fresh Mint',3],['Mint Sparkling Water','Sparkling Water',200],
    ['Vanilla Scoop','Vanilla Ice Cream',1],['Strawberry Scoop','Strawberry Ice Cream',1],
    ['Coconut Scoop','Coconut Ice Cream',1],
    ['Two Scoop Bowl','Vanilla Ice Cream',1],['Two Scoop Bowl','Strawberry Ice Cream',1],
    ['Avocado Toast','Sourdough Bread',2],
    ['Cheese Toast','Sourdough Bread',2],['Cheese Toast','Cheese Blend',50],
    ['Egg Toast','Multigrain Bread',2],['Egg Toast','Eggs',2],
    ['Paneer Wrap','Wheat Tortilla',1],['Paneer Wrap','Paneer',80],
    ['PB Toast','White Bread',2],['PB Toast','Peanut Butter',30],
    ['Veg Hakka Noodles','Hakka Noodles',100],
    ['Paneer Fried Rice','Basmati Rice',150],['Paneer Fried Rice','Paneer',60],['Paneer Fried Rice','Eggs',1],
    ['Butter Croissant','Croissant Dough',1],
    ['Chocolate Croissant','Croissant Dough',1],['Chocolate Croissant','Chocolate Chips',20],
    ['Blueberry Muffin','Blueberries',30],
    ['Tiramisu','Mascarpone',80],['Tiramisu','Savoiardi',6],['Tiramisu','Espresso Beans',2],['Tiramisu','Cocoa Powder',5],
    ['Coconut Panna Cotta','Coconut Milk',150],['Coconut Panna Cotta','Agar Agar',3],['Coconut Panna Cotta','Mango Pulp',40],
  ];
  const before = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
    SELECT m.id, i.id, ?
    FROM menu_items m, ingredients i
    WHERE m.name = ? AND i.name = ? AND i.location = 'guntupalli'
  `);
  db.transaction(() => { for (const [mn, inn, qty] of recipes) stmt.run(qty, mn, inn); })();
  const after = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;
  console.log(`🔧 Repair: recipe links ${before} → ${after}`);
  res.json({ success: true, before, after, inserted: after - before });
});


// ═══════════════════════════════════════════════════════
//  API — RECIPE LINKS  (used by recipe-manager.html)
// ═══════════════════════════════════════════════════════

/* GET all recipe links — used to populate the editor */
app.get('/api/recipe-links', (req, res) => {
  const links = db.prepare(`
    SELECT mii.menuItemId, mii.ingredientId, mii.qtyPerServing,
           m.name AS menuName, i.name AS ingName, i.unit
    FROM menu_item_ingredients mii
    JOIN menu_items m ON m.id = mii.menuItemId
    JOIN ingredients i ON i.id = mii.ingredientId
    ORDER BY m.name, i.name
  `).all();
  res.json({ success: true, links });
});

/* POST /api/recipe-links/:menuItemId
   Body: { ingredients: [{ingredientId, qtyPerServing}] }
   Replaces ALL links for this menu item. Send [] to clear. */
app.post('/api/recipe-links/:menuItemId', (req, res) => {
  const menuItemId = parseInt(req.params.menuItemId);
  const { ingredients } = req.body;
  if (!Array.isArray(ingredients))
    return res.status(400).json({ success: false, error: 'ingredients[] required' });

  try {
    db.transaction(() => {
      // Wipe existing links for this item
      db.prepare('DELETE FROM menu_item_ingredients WHERE menuItemId = ?').run(menuItemId);
      // Insert new links
      const ins = db.prepare(
        'INSERT INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing) VALUES (?, ?, ?)'
      );
      for (const ing of ingredients) {
        if (!ing.ingredientId || !ing.qtyPerServing) continue;
        ins.run(menuItemId, ing.ingredientId, ing.qtyPerServing);
      }
    })();
    res.json({ success: true, saved: ingredients.length });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════

seed();
// Reset any items wrongly marked OOS — availability is now managed manually
db.prepare('UPDATE menu_items SET isAvailable = 1').run();

app.listen(PORT, () => {
  console.log(`\n☕  MACH Cafe running at http://localhost:${PORT}`);
  console.log(`\n📋  HOW TO VIEW THE DATABASE:`);
  console.log(`    Option 1 (browser UI): npx @sqlite-viewer/app velvetbean.db`);
  console.log(`    Option 2 (terminal):   sqlite3 velvetbean.db`);
  console.log(`\n    Default owner password: velvetbean2024`);
  console.log(`    ⚠️  Change OWNER_PASSWORD_HASH and JWT_SECRET before going live!`);
});