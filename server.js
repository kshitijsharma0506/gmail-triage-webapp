require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const { google } = require('googleapis');
const db = require('./db');
const gmailClient = require('./gmailClient');
const { matchCategory } = require('./classifier');
const aiReply = require('./aiReply');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// --- Auth routes -----------------------------------------------------

app.get('/auth/google', (req, res) => {
  res.redirect(gmailClient.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?error=missing_code');

  try {
    const tokens = await gmailClient.exchangeCodeForTokens(code);
    const tempClient = new google.auth.OAuth2();
    tempClient.setCredentials(tokens);
    const profile = await gmailClient.getProfile(tempClient);

    const userId = crypto.createHash('sha256').update(profile.emailAddress).digest('hex').slice(0, 16);
    const user = db.upsertUser({
      id: userId,
      googleId: userId,
      email: profile.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, // only present on first consent
      expiryDate: tokens.expiry_date
    });

    req.session.userId = user.id;
    res.redirect('/dashboard.html');
  } catch (e) {
    console.error('OAuth callback failed:', e.message);
    res.redirect('/?error=' + encodeURIComponent('auth_failed'));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userId);
  res.json({ email: user.email });
});

// --- Config routes -----------------------------------------------------

app.get('/api/config', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userId);
  res.json(user.config || db.DEFAULT_CONFIG);
});

app.post('/api/config', requireAuth, (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.categories)) {
    return res.status(400).json({ error: 'Invalid config' });
  }
  config.scanDays = Math.max(1, Math.min(10, parseInt(config.scanDays, 10) || 3));
  db.saveConfig(req.session.userId, config);
  res.json({ ok: true });
});

app.get('/api/ai-status', requireAuth, (req, res) => {
  res.json({ configured: aiReply.isConfigured() });
});

// --- Triage run ----------------------------------------------------------

app.post('/api/run-triage', requireAuth, async (req, res) => {
  const user = db.getUser(req.session.userId);
  const config = user.config || db.DEFAULT_CONFIG;
  const dryRun = !!config.dryRun;
  const scanDays = Math.max(1, Math.min(10, parseInt(config.scanDays, 10) || 3));
  const query = `${config.baseQuery || 'in:inbox is:unread'} newer_than:${scanDays}d`.trim();

  try {
    const auth = await gmailClient.getFreshClient(user, db);

    let labelMap = {};
    let labelErrorsByCategory = {};
    let labelingError = null; // set if we couldn't even list labels at all
    if (!dryRun) {
      try {
        const existing = await gmailClient.listLabels(auth);
        const nameToId = {};
        existing.forEach(l => { nameToId[l.name] = l.id; });
        for (const cat of config.categories) {
          try {
            if (nameToId[cat.name]) {
              labelMap[cat.name] = nameToId[cat.name];
            } else {
              const created = await gmailClient.createLabel(auth, cat.name);
              labelMap[cat.name] = created.id;
            }
          } catch (e) {
            // Don't let one category's failure block the rest.
            labelErrorsByCategory[cat.name] = e.message;
          }
        }
      } catch (e) {
        labelingError = e.message;
      }
    }

    const messages = await gmailClient.searchMessages(auth, query, 50);

    const rows = [];
    let labeledCount = 0, draftedCount = 0;

    for (const msg of messages) {
      const cat = matchCategory(config.categories, msg);
      const row = {
        id: msg.id,
        threadId: msg.threadId,
        subject: msg.subject,
        from: msg.from,
        category: cat ? cat.name : null,
        labeled: false,
        drafted: false,
        error: null
      };

      if (cat) {
        if (dryRun) {
          row.labeled = 'preview';
          row.drafted = cat.replyEnabled ? 'preview' : false;
        } else {
          try {
            if (labelingError) {
              row.labeled = 'unavailable';
              row.error = labelingError;
            } else if (labelMap[cat.name]) {
              await gmailClient.labelMessage(auth, msg.id, labelMap[cat.name]);
              row.labeled = true;
              labeledCount++;
            } else {
              row.labeled = 'unavailable';
              row.error = labelErrorsByCategory[cat.name] || 'Label could not be created or found for this category.';
            }
            const wantsReply = cat.replyEnabled && (cat.replyMode === 'ai' ? true : !!cat.replyTemplate);
            if (wantsReply) {
              let replyBody;
              if (cat.replyMode === 'ai') {
                if (!aiReply.isConfigured()) {
                  throw new Error('AI reply mode is on for this category, but ANTHROPIC_API_KEY is not set on the server.');
                }
                const fullBody = await gmailClient.getMessageBody(auth, msg.id);
                replyBody = await aiReply.generateReply({
                  subject: msg.subject,
                  from: msg.from,
                  bodyText: fullBody || msg.snippet,
                  instructions: cat.aiInstructions
                });
              } else {
                replyBody = cat.replyTemplate;
              }

              const to = gmailClient.extractEmailAddress(msg.from);
              const replySubject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`;
              const draft = await gmailClient.createDraftReply(auth, {
                to,
                subject: replySubject,
                body: replyBody,
                threadId: msg.threadId,
                inReplyToRfc822MessageId: msg.rfc822MessageId
              });
              row.drafted = true;
              draftedCount++;
              // Returned so the dashboard can show + edit + save/send this
              // exact draft without a second round trip to Gmail.
              row.draftId = draft.id;
              row.draftTo = to;
              row.draftSubject = replySubject;
              row.draftBody = replyBody;
              row.rfc822MessageId = msg.rfc822MessageId;
            }
          } catch (e) {
            row.error = row.error ? `${row.error} | ${e.message}` : e.message;
          }
        }
      }
      rows.push(row);
    }

    res.json({ rows, dryRun, labelingError });
  } catch (e) {
    console.error('Triage run failed:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --- Draft edit / save / send ---------------------------------------------
// These only ever run when the user explicitly clicks a button on the
// dashboard for one specific draft — nothing here is automatic.

app.post('/api/drafts/:draftId/update', requireAuth, async (req, res) => {
  const user = db.getUser(req.session.userId);
  const { to, subject, body, threadId, rfc822MessageId } = req.body || {};
  if (!body || !to) return res.status(400).json({ error: 'Missing to/body' });

  try {
    const auth = await gmailClient.getFreshClient(user, db);
    const updated = await gmailClient.updateDraft(auth, req.params.draftId, {
      to, subject, body, threadId, inReplyToRfc822MessageId: rfc822MessageId
    });
    res.json({ ok: true, draftId: updated.id });
  } catch (e) {
    console.error('Draft update failed:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/api/drafts/:draftId/send', requireAuth, async (req, res) => {
  const user = db.getUser(req.session.userId);
  try {
    const auth = await gmailClient.getFreshClient(user, db);
    await gmailClient.sendDraft(auth, req.params.draftId);
    res.json({ ok: true });
  } catch (e) {
    console.error('Draft send failed:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Gmail triage app listening on http://localhost:${PORT}`);
});
