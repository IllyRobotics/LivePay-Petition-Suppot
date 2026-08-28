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

// Data storage
const dataDir          = path.join(__dirname, 'data');
const signaturesFile   = path.join(dataDir, 'signatures.json');
const donationsFile    = path.join(dataDir, 'donations.json');
const creatorsFile     = path.join(dataDir, 'featured-creators.json');
const applicationsFile = path.join(dataDir, 'creator-applications.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
[signaturesFile, donationsFile, creatorsFile, applicationsFile].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
});

const readCreators     = () => { try { return JSON.parse(fs.readFileSync(creatorsFile, 'utf8')); }     catch { return []; } };
const writeCreators    = d  => fs.writeFileSync(creatorsFile, JSON.stringify(d, null, 2), 'utf8');
const readApplications = () => { try { return JSON.parse(fs.readFileSync(applicationsFile, 'utf8')); } catch { return []; } };
const writeApplications= d  => fs.writeFileSync(applicationsFile, JSON.stringify(d, null, 2), 'utf8');

function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD || 'iris-admin-2026';
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== pw) return res.status(401).json({ error: 'Unauthorized' });
  next();
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

// ===== CREATOR MANAGEMENT =====

// GET /api/bigo/creators/featured — public: featured creators with live Bigo stats
app.get('/api/bigo/creators/featured', async (req, res) => {
  try {
    const creators = readCreators();
    let dirty = false;
    await Promise.allSettled(creators.map(async c => {
      try {
        const profile = await bigoScraper.getCreator(c.bigo_username);
        // Overwrite live fields; keep display_name/bio/avatar if creator set them manually
        c.is_live         = profile.is_live;
        c.current_viewers = profile.current_viewers;
        if (profile.peak_viewers)    { c.peak_viewers    = profile.peak_viewers;    dirty = true; }
        if (profile.followers_count) { c.followers_count = profile.followers_count; dirty = true; }
        if (profile.avatar && !c.avatar) { c.avatar = profile.avatar;              dirty = true; }
        // Use Bigo's real display name if the stored one is still the raw Bigo ID
        if (profile.channel_name && profile.channel_name !== c.bigo_username && c.display_name === c.bigo_username) {
          c.display_name = profile.channel_name; dirty = true;
        }
      } catch (_) {
        // API blocked from Railway — fall back to stored data silently
      }
    }));
    if (dirty) writeCreators(creators); // persist enriched data for next cold start
    res.json({ creators });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bigo/creators/apply — public: creator self-applies
app.post('/api/bigo/creators/apply', (req, res) => {
  const { display_name, bigo_username, bio, bigo_url, avatar } = req.body;
  if (!display_name || !bigo_username)
    return res.status(400).json({ error: 'display_name and bigo_username are required' });

  const apps = readApplications();
  if (apps.some(a => a.bigo_username === bigo_username && a.status === 'pending'))
    return res.status(409).json({ error: 'An application for this Bigo ID is already pending review.' });

  const application = {
    id           : Date.now().toString(),
    display_name : display_name.slice(0, 80),
    bigo_username: bigo_username.trim().replace(/^@/, '').slice(0, 64),
    bio          : (bio || '').slice(0, 300),
    bigo_url     : bigo_url || `https://www.bigo.tv/${bigo_username}`,
    avatar       : (avatar || '').slice(0, 500),
    peak_viewers : 0,
    followers_count: 0,
    status       : 'pending',
    submitted_at : new Date().toISOString(),
  };
  apps.push(application);
  writeApplications(apps);
  res.status(201).json({ success: true, message: "Application received! We'll review it and be in touch.", id: application.id });
});

// GET /api/bigo/creators/applications — admin: list all applications
app.get('/api/bigo/creators/applications', adminAuth, (req, res) => {
  res.json({ applications: readApplications() });
});

// POST /api/bigo/creators/approve/:id — admin: approve → feature the creator
app.post('/api/bigo/creators/approve/:id', adminAuth, (req, res) => {
  const apps = readApplications();
  const idx = apps.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Application not found' });
  apps[idx].status = 'approved';
  // Admin can override avatar at approval time
  if (req.body && req.body.avatar) apps[idx].avatar = req.body.avatar.slice(0, 500);
  writeApplications(apps);
  const creators = readCreators();
  if (!creators.some(c => c.bigo_username === apps[idx].bigo_username)) {
    creators.push({ ...apps[idx], featured_at: new Date().toISOString() });
    writeCreators(creators);
  }
  res.json({ success: true });
});

// POST /api/bigo/creators/reject/:id — admin: reject an application
app.post('/api/bigo/creators/reject/:id', adminAuth, (req, res) => {
  const apps = readApplications();
  const idx = apps.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  apps[idx].status = 'rejected';
  writeApplications(apps);
  res.json({ success: true });
});

// POST /api/bigo/creators/featured/:id/status — admin: manually set live status & viewer count
app.post('/api/bigo/creators/featured/:id/status', adminAuth, (req, res) => {
  const creators = readCreators();
  const idx = creators.findIndex(c => c.id === req.params.id || c.bigo_username === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Creator not found' });
  const { is_live, current_viewers } = req.body;
  if (typeof is_live === 'boolean') creators[idx].is_live = is_live;
  if (current_viewers != null) creators[idx].current_viewers = parseInt(current_viewers) || 0;
  creators[idx].status_override = true;
  creators[idx].status_set_at = new Date().toISOString();
  writeCreators(creators);
  res.json({ success: true, creator: creators[idx] });
});

// GET /api/bigo/creators/featured/:id — public: single featured creator by id or username
app.get('/api/bigo/creators/featured/:id', async (req, res) => {
  try {
    const param = req.params.id;
    const creators = readCreators();
    const creator = creators.find(c => c.id === param || c.bigo_username === param);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    try {
      const profile = await bigoScraper.getCreator(creator.bigo_username);
      creator.is_live = profile.is_live;
      creator.current_viewers = profile.current_viewers;
      if (profile.peak_viewers) creator.peak_viewers = profile.peak_viewers;
      if (profile.followers_count) creator.followers_count = profile.followers_count;
      if (profile.avatar && !creator.avatar) creator.avatar = profile.avatar;
      if (profile.channel_name && profile.channel_name !== creator.bigo_username) creator.channel_name = profile.channel_name;
    } catch (_) {}
    res.json({ creator });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bigo/creators/featured/:id — admin: remove a featured creator
app.delete('/api/bigo/creators/featured/:id', adminAuth, (req, res) => {
  writeCreators(readCreators().filter(c => c.id !== req.params.id));
  res.json({ success: true });
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
