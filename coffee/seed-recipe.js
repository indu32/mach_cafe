/**
 * seed-recipes.js
 * ─────────────────────────────────────────────────────────────
 * 1. Diagnoses your current DB state (menu items, ingredients, recipes)
 * 2. Seeds menu_item_ingredients with your real menu items
 *    mapped to your real ingredients from the Excel.
 *
 * Run from your project folder:  node seed-recipes.js
 *
 * Edit the RECIPES section below to match YOUR actual menu item names
 * (run with --diagnose first to see what names are in your DB).
 * ─────────────────────────────────────────────────────────────
 */

const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'velvetbean.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const args = process.argv.slice(2);
const diagnoseOnly = args.includes('--diagnose');

// ── Step 1: Diagnose ──────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  DB DIAGNOSIS');
console.log('══════════════════════════════════════════');

const menuItems     = db.prepare('SELECT id, name, section FROM menu_items ORDER BY section, name').all();
const ingredients   = db.prepare("SELECT id, name, unit FROM ingredients WHERE location='guntupalli' ORDER BY name").all();
const recipeLinks   = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;

console.log(`\n📋 Menu Items (${menuItems.length} total):`);
menuItems.forEach(m => console.log(`   [${m.id}] ${m.name}  (${m.section})`));

console.log(`\n🧪 Ingredients (${ingredients.length} total, guntupalli):`);
ingredients.slice(0, 20).forEach(i => console.log(`   [${i.id}] ${i.name}  (${i.unit})`));
if (ingredients.length > 20) console.log(`   ... and ${ingredients.length - 20} more`);

console.log(`\n🍳 Recipe links in menu_item_ingredients: ${recipeLinks}`);

if (diagnoseOnly) {
  console.log('\n⬆  Run without --diagnose to seed recipes.');
  db.close();
  process.exit(0);
}

// ── Step 2: Build ingredient lookup map ───────────────────────
const ingMap = {};
for (const i of ingredients) ingMap[i.name.toLowerCase().trim()] = i.id;

function ing(name) {
  const id = ingMap[name.toLowerCase().trim()];
  if (!id) console.warn(`  ⚠️  Ingredient not found: "${name}"`);
  return id;
}

function menuId(name) {
  const m = menuItems.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!m) console.warn(`  ⚠️  Menu item not found: "${name}"`);
  return m?.id;
}

// ── Step 3: Define recipes ────────────────────────────────────
// Format: [ menuItemName, [ [ingredientName, qtyPerServing], ... ] ]
// Ingredient names must match EXACTLY what's in your ingredients table.
// Run `node seed-recipes.js --diagnose` to see exact names.
//
// EDIT THIS LIST to match YOUR menu item names from your DB.
//
const RECIPES = [
  // ── BEVERAGES (Hot) ───────────────────────────────────────
  ['Filter Coffee',      [['coffee', 15], ['milk', 150], ['sugar', 20]]],
  ['Boost',              [['boost', 30],  ['milk', 200], ['sugar', 15]]],
  ['Horlicks',           [['horlicks', 30], ['milk', 200], ['sugar', 15]]],
  ['Tea',                [['teapow', 5],  ['milk', 150], ['sugar', 20]]],
  ['Masala Tea',         [['teapow', 5],  ['milk', 150], ['sugar', 20], ['masala', 2]]],
  ['Green Tea',          [['greentea', 1], ['sugar', 5]]],
  ['Badam Milk',         [['badampow', 20], ['milk', 200], ['sugar', 15]]],

  // ── SHAKES / COLD ─────────────────────────────────────────
  ['Mango Shake',        [['mango', 1],   ['milk', 200], ['sugar', 20], ['icecreamvennela', 1]]],
  ['Banana Shake',       [['banana', 1],  ['milk', 200], ['sugar', 20], ['icecreamvennela', 1]]],
  ['Strawberry Shake',   [['strawberrycrush', 30], ['milk', 200], ['sugar', 15], ['icecreamvennela', 1]]],
  ['Kiwi Shake',         [['kiwicrush', 30], ['milk', 200], ['sugar', 15]]],
  ['Litchi Shake',       [['litchicrush', 30], ['milk', 200], ['sugar', 15]]],
  ['Butterscotch Shake', [['buttersc crush', 30], ['milk', 200], ['sugar', 15], ['icecreamvennela', 1]]],
  ['Pista Shake',        [['pistacrush', 30], ['milk', 200], ['sugar', 15], ['pista', 1]]],
  ['Oreo Shake',         [['oreopow', 20], ['milk', 200], ['sugar', 15], ['oreo &cream', 1]]],
  ['Chocolate Shake',    [['choco syrup', 1], ['milk', 200], ['sugar', 15], ['icecreamvennela', 1]]],
  ['Rose Shake',         [['rosesyrup', 30], ['milk', 200], ['sugar', 15]]],
  ['Dragon Fruit Shake', [['dragon fruit', 1], ['milk', 200], ['sugar', 15]]],

  // ── JUICES ───────────────────────────────────────────────
  ['Carrot Juice',       [['carrot', 200], ['sugar', 15], ['lemon', 1]]],
  ['Beetroot Juice',     [['beetroot', 150], ['carrot', 100], ['sugar', 15]]],
  ['Mango Juice',        [['mango', 2], ['sugar', 15], ['lemon', 1]]],
  ['Watermelon Juice',   [['watermeloncrush', 150], ['sugar', 10], ['lemon', 1]]],
  ['Apple Juice',        [['apple', 2], ['sugar', 10], ['lemon', 1]]],
  ['Mixed Fruit Juice',  [['FRUIT', 200], ['sugar', 15], ['lemon', 1]]],

  // ── FOOD ──────────────────────────────────────────────────
  ['Veg Burger',         [['burgur bun', 1], ['veg patte', 1], ['cheese', 30], ['mayo', 20], ['onion', 30], ['tomato', 1]]],
  ['Chicken Burger',     [['burgur bun', 1], ['chicken patte', 1], ['cheese', 30], ['chipotal mayo', 20], ['onion', 30]]],
  ['French Fries',       [['frech fires', 150], ['periperi sause', 20]]],
  ['Paneer Sandwich',    [['breads', 2], ['paneer', 50], ['cheese', 30], ['onion', 30], ['capsicum', 30], ['butter', 15]]],
  ['Chicken Sandwich',   [['breads', 2], ['boneless chicken', 1], ['cheese', 30], ['mayo', 20], ['onion', 30]]],
  ['Veg Sandwich',       [['breads', 2], ['cheese', 30], ['onion', 30], ['capsicum', 30], ['tomato', 1], ['butter', 15]]],
  ['Pasta',              [['pasta', 1], ['onion', 50], ['capsicum', 50], ['cheese', 40], ['butter', 20], ['garlic', 1]]],
  ['Mushroom Toast',     [['breads', 2], ['mushroom', 2], ['butter', 20], ['cheese', 30], ['garlic', 1]]],
];

// ── Step 4: Insert recipes ────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  SEEDING RECIPES');
console.log('══════════════════════════════════════════\n');

const insLink = db.prepare(`
  INSERT OR IGNORE INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
  VALUES (?, ?, ?)
`);

let seeded = 0, skipped = 0;

db.transaction(() => {
  for (const [itemName, links] of RECIPES) {
    const mId = menuId(itemName);
    if (!mId) { skipped++; continue; }

    let itemSeeded = 0;
    for (const [ingName, qty] of links) {
      const iId = ing(ingName);
      if (!iId) continue;
      const r = insLink.run(mId, iId, qty);
      if (r.changes > 0) itemSeeded++;
    }
    if (itemSeeded > 0) {
      console.log(`  ✅ ${itemName} → ${itemSeeded} ingredients linked`);
      seeded++;
    } else {
      console.log(`  ⏭  ${itemName} → already mapped or no valid ingredients`);
    }
  }
})();

const finalCount = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get().c;

console.log(`
══════════════════════════════════════════
  DONE
══════════════════════════════════════════
  Recipes seeded:   ${seeded}
  Skipped (no match): ${skipped}
  Total recipe links: ${finalCount}

⚠️  If your menu item names didn't match, run:
     node seed-recipes.js --diagnose
   to see the exact names in your DB, then edit
   the RECIPES list in this file to match.

▶  Now restart: node server.js
   Then place a test order and check inventory_logs
   to confirm deductions are firing.
`);

db.close();