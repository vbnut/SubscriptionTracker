/**
 * Products & Services Database
 * SQLite-backed storage for product/service records
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '../../data/products.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        productCode TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'product',
        category TEXT,
        sku TEXT,
        price REAL,
        billingCycle TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )
`);

// Migrate databases created before productCode existed
const productColumns = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!productColumns.includes('productCode')) {
    db.exec('ALTER TABLE products ADD COLUMN productCode TEXT');
}
db.prepare("UPDATE products SET productCode = 'PROD-' || substr('00000' || id, -5) WHERE productCode IS NULL").run();

function generateProductCode(id) {
    return 'PROD-' + String(id).padStart(5, '0');
}

db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL
    )
`);

function listProducts({ status } = {}) {
    if (status) {
        return db.prepare('SELECT * FROM products WHERE status = ? ORDER BY name COLLATE NOCASE').all(status);
    }
    return db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
}

function getProduct(id) {
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function createProduct(data) {
    const now = new Date().toISOString();
    const result = db.prepare(`
        INSERT INTO products (name, type, category, sku, price, billingCycle, description, status, createdAt, updatedAt)
        VALUES (@name, @type, @category, @sku, @price, @billingCycle, @description, @status, @createdAt, @updatedAt)
    `).run({
        name: data.name,
        type: data.type === 'service' ? 'service' : 'product',
        category: data.category || null,
        sku: data.sku || null,
        price: data.price === undefined || data.price === null || data.price === '' ? null : Number(data.price),
        billingCycle: data.billingCycle || null,
        description: data.description || null,
        status: data.status || 'active',
        createdAt: now,
        updatedAt: now
    });

    const id = result.lastInsertRowid;
    db.prepare('UPDATE products SET productCode = ? WHERE id = ?').run(generateProductCode(id), id);

    return getProduct(id);
}

function updateProduct(id, data) {
    const existing = getProduct(id);
    if (!existing) return null;

    db.prepare(`
        UPDATE products SET
            name = @name,
            type = @type,
            category = @category,
            sku = @sku,
            price = @price,
            billingCycle = @billingCycle,
            description = @description,
            updatedAt = @updatedAt
        WHERE id = @id
    `).run({
        id,
        name: data.name ?? existing.name,
        type: data.type === 'service' ? 'service' : (data.type === 'product' ? 'product' : existing.type),
        category: data.category ?? existing.category,
        sku: data.sku ?? existing.sku,
        price: data.price === undefined ? existing.price : (data.price === null || data.price === '' ? null : Number(data.price)),
        billingCycle: data.billingCycle ?? existing.billingCycle,
        description: data.description ?? existing.description,
        updatedAt: new Date().toISOString()
    });

    return getProduct(id);
}

function setProductStatus(id, status) {
    const existing = getProduct(id);
    if (!existing) return null;

    db.prepare('UPDATE products SET status = ?, updatedAt = ? WHERE id = ?')
        .run(status, new Date().toISOString(), id);

    return getProduct(id);
}

function getStats() {
    const total = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
    const active = db.prepare("SELECT COUNT(*) AS count FROM products WHERE status = 'active'").get().count;
    const inactive = db.prepare("SELECT COUNT(*) AS count FROM products WHERE status = 'inactive'").get().count;
    return { total, active, inactive };
}

function listCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY name COLLATE NOCASE').all();
}

function createCategory(name) {
    const now = new Date().toISOString();
    try {
        const result = db.prepare('INSERT INTO categories (name, createdAt) VALUES (?, ?)').run(name, now);
        return db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new Error(`Category "${name}" already exists`);
        }
        throw error;
    }
}

function deleteCategory(id) {
    const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return result.changes > 0;
}

module.exports = {
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    setProductStatus,
    getStats,
    listCategories,
    createCategory,
    deleteCategory
};
