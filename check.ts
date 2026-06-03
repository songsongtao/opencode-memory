import { Database } from 'bun:sqlite';
const db = new Database('data/memory.db');
console.log(db.query("SELECT name FROM sqlite_master WHERE type='table'").all());
try {
  console.log('semantic:', db.query('SELECT count(*) as c FROM semantic_memory').get());
} catch(e) { console.log(e.message); }
try {
  console.log('facts:', db.query('SELECT count(*) as c FROM facts').get());
} catch(e) { console.log(e.message); }
