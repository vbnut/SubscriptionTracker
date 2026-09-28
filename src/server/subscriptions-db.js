/**
 * Subscriptions Database
 * SQLite-backed storage for quote-style subscriptions: a customer header
 * with one or more product/service line items. Each line item renews
 * independently based on its own product's billing cycle.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '../../data/subscriptions.db');
const CUSTOMERS_DB_FILE = path.join(__dirname, '../../data/customers.db');
const PRODUCTS_DB_FILE = path.join(__dirname, '../../data/products.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Cross-database joins so rows can pull in customer/product details
db.prepare('ATTACH DATABASE ? AS customersdb').run(CUSTOMERS_DB_FILE);
db.prepare('ATTACH DATABASE ? AS productsdb').run(PRODUCTS_DB_FILE);

// Drop the old single-line-item schema (pre-quote) if present; there is no
// production data in that shape to preserve.
const existingSubscriptionColumns = db.prepare("PRAGMA table_info(subscriptions)").all().map(c => c.name);
if (existingSubscriptionColumns.includes('productId')) {
    db.exec('DROP TABLE subscriptions');
}

db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customerId INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        startDate TEXT NOT NULL,
        expirationDate TEXT,
        notes TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )
`);

// Migrate databases created before expirationDate existed
const subscriptionColumns = db.prepare('PRAGMA table_info(subscriptions)').all().map(c => c.name);
if (!subscriptionColumns.includes('expirationDate')) {
    db.exec('ALTER TABLE subscriptions ADD COLUMN expirationDate TEXT');
}

db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriptionId INTEGER NOT NULL,
        productId INTEGER NOT NULL,
        units INTEGER NOT NULL DEFAULT 1,
        price REAL,
        nextRenewalDate TEXT NOT NULL,
        lastRenewedAt TEXT,
        renewalCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )
`);

const RECURRING_CYCLES = ['monthly', 'yearly'];

// Advance a date by one billing cycle
function addCycle(date, billingCycle) {
    const next = new Date(date);
    if (billingCycle === 'yearly') {
        next.setFullYear(next.getFullYear() + 1);
    } else {
        next.setMonth(next.getMonth() + 1);
    }
    return next;
}

function getProductOrThrow(productId) {
    const product = db.prepare('SELECT * FROM productsdb.products WHERE id = ?').get(productId);
    if (!product) {
        throw new Error('Product/service not found');
    }
    if (!RECURRING_CYCLES.includes(product.billingCycle)) {
        throw new Error(`"${product.name}" does not have a recurring (monthly or yearly) billing cycle`);
    }
    return product;
}

function itemsForSubscriptionIds(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT
            si.*,
            p.name AS productName,
            p.type AS productType,
            p.billingCycle AS productBillingCycle
        FROM subscription_items si
        LEFT JOIN productsdb.products p ON p.id = si.productId
        WHERE si.subscriptionId IN (${placeholders})
        ORDER BY si.id ASC
    `).all(...ids);

    return rows.map(row => ({
        ...row,
        subtotal: (row.price || 0) * (row.units || 1)
    }));
}

function isExpired(sub) {
    return !!sub.expirationDate && new Date(sub.expirationDate) <= new Date();
}

function attachItems(subscriptions) {
    const ids = subscriptions.map(s => s.id);
    const items = itemsForSubscriptionIds(ids);
    const itemsBySub = new Map();
    for (const item of items) {
        if (!itemsBySub.has(item.subscriptionId)) itemsBySub.set(item.subscriptionId, []);
        itemsBySub.get(item.subscriptionId).push(item);
    }

    return subscriptions.map(sub => {
        const subItems = itemsBySub.get(sub.id) || [];
        return {
            ...sub,
            items: subItems,
            total: subItems.reduce((sum, item) => sum + item.subtotal, 0),
            isExpired: isExpired(sub)
        };
    });
}

function listSubscriptions({ status, customerId } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
        conditions.push('s.status = ?');
        params.push(status);
    }
    if (customerId) {
        conditions.push('s.customerId = ?');
        params.push(customerId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const subscriptions = db.prepare(`
        SELECT s.*, c.name AS customerName, c.status AS customerStatus
        FROM subscriptions s
        LEFT JOIN customersdb.customers c ON c.id = s.customerId
        ${where}
        ORDER BY s.createdAt DESC
    `).all(...params);

    return attachItems(subscriptions);
}

// Active subscriptions that have an expiration date set, soonest first (overdue/expired included)
function listExpiring() {
    const subscriptions = db.prepare(`
        SELECT s.*, c.name AS customerName, c.status AS customerStatus
        FROM subscriptions s
        LEFT JOIN customersdb.customers c ON c.id = s.customerId
        WHERE s.status = 'active' AND s.expirationDate IS NOT NULL
        ORDER BY s.expirationDate ASC
    `).all();

    return attachItems(subscriptions);
}

// Flat list of line items for a given product, joined with their subscription/customer
function listItemsForProduct(productId, status) {
    const conditions = ['si.productId = ?'];
    const params = [productId];

    if (status) {
        conditions.push('s.status = ?');
        params.push(status);
    }

    const rows = db.prepare(`
        SELECT
            si.*,
            s.status AS subscriptionStatus,
            s.expirationDate AS subscriptionExpirationDate,
            s.customerId AS customerId,
            c.name AS customerName
        FROM subscription_items si
        LEFT JOIN subscriptions s ON s.id = si.subscriptionId
        LEFT JOIN customersdb.customers c ON c.id = s.customerId
        WHERE ${conditions.join(' AND ')}
        ORDER BY si.nextRenewalDate ASC
    `).all(...params);

    return rows.map(row => ({
        ...row,
        subtotal: (row.price || 0) * (row.units || 1),
        isExpired: !!row.subscriptionExpirationDate && new Date(row.subscriptionExpirationDate) <= new Date()
    }));
}

function getSubscription(id) {
    const sub = db.prepare(`
        SELECT s.*, c.name AS customerName, c.status AS customerStatus
        FROM subscriptions s
        LEFT JOIN customersdb.customers c ON c.id = s.customerId
        WHERE s.id = ?
    `).get(id);
    if (!sub) return null;
    return attachItems([sub])[0];
}

function createSubscription(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
        throw new Error('At least one line item is required');
    }

    const customer = db.prepare('SELECT * FROM customersdb.customers WHERE id = ?').get(data.customerId);
    if (!customer) {
        throw new Error('Customer not found');
    }

    // Validate every line up front so we don't partially create the subscription
    const resolvedItems = items.map(item => ({
        item,
        product: getProductOrThrow(item.productId)
    }));

    const now = new Date().toISOString();
    const startDate = data.startDate ? new Date(data.startDate).toISOString() : now;
    const expirationDate = data.expirationDate ? new Date(data.expirationDate).toISOString() : null;

    const insertSubscription = db.prepare(`
        INSERT INTO subscriptions (customerId, status, startDate, expirationDate, notes, createdAt, updatedAt)
        VALUES (@customerId, 'active', @startDate, @expirationDate, @notes, @createdAt, @updatedAt)
    `);
    const insertItem = db.prepare(`
        INSERT INTO subscription_items (subscriptionId, productId, units, price, nextRenewalDate, lastRenewedAt, renewalCount, createdAt, updatedAt)
        VALUES (@subscriptionId, @productId, @units, @price, @nextRenewalDate, NULL, 0, @createdAt, @updatedAt)
    `);

    const subscriptionId = db.transaction(() => {
        const result = insertSubscription.run({
            customerId: data.customerId,
            startDate,
            expirationDate,
            notes: data.notes || null,
            createdAt: now,
            updatedAt: now
        });
        const subId = result.lastInsertRowid;

        for (const { item, product } of resolvedItems) {
            const units = item.units === undefined || item.units === null || item.units === ''
                ? 1
                : Math.max(1, parseInt(item.units, 10) || 1);
            const price = item.price === undefined || item.price === null || item.price === ''
                ? product.price
                : Number(item.price);
            const nextRenewalDate = addCycle(startDate, product.billingCycle).toISOString();

            insertItem.run({
                subscriptionId: subId,
                productId: item.productId,
                units,
                price,
                nextRenewalDate,
                createdAt: now,
                updatedAt: now
            });
        }

        return subId;
    })();

    return getSubscription(subscriptionId);
}

// Update notes plus reconcile line items: existing items (matched by id) have
// their units/price updated (renewal progress is left untouched); items with
// no id are new lines added to the quote; existing items omitted from the
// submitted list are removed.
function updateSubscription(id, data) {
    const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!existing) return null;

    if (Array.isArray(data.items) && data.items.length === 0) {
        throw new Error('At least one line item is required');
    }

    const now = new Date().toISOString();

    db.transaction(() => {
        db.prepare('UPDATE subscriptions SET notes = ?, updatedAt = ? WHERE id = ?')
            .run(data.notes === undefined ? existing.notes : (data.notes || null), now, id);

        if (!Array.isArray(data.items)) return;

        const currentItems = db.prepare('SELECT * FROM subscription_items WHERE subscriptionId = ?').all(id);
        const submittedIds = new Set(data.items.filter(i => i.id).map(i => Number(i.id)));

        // Remove lines the user deleted from the quote
        for (const current of currentItems) {
            if (!submittedIds.has(current.id)) {
                db.prepare('DELETE FROM subscription_items WHERE id = ?').run(current.id);
            }
        }

        const currentById = new Map(currentItems.map(c => [c.id, c]));

        for (const item of data.items) {
            if (item.id) {
                const current = currentById.get(Number(item.id));
                if (!current) continue;

                const units = item.units === undefined || item.units === null || item.units === ''
                    ? current.units
                    : Math.max(1, parseInt(item.units, 10) || 1);
                const price = item.price === undefined
                    ? current.price
                    : (item.price === null || item.price === '' ? null : Number(item.price));

                db.prepare('UPDATE subscription_items SET units = ?, price = ?, updatedAt = ? WHERE id = ? AND subscriptionId = ?')
                    .run(units, price, now, item.id, id);
            } else {
                const units = item.units === undefined || item.units === null || item.units === ''
                    ? 1
                    : Math.max(1, parseInt(item.units, 10) || 1);
                const product = getProductOrThrow(item.productId);
                const price = item.price === undefined || item.price === null || item.price === ''
                    ? product.price
                    : Number(item.price);
                const nextRenewalDate = addCycle(now, product.billingCycle).toISOString();
                db.prepare(`
                    INSERT INTO subscription_items (subscriptionId, productId, units, price, nextRenewalDate, lastRenewedAt, renewalCount, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
                `).run(id, item.productId, units, price, nextRenewalDate, now, now);
            }
        }
    })();

    return getSubscription(id);
}

function setSubscriptionStatus(id, status) {
    const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!existing) return null;

    const now = new Date().toISOString();

    db.transaction(() => {
        if (status === 'active' && existing.status === 'cancelled') {
            // Reactivating a lapsed subscription restarts every line's renewal clock from today
            db.prepare('UPDATE subscriptions SET status = ?, startDate = ?, updatedAt = ? WHERE id = ?')
                .run(status, now, now, id);

            const items = db.prepare('SELECT * FROM subscription_items WHERE subscriptionId = ?').all(id);
            for (const item of items) {
                const product = db.prepare('SELECT * FROM productsdb.products WHERE id = ?').get(item.productId);
                const cycle = product && RECURRING_CYCLES.includes(product.billingCycle) ? product.billingCycle : 'monthly';
                const nextRenewalDate = addCycle(now, cycle).toISOString();
                db.prepare('UPDATE subscription_items SET nextRenewalDate = ?, updatedAt = ? WHERE id = ?')
                    .run(nextRenewalDate, now, item.id);
            }
        } else {
            db.prepare('UPDATE subscriptions SET status = ?, updatedAt = ? WHERE id = ?').run(status, now, id);
        }
    })();

    return getSubscription(id);
}

// Extend (or clear) a subscription's expiration date and immediately catch up any
// line items that were frozen while it was expired.
function renewSubscription(id, expirationDate) {
    const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const resolvedExpiration = expirationDate ? new Date(expirationDate).toISOString() : null;

    db.prepare('UPDATE subscriptions SET expirationDate = ?, updatedAt = ? WHERE id = ?')
        .run(resolvedExpiration, now, id);

    processRenewals();

    return getSubscription(id);
}

// Roll forward any active, non-expired subscription's line items whose renewal date has passed
function processRenewals() {
    const now = new Date();
    const nowIso = now.toISOString();
    const due = db.prepare(`
        SELECT si.*, p.billingCycle AS productBillingCycle
        FROM subscription_items si
        JOIN subscriptions s ON s.id = si.subscriptionId
        LEFT JOIN productsdb.products p ON p.id = si.productId
        WHERE s.status = 'active'
          AND si.nextRenewalDate <= ?
          AND (s.expirationDate IS NULL OR s.expirationDate > ?)
    `).all(nowIso, nowIso);

    const renewedIds = [];
    for (const item of due) {
        const cycle = RECURRING_CYCLES.includes(item.productBillingCycle) ? item.productBillingCycle : 'monthly';
        let nextRenewalDate = new Date(item.nextRenewalDate);
        let cyclesElapsed = 0;

        while (nextRenewalDate <= now) {
            nextRenewalDate = addCycle(nextRenewalDate, cycle);
            cyclesElapsed++;
        }

        db.prepare(`
            UPDATE subscription_items SET
                nextRenewalDate = ?,
                lastRenewedAt = ?,
                renewalCount = renewalCount + ?,
                updatedAt = ?
            WHERE id = ?
        `).run(nextRenewalDate.toISOString(), now.toISOString(), cyclesElapsed, now.toISOString(), item.id);

        renewedIds.push(item.id);
    }

    return renewedIds;
}

function getStats() {
    const total = db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count;
    const active = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'").get().count;
    const cancelled = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'cancelled'").get().count;
    return { total, active, cancelled };
}

module.exports = {
    listSubscriptions,
    listExpiring,
    listItemsForProduct,
    getSubscription,
    createSubscription,
    updateSubscription,
    setSubscriptionStatus,
    renewSubscription,
    processRenewals,
    getStats
};
