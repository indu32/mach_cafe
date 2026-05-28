// Run this from your coffee folder: node check.js
// Make sure server.js is NOT running when you run this (or use a different terminal)

const Database = require('better-sqlite3');
const db = new Database('velvetbean.db');

console.log('\n===== RECIPE LINKS =====');
const links = db.prepare('SELECT COUNT(*) AS c FROM menu_item_ingredients').get();
console.log('Total recipe links:', links.c, links.c === 0 ? '❌ BROKEN — run repair!' : '✅ OK');

console.log('\n===== SAMPLE LINKS =====');
const sample = db.prepare(`
  SELECT m.name AS menuItem, i.name AS ingredient, mii.qtyPerServing
  FROM menu_item_ingredients mii
  JOIN menu_items m ON m.id = mii.menuItemId
  JOIN ingredients i ON i.id = mii.ingredientId
  LIMIT 8
`).all();
if (sample.length === 0) {
  console.log('❌ No links found');
} else {
  sample.forEach(r => console.log(`  ${r.menuItem}  →  ${r.ingredient}  (${r.qtyPerServing})`));
}

console.log('\n===== INGREDIENT QUANTITIES (guntupalli) =====');
const ings = db.prepare(`SELECT name, currentQty, unit FROM ingredients WHERE location='guntupalli' ORDER BY name LIMIT 15`).all();
if (ings.length === 0) {
  console.log('❌ No ingredients found for guntupalli');
} else {
  ings.forEach(i => console.log(`  ${i.name}: ${i.currentQty} ${i.unit}`));
}

console.log('\n===== RECENT INVENTORY LOGS =====');
const logs = db.prepare(`
  SELECT l.logType, l.delta, l.newQty, l.note, i.name AS ingredient
  FROM inventory_logs l JOIN ingredients i ON l.itemId = i.id
  ORDER BY l.id DESC LIMIT 10
`).all();
if (logs.length === 0) {
  console.log('❌ No logs at all — deductions have never run');
} else {
  logs.forEach(l => console.log(`  [${l.logType}] ${l.ingredient}: ${l.delta > 0 ? '+' : ''}${l.delta} → ${l.newQty}  (${l.note || '—'})`));
}

db.close();