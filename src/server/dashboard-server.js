/**
 * Web Dashboard Server
 * Provides a web UI for managing and monitoring sync operations
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const session = require('express-session');
const scheduler = require('./scheduler');
const customersDb = require('./customers-db');
const productsDb = require('./products-db');
const subscriptionsDb = require('./subscriptions-db');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = process.env.PORT || 3000;

// Store active sync processes
const activeSyncs = new Map();

// Sync history
const syncHistory = [];
const MAX_HISTORY = 50;

// Middleware
app.use(express.json());

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'hubspot-dynamics-sync-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

/**
 * User Management
 */
const USERS_FILE = path.join(__dirname, '../../data/users.json');

// Load users from JSON file
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return JSON.parse(data);
        }
        return { users: [] };
    } catch (error) {
        console.error('Error loading users:', error);
        return { users: [] };
    }
}

// Save users to JSON file
function saveUsers(usersData) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving users:', error);
        return false;
    }
}

// Find user by userid
function findUser(userid) {
    const usersData = loadUsers();
    return usersData.users.find(user => user.userid === userid);
}

// Update user's last login
function updateLastLogin(userid) {
    const usersData = loadUsers();
    const user = usersData.users.find(u => u.userid === userid);
    if (user) {
        user.lastLogin = new Date().toISOString();
        saveUsers(usersData);
    }
}

/**
 * Authentication Middleware
 */
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }

    // For API requests, return JSON error
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required'
        });
    }

    // For HTML requests, redirect to login
    res.redirect('/login.html');
}

/**
 * Execute a sync command and stream output
 */
function executeSync(syncType, minutesLookback = 60) {
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    let command, args;

    switch(syncType) {
        default:
            throw new Error(`Unknown sync type: ${syncType}`);
    }
    
    const startTime = Date.now();
    const syncProcess = spawn(command, args, {
        env: { ...process.env, SYNC_ID: syncId }
    });
    
    const syncInfo = {
        id: syncId,
        type: syncType,
        startTime,
        status: 'running',
        logs: [],
        process: syncProcess
    };
    
    activeSyncs.set(syncId, syncInfo);

    // Capture stdout
    syncProcess.stdout.on('data', (data) => {
        syncInfo.logs.push(data.toString());
    });

    // Capture stderr
    syncProcess.stderr.on('data', (data) => {
        syncInfo.logs.push(data.toString());
    });

    // Handle process completion
    syncProcess.on('close', (code) => {
        const duration = Date.now() - startTime;
        syncInfo.status = code === 0 ? 'success' : 'failed';
        syncInfo.endTime = Date.now();
        syncInfo.duration = duration;
        syncInfo.exitCode = code;

        // Add to history
        syncHistory.unshift({
            id: syncId,
            type: syncType,
            status: syncInfo.status,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(syncInfo.endTime).toISOString(),
            duration,
            exitCode: code
        });
        
        // Keep history limited
        if (syncHistory.length > MAX_HISTORY) {
            syncHistory.pop();
        }
        
        // Remove from active syncs after 1 minute
        setTimeout(() => {
            activeSyncs.delete(syncId);
        }, 60000);
    });
    
    return syncId;
}

/**
 * Authentication Routes
 */

// Login route
app.post('/api/auth/login', async (req, res) => {
    try {
        const { userid, password } = req.body;

        if (!userid || !password) {
            return res.status(400).json({
                success: false,
                message: 'User ID and password are required'
            });
        }

        // Find user
        const user = findUser(userid);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Set session
        req.session.authenticated = true;
        req.session.userid = user.userid;

        // Update last login
        updateLastLogin(user.userid);

        res.json({
            success: true,
            message: 'Login successful',
            user: {
                userid: user.userid
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during login'
        });
    }
});

// Logout route
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                message: 'Error logging out'
            });
        }

        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    });
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.json({
            success: true,
            authenticated: true,
            userid: req.session.userid
        });
    } else {
        res.json({
            success: true,
            authenticated: false
        });
    }
});

/**
 * User Profile Management Routes
 */

// Get user profile
app.get('/api/user/profile', requireAuth, (req, res) => {
    try {
        const user = findUser(req.session.userid);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            profile: {
                userid: user.userid,
                name: user.name || '',
                email: user.email || '',
                createdAt: user.createdAt,
                lastLogin: user.lastLogin
            }
        });
    } catch (error) {
        console.error('Error getting profile:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get profile'
        });
    }
});

// Update user profile
app.put('/api/user/profile', requireAuth, (req, res) => {
    try {
        const { name, email } = req.body;
        const usersData = loadUsers();
        const user = usersData.users.find(u => u.userid === req.session.userid);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Update user data
        if (name !== undefined) user.name = name;
        if (email !== undefined) user.email = email;
        user.updatedAt = new Date().toISOString();

        // Save users
        const saved = saveUsers(usersData);

        if (!saved) {
            return res.status(500).json({
                success: false,
                error: 'Failed to save profile'
            });
        }

        res.json({
            success: true,
            message: 'Profile updated successfully',
            profile: {
                userid: user.userid,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update profile'
        });
    }
});

// Change password
app.put('/api/user/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'Current password and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'New password must be at least 6 characters'
            });
        }

        const usersData = loadUsers();
        const user = usersData.users.find(u => u.userid === req.session.userid);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Verify current password
        const passwordMatch = await bcrypt.compare(currentPassword, user.password);

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                error: 'Current password is incorrect'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.passwordChangedAt = new Date().toISOString();

        // Save users
        const saved = saveUsers(usersData);

        if (!saved) {
            return res.status(500).json({
                success: false,
                error: 'Failed to save password'
            });
        }

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to change password'
        });
    }
});

// Socket.io real-time connection
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSyncs: activeSyncs.size,
        uptime: process.uptime()
    });
});

/**
 * Customer Management Routes
 */

// List customers (optionally filter by status)
app.get('/api/customers', requireAuth, (req, res) => {
    try {
        const { status } = req.query;
        const customers = customersDb.listCustomers(status ? { status } : {});
        res.json({ success: true, customers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Customer summary stats (for the Overview tile)
app.get('/api/customers/stats', requireAuth, (req, res) => {
    try {
        res.json({ success: true, stats: customersDb.getStats() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get a single customer
app.get('/api/customers/:id', requireAuth, (req, res) => {
    try {
        const customer = customersDb.getCustomer(req.params.id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }
        res.json({ success: true, customer });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a customer
app.post('/api/customers', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        const customer = customersDb.createCustomer(req.body);
        res.json({ success: true, customer });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update a customer
app.put('/api/customers/:id', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        const customer = customersDb.updateCustomer(req.params.id, req.body);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }
        res.json({ success: true, customer });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Set a customer's active/inactive status
app.put('/api/customers/:id/status', requireAuth, (req, res) => {
    try {
        const { status } = req.body;
        if (status !== 'active' && status !== 'inactive') {
            return res.status(400).json({ success: false, error: "status must be 'active' or 'inactive'" });
        }
        const customer = customersDb.setCustomerStatus(req.params.id, status);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }
        res.json({ success: true, customer });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Products & Services Routes
 */

// List products/services (optionally filter by status)
app.get('/api/products', requireAuth, (req, res) => {
    try {
        const { status } = req.query;
        const products = productsDb.listProducts(status ? { status } : {});
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Product/service summary stats (for the Overview tile)
app.get('/api/products/stats', requireAuth, (req, res) => {
    try {
        res.json({ success: true, stats: productsDb.getStats() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get a single product/service
app.get('/api/products/:id', requireAuth, (req, res) => {
    try {
        const product = productsDb.getProduct(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a product/service
app.post('/api/products', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        const product = productsDb.createProduct(req.body);
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update a product/service
app.put('/api/products/:id', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        const product = productsDb.updateProduct(req.params.id, req.body);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Set a product/service's active/inactive status
app.put('/api/products/:id/status', requireAuth, (req, res) => {
    try {
        const { status } = req.body;
        if (status !== 'active' && status !== 'inactive') {
            return res.status(400).json({ success: false, error: "status must be 'active' or 'inactive'" });
        }
        const product = productsDb.setProductStatus(req.params.id, status);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Product & Service Category Routes
 */

// List categories
app.get('/api/categories', requireAuth, (req, res) => {
    try {
        res.json({ success: true, categories: productsDb.listCategories() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a category
app.post('/api/categories', requireAuth, (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Category name is required' });
        }
        const category = productsDb.createCategory(name.trim());
        res.json({ success: true, category });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Delete a category
app.delete('/api/categories/:id', requireAuth, (req, res) => {
    try {
        const deleted = productsDb.deleteCategory(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Subscription Routes
 */

// List subscriptions (optionally filter by status/customerId). Renewals are processed first so the list is always current.
app.get('/api/subscriptions', requireAuth, (req, res) => {
    try {
        subscriptionsDb.processRenewals();
        const { status, customerId } = req.query;
        const subscriptions = subscriptionsDb.listSubscriptions({ status, customerId });
        res.json({ success: true, subscriptions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// List the subscription line items that include a given product/service (for the Product sublist)
app.get('/api/products/:id/subscription-items', requireAuth, (req, res) => {
    try {
        subscriptionsDb.processRenewals();
        const items = subscriptionsDb.listItemsForProduct(req.params.id, req.query.status);
        res.json({ success: true, items });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Subscription summary stats (for the Overview tile)
app.get('/api/subscriptions/stats', requireAuth, (req, res) => {
    try {
        subscriptionsDb.processRenewals();
        res.json({ success: true, stats: subscriptionsDb.getStats() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Active subscriptions with an expiration date, soonest first (for the Overview Quick Actions panel)
app.get('/api/subscriptions/expiring', requireAuth, (req, res) => {
    try {
        subscriptionsDb.processRenewals();
        res.json({ success: true, subscriptions: subscriptionsDb.listExpiring() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get a single subscription
app.get('/api/subscriptions/:id', requireAuth, (req, res) => {
    try {
        const subscription = subscriptionsDb.getSubscription(req.params.id);
        if (!subscription) {
            return res.status(404).json({ success: false, error: 'Subscription not found' });
        }
        res.json({ success: true, subscription });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a subscription (a customer plus one or more product/service line items)
app.post('/api/subscriptions', requireAuth, (req, res) => {
    try {
        const { customerId, items } = req.body;
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Customer is required' });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one line item is required' });
        }
        const subscription = subscriptionsDb.createSubscription(req.body);
        res.json({ success: true, subscription });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Update a subscription's notes and reconcile its line items (add/update/remove)
app.put('/api/subscriptions/:id', requireAuth, (req, res) => {
    try {
        const subscription = subscriptionsDb.updateSubscription(req.params.id, req.body);
        if (!subscription) {
            return res.status(404).json({ success: false, error: 'Subscription not found' });
        }
        res.json({ success: true, subscription });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Cancel or reactivate a subscription
app.put('/api/subscriptions/:id/status', requireAuth, (req, res) => {
    try {
        const { status } = req.body;
        if (status !== 'active' && status !== 'cancelled') {
            return res.status(400).json({ success: false, error: "status must be 'active' or 'cancelled'" });
        }
        const subscription = subscriptionsDb.setSubscriptionStatus(req.params.id, status);
        if (!subscription) {
            return res.status(404).json({ success: false, error: 'Subscription not found' });
        }
        res.json({ success: true, subscription });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Renew a subscription by extending its expiration date, catching up any frozen line items
app.put('/api/subscriptions/:id/renew', requireAuth, (req, res) => {
    try {
        const { expirationDate } = req.body;
        if (!expirationDate) {
            return res.status(400).json({ success: false, error: 'A new expiration date is required' });
        }
        const subscription = subscriptionsDb.renewSubscription(req.params.id, expirationDate);
        if (!subscription) {
            return res.status(404).json({ success: false, error: 'Subscription not found' });
        }
        res.json({ success: true, subscription });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * Scheduler API Routes
 */

// Get scheduler status
app.get('/api/scheduler/status', requireAuth, (req, res) => {
    try {
        const status = scheduler.getStatus();
        res.json({
            success: true,
            scheduler: status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enable or disable a scheduled job
app.put('/api/scheduler/:jobName/toggle', requireAuth, (req, res) => {
    try {
        const { jobName } = req.params;
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'enabled must be a boolean'
            });
        }

        const result = scheduler.setJobEnabled(jobName, enabled);

        if (!result) {
            return res.status(404).json({
                success: false,
                error: `Job ${jobName} not found`
            });
        }

        // Emit status update via Socket.io
        const status = scheduler.getStatus();
        io.emit('schedulerUpdate', status);

        res.json({
            success: true,
            message: `Job ${jobName} ${enabled ? 'enabled' : 'disabled'}`,
            scheduler: status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update job schedule
app.put('/api/scheduler/:jobName/schedule', requireAuth, (req, res) => {
    try {
        const { jobName } = req.params;
        const { cronExpression } = req.body;

        if (!cronExpression) {
            return res.status(400).json({
                success: false,
                error: 'cronExpression is required'
            });
        }

        const result = scheduler.updateJobSchedule(jobName, cronExpression);

        if (!result) {
            return res.status(400).json({
                success: false,
                error: 'Invalid job name or cron expression'
            });
        }

        const status = scheduler.getStatus();
        io.emit('schedulerUpdate', status);

        res.json({
            success: true,
            message: `Job ${jobName} schedule updated`,
            scheduler: status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Run a scheduled job immediately
app.post('/api/scheduler/:jobName/run', requireAuth, (req, res) => {
    try {
        const { jobName } = req.params;
        const jobConfig = scheduler.getJobConfig(jobName);

        if (!jobConfig) {
            return res.status(404).json({
                success: false,
                error: `Job ${jobName} not found`
            });
        }

        scheduler.executeJob(jobName);

        res.json({
            success: true,
            message: `Job ${jobName} triggered`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Serve the dashboard
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '/public', 'dashboard.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Initialize scheduler with sync executor
scheduler.initialize((syncType) => {
    executeSync(syncType);
});

// Listen for scheduler events and broadcast via Socket.io
scheduler.on('jobStarted', () => {
    io.emit('schedulerUpdate', scheduler.getStatus());
});

scheduler.on('jobStopped', () => {
    io.emit('schedulerUpdate', scheduler.getStatus());
});

scheduler.on('jobExecuting', () => {
    io.emit('schedulerUpdate', scheduler.getStatus());
});

// Keep subscriptions renewed even when nobody is viewing the dashboard
subscriptionsDb.processRenewals();
setInterval(() => subscriptionsDb.processRenewals(), 60 * 60 * 1000);

// Start server
httpServer.listen(port, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 HubSpot ↔ Dynamics Sync Dashboard');
    console.log('='.repeat(60));
    console.log(`📊 Dashboard: http://localhost:${port}`);
    console.log(`🔧 API: http://localhost:${port}/api`);
    console.log(`💚 Health: http://localhost:${port}/api/health`);
    console.log(`🔌 WebSocket: Socket.io enabled`);
    console.log(`⏰ Scheduler: Initialized`);
    console.log('='.repeat(60));
    console.log('\nPress Ctrl+C to stop\n');
});

module.exports = app;
