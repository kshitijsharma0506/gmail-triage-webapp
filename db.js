// Minimal file-based storage. No external database needed.
// Stores one JSON file (data/db.json) with per-user tokens + triage config.
// Fine for a handful of users; swap for a real DB if you outgrow this.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {} };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const DEFAULT_CATEGORIES = [
  { name: 'Job Alerts & Recruiter Spam', keywords: ['job', 'hiring', 'career', 'recruiter', 'opportunity', 'openings'], replyEnabled: false, replyMode: 'static', replyTemplate: '', aiInstructions: '' },
  { name: 'Newsletters & Notifications', keywords: ['newsletter', 'digest', 'unsubscribe', 'notification', 'update from'], replyEnabled: false, replyMode: 'static', replyTemplate: '', aiInstructions: '' },
  { name: 'Needs My Reply', keywords: ['question', 'please', 'could you', 'let me know', 'asap'], replyEnabled: true, replyMode: 'static', replyTemplate: "Hi,\n\nThanks for your email — I've received it and will get back to you properly soon.\n\nBest", aiInstructions: '' },
  { name: 'Meeting / Scheduling', keywords: ['meeting', 'schedule', 'calendar', 'availability', 'call'], replyEnabled: true, replyMode: 'static', replyTemplate: "Hi,\n\nThanks for reaching out about scheduling — I'll check my calendar and follow up with a time shortly.\n\nBest", aiInstructions: '' }
];

const DEFAULT_CONFIG = {
  categories: DEFAULT_CATEGORIES,
  baseQuery: 'in:inbox is:unread',
  scanDays: 3,
  dryRun: true
};

function getUser(userId) {
  const data = readAll();
  return data.users[userId] || null;
}

function findUserByGoogleId(googleId) {
  const data = readAll();
  return Object.values(data.users).find(u => u.googleId === googleId) || null;
}

function upsertUser(user) {
  const data = readAll();
  const existing = data.users[user.id] || {};
  data.users[user.id] = {
    ...existing,
    ...user,
    config: existing.config || DEFAULT_CONFIG
  };
  writeAll(data);
  return data.users[user.id];
}

function saveConfig(userId, config) {
  const data = readAll();
  if (!data.users[userId]) return null;
  data.users[userId].config = config;
  writeAll(data);
  return config;
}

module.exports = {
  getUser,
  findUserByGoogleId,
  upsertUser,
  saveConfig,
  DEFAULT_CONFIG
};
