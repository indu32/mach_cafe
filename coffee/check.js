// Run this with: node check_db.js
// Place this file in the same folder as server.js and velvetbean.db

const Database = require('better-sqlite3');
const path = require('path');

try {
  const db = new Database(path.join(__dirname, 'velvetbean.db'));
  
  const count = db.prepare('SELECT COUNT(*) as c FROM menu_items').get();
  console.log('\n✅ Database connected successfully');
  console.log('📦 Total menu items in DB:', count.c);
  
  if (count.c > 0) {
    const sections = db.prepare("SELECT section, COUNT(*) as c FROM menu_items GROUP BY section").all();
    console.log('\n📋 Items by section:');
    sections.forEach(s => console.log(`   ${s.section}: ${s.c} items`));
    
    const sample = db.prepare('SELECT name, price, section FROM menu_items LIMIT 5').all();
    console.log('\n🔍 First 5 items:');
    sample.forEach(i => console.log(`   ${i.name} — ₹${i.price} [${i.section}]`));
  } else {
    console.log('\n❌ DB is EMPTY — no menu items found!');
    console.log('   → You need to upload your Excel file using the Update Menu button');
  }
  
  db.close();
} catch (e) {
  console.error('\n❌ Error:', e.message);
  if (e.message.includes('no such file')) {
    console.log('   → velvetbean.db not found in this folder');
    console.log('   → Make sure you run this from the same folder as server.js');
  }
}