// Armazenamento: um JSON por colecao em DATA_DIR, escrita atomica (tmp + rename).
// O volume e pequeno (um registro por lancamento), entao nao vale um banco.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export class Store {
  constructor(name) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.items = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of raw.items || []) this.items.set(item.id, item);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[store] could not read ${this.file}: ${e.message}`);
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: [...this.items.values()] }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  newId() {
    let id;
    do id = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x'); while (this.items.has(id));
    return id;
  }

  get(id) { return this.items.get(id) ?? null; }

  put(item) { this.items.set(item.id, item); this.save(); return item; }

  // Remove sem gravar; quem poda em lote chama save() no fim.
  remove(id) { return this.items.delete(id); }

  get size() { return this.items.size; }

  list(filter = () => true) { return [...this.items.values()].filter(filter); }
}
