/**
 * Customers Database
 * SQLite-backed storage for customer records
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '../../data/customers.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customerCode TEXT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        postalCode TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )
`);

// Migrate databases created before customerCode existed
const customerColumns = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
if (!customerColumns.includes('customerCode')) {
    db.exec('ALTER TABLE customers ADD COLUMN customerCode TEXT');
}
db.prepare("UPDATE customers SET customerCode = 'CUST-' || substr('00000' || id, -5) WHERE customerCode IS NULL").run();

function generateCustomerCode(id) {
    return 'CUST-' + String(id).padStart(5, '0');
}

function listCustomers({ status } = {}) {
    if (status) {
        return db.prepare('SELECT * FROM customers WHERE status = ? ORDER BY name COLLATE NOCASE').all(status);
    }
    return db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all();
}

function getCustomer(id) {
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function createCustomer(data) {
    const now = new Date().toISOString();
    const result = db.prepare(`
        INSERT INTO customers (name, email, phone, company, address, city, state, postalCode, status, notes, createdAt, updatedAt)
        VALUES (@name, @email, @phone, @company, @address, @city, @state, @postalCode, @status, @notes, @createdAt, @updatedAt)
    `).run({
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        company: data.company || null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        postalCode: data.postalCode || null,
        status: data.status || 'active',
        notes: data.notes || null,
        createdAt: now,
        updatedAt: now
    });

    const id = result.lastInsertRowid;
    db.prepare('UPDATE customers SET customerCode = ? WHERE id = ?').run(generateCustomerCode(id), id);

    return getCustomer(id);
}

function updateCustomer(id, data) {
    const existing = getCustomer(id);
    if (!existing) return null;

    db.prepare(`
        UPDATE customers SET
            name = @name,
            email = @email,
            phone = @phone,
            company = @company,
            address = @address,
            city = @city,
            state = @state,
            postalCode = @postalCode,
            notes = @notes,
            updatedAt = @updatedAt
        WHERE id = @id
    `).run({
        id,
        name: data.name ?? existing.name,
        email: data.email ?? existing.email,
        phone: data.phone ?? existing.phone,
        company: data.company ?? existing.company,
        address: data.address ?? existing.address,
        city: data.city ?? existing.city,
        state: data.state ?? existing.state,
        postalCode: data.postalCode ?? existing.postalCode,
        notes: data.notes ?? existing.notes,
        updatedAt: new Date().toISOString()
    });

    return getCustomer(id);
}

function setCustomerStatus(id, status) {
    const existing = getCustomer(id);
    if (!existing) return null;

    db.prepare('UPDATE customers SET status = ?, updatedAt = ? WHERE id = ?')
        .run(status, new Date().toISOString(), id);

    return getCustomer(id);
}

function getStats() {
    const total = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;
    const active = db.prepare("SELECT COUNT(*) AS count FROM customers WHERE status = 'active'").get().count;
    const inactive = db.prepare("SELECT COUNT(*) AS count FROM customers WHERE status = 'inactive'").get().count;
    return { total, active, inactive };
}

module.exports = {
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    setCustomerStatus,
    getStats
};
