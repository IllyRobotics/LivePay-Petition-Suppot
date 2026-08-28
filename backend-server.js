/**
 * LivePay Petition Backend Server (OPTIONAL)
 * Simple backend for petition and donation tracking
 * Email is handled via Formspree or EmailJS on the frontend
 * 
 * THIS IS COMPLETELY OPTIONAL!
 * The petition works perfectly with GitHub Pages alone using localStorage.
 * Use this backend only if you want server-side data persistence.
 * 
 * Run: node backend-server.js
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const bigoScraper = require('./bigo-scraper');

// Load .env without requiring dotenv package
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
} catch {}

const SC_BASE = 'https://streamscharts.com/api/jazz';
const SC_CLIENT_ID = process.env.STREAMSCHARTS_CLIENT_ID || '';
const SC_TOKEN = process.env.STREAMSCHARTS_TOKEN || '';

function scFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(SC_BASE + apiPath);
    const req = https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Client-ID': SC_CLIENT_ID,
        'Token': SC_TOKEN,
        'Accept': 'application/json',
        'User-Agent': 'IRIS-Studio/1.0',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Debug endpoint — confirms env vars are loaded (values never exposed)
app.get('/api/debug/env', (req, res) => {
  res.json({
    STREAMSCHARTS_CLIENT_ID: SC_CLIENT_ID ? `set (${SC_CLIENT_ID.length} chars)` : 'MISSING',
    STREAMSCHARTS_TOKEN: SC_TOKEN ? `set (${SC_TOKEN.length} chars)` : 'MISSING',
    NODE_ENV: process.env.NODE_ENV || 'not set',
    deploy_ts: new Date().toISOString(),
  });
});

// Data storage (production: use a database like MongoDB)
const dataDir = path.join(__dirname, 'data');
const signaturesFile = path.join(dataDir, 'signatures.json');
const donationsFile = path.join(dataDir, 'donations.json');

// Initialize data directory and files
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

if (!fs.existsSync(signaturesFile)) {
  fs.writeFileSync(signaturesFile, JSON.stringify([]), 'utf8');
}

if (!fs.existsSync(donationsFile)) {
  fs.writeFileSync(donationsFile, JSON.stringify([]), 'utf8');
}

// Helper functions
const readSignatures = () => {
  try {
    return JSON.parse(fs.readFileSync(signaturesFile, 'utf8'));
  } catch {
    return [];
  }
};

const writeSignatures = (signatures) => {
  fs.writeFileSync(signaturesFile, JSON.stringify(signatures, null, 2), 'utf8');
};

const readDonations = () => {
  try {
    return JSON.parse(fs.readFileSync(donationsFile, 'utf8'));
  } catch {
    return [];
  }
};

const writeDonations = (donations) => {
  fs.writeFileSync(donationsFile, JSON.stringify(donations, null, 2), 'utf8');
};

// Validation functions
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const isValidZIP = (zip) => {
  return /^\d{5}(-\d{4})?$/.test(zip);
};

// Routes

/**
 * POST /api/petition/sign
 * Submit a new petition signature
 */
app.post('/api/petition/sign', (req, res) => {
  const { fullName, email, city, state, zip, country, certified } = req.body;

  // Validation
  if (!fullName || !email || !city || !state || !zip || !country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (!isValidZIP(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code' });
  }

  if (!certified) {
    return res.status(400).json({ error: 'Must certify identity' });
  }

  const signatures = readSignatures();

  // Check for duplicate email
  if (signatures.some((sig) => sig.email === email)) {
    return res.status(409).json({ error: 'Email already signed' });
  }

  // Add new signature
  const newSignature = {
    id: Date.now().toString(),
    fullName,
    email,
    city,
    state,
    zip,
    country,
    timestamp: new Date().toISOString(),
  };

  signatures.push(newSignature);
  writeSignatures(signatures);

  res.status(201).json({
    success: true,
    message: 'Signature recorded successfully',
    signature: newSignature,
    totalSignatures: signatures.length,
  });
});

/**
 * GET /api/petition/signatures/count
 * Get total signature count
 */
app.get('/api/petition/signatures/count', (req, res) => {
  const signatures = readSignatures();
  res.json({ count: signatures.length });
});

/**
 * GET /api/petition/signatures
 * Get all signatures (admin only - in production, add authentication)
 */
app.get('/api/petition/signatures', (req, res) => {
  const signatures = readSignatures();
  res.json({ signatures, total: signatures.length });
});

/**
 * POST /api/donation/track
 * Track a PayPal donation
 */
app.post('/api/donation/track', (req, res) => {
  const { email, amount, transactionId, paypalEmail } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const donations = readDonations();

  const newDonation = {
    id: Date.now().toString(),
    email,
    amount: parseFloat(amount),
    transactionId: transactionId || null,
    paypalEmail: paypalEmail || null,
    timestamp: new Date().toISOString(),
  };

  donations.push(newDonation);
  writeDonations(donations);

  res.status(201).json({
    success: true,
    message: 'Donation tracked',
    donation: newDonation,
    totalDonations: donations.length,
  });
});

/**
 * GET /api/donation/total
 * Get total donations
 */
app.get('/api/donation/total', (req, res) => {
  const donations = readDonations();
  const totalAmount = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({
    total: totalAmount,
    count: donations.length,
    average: donations.length > 0 ? (totalAmount / donations.length).toFixed(2) : 0,
  });
});

/**
 * GET /api/donation/list
 * Get all donations (admin only)
 */
app.get('/api/donation/list', (req, res) => {
  const donations = readDonations();
  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({
    donations,
    total,
    count: donations.length,
  });
});

/**
 * GET /api/stats
 * Get campaign statistics
 */
app.get('/api/stats', (req, res) => {
  const signatures = readSignatures();
  const donations = readDonations();
  const totalDonations = donations.reduce((sum, d) => sum + d.amount, 0);

  res.json({
    signatures: {
      count: signatures.length,
      byCountry: signatures.reduce((acc, sig) => {
        acc[sig.country] = (acc[sig.country] || 0) + 1;
        return acc;
      }, {}),
      byState: signatures.reduce((acc, sig) => {
        if (sig.country === 'United States') {
          acc[sig.state] = (acc[sig.state] || 0) + 1;
        }
        return acc;
      }, {}),
    },
    donations: {
      total: totalDonations,
      count: donations.length,
      average: donations.length > 0 ? (totalDonations / donations.length).toFixed(2) : 0,
    },
  });
});

// ===== BIGO LIVE SCRAPER ROUTES =====

// GET /api/bigo/trending?limit=10 — top trending Bigo Live creators (scraper-backed, 24h cache)
app.get('/api/bigo/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await bigoScraper.getTrending(limit);
    res.json(result);
  } catch (err) {
    // No cache yet and live fetch failed — return empty rather than 502 so the page still loads
    console.error('Bigo trending error:', err.message);
    res.json({ data: [], cached: false, error: err.message });
  }
});

// GET /api/bigo/creator/:username — live stats for a specific Bigo creator
app.get('/api/bigo/creator/:username', async (req, res) => {
  const username = req.params.username.slice(0, 64);
  try {
    const data = await bigoScraper.getCreator(username);
    res.json(data);
  } catch (err) {
    console.error('Bigo creator error:', err.message);
    res.status(502).json({ error: 'Could not fetch creator', detail: err.message });
  }
});

// GET /api/bigo/live?users=alice,bob — bulk live-status from cached trending list
app.get('/api/bigo/live', async (req, res) => {
  const usernames = (req.query.users || '').split(',').map(u => u.trim()).filter(Boolean).slice(0, 20);
  if (!usernames.length) return res.json({ creators: [] });
  try {
    const { data } = await bigoScraper.getTrending(50);
    const index = Object.fromEntries(data.map(c => [c.username, c]));
    const creators = usernames.map(u => {
      const c = index[u];
      return c
        ? { username: u, live: c.is_live, viewers: c.current_viewers, peak_viewers: c.peak_viewers, followers: c.followers_count, title: c.room_topic }
        : { username: u, live: false, viewers: 0, peak_viewers: 0, followers: 0, title: '' };
    });
    res.json({ creators });
  } catch (err) {
    console.error('Bigo live-check error:', err.message);
    res.status(502).json({ error: 'Bigo scraper unavailable', detail: err.message });
  }
});

// POST /api/bigo/refresh — force an immediate cache refresh (no body required)
app.post('/api/bigo/refresh', async (req, res) => {
  try {
    const result = await bigoScraper.getTrending(50, true);
    res.json({ refreshed: true, count: result.data.length, fetched_at: result.fetched_at });
  } catch (err) {
    console.error('Bigo refresh error:', err.message);
    res.status(502).json({ error: 'Refresh failed', detail: err.message });
  }
});

// Serve static files from project root for the IRIS pages
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
bigoScraper.scheduleDailyRefresh();
app.listen(PORT, () => {
  console.log(`🚀 LivePay Backend Server running on http://localhost:${PORT}`);
  console.log(`📊 Signatures endpoint: GET http://localhost:${PORT}/api/petition/signatures/count`);
  console.log(`💰 Donations endpoint: GET http://localhost:${PORT}/api/donation/total`);
  console.log(`📈 Stats endpoint: GET http://localhost:${PORT}/api/stats`);
});
