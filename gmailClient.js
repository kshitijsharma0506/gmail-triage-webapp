const { google } = require('googleapis');

// Minimal scope set that actually covers what this app does:
// - gmail.modify  : search/read messages+labels, create labels, AND attach
//                   labels to messages (messages.modify requires this —
//                   gmail.labels alone only manages label *definitions*,
//                   it cannot attach a label to a message).
// - gmail.compose : create drafts (NOT send — nothing here can send mail)
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose'
];

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // needed to get a refresh_token
    prompt: 'consent', // force refresh_token on every login (simplifies the demo)
    scope: SCOPES
  });
}

async function exchangeCodeForTokens(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

function clientFromUser(user) {
  const client = newOAuthClient();
  client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
    expiry_date: user.expiryDate
  });
  return client;
}

// Ensures the OAuth client has a fresh access token, refreshing + persisting
// it if needed. Returns the ready-to-use client.
async function getFreshClient(user, db) {
  const client = clientFromUser(user);
  const isExpired = !user.expiryDate || user.expiryDate < Date.now() + 60000;
  if (isExpired && user.refreshToken) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    db.upsertUser({
      id: user.id,
      googleId: user.googleId,
      email: user.email,
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || user.refreshToken,
      expiryDate: credentials.expiry_date
    });
  }
  return client;
}

function gmail(auth) {
  return google.gmail({ version: 'v1', auth });
}

async function getProfile(auth) {
  const res = await gmail(auth).users.getProfile({ userId: 'me' });
  return res.data; // { emailAddress, messagesTotal, threadsTotal, historyId }
}

async function listLabels(auth) {
  const res = await gmail(auth).users.labels.list({ userId: 'me' });
  return res.data.labels || [];
}

async function createLabel(auth, name) {
  const res = await gmail(auth).users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return res.data;
}

// Searches messages with a Gmail query and fetches enough metadata
// (subject/from/snippet) to classify + display each one.
async function searchMessages(auth, query, maxResults) {
  const listRes = await gmail(auth).users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });
  const messages = listRes.data.messages || [];

  const detailed = [];
  for (const m of messages) {
    const msgRes = await gmail(auth).users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Message-ID']
    });
    const headers = msgRes.data.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const rfc822MessageId = headers.find(h => h.name === 'Message-ID')?.value || '';
    detailed.push({
      id: msgRes.data.id,
      threadId: msgRes.data.threadId,
      snippet: msgRes.data.snippet || '',
      subject,
      from,
      rfc822MessageId
    });
  }
  return detailed;
}

function decodeBase64Url(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Walks the MIME part tree looking for a text/plain part first, falling
// back to text/html (stripped of tags) if that's all there is.
function extractBodyFromPayload(payload) {
  if (!payload) return '';

  let plain = null;
  let html = null;

  function walk(part) {
    if (!part) return;
    const mimeType = part.mimeType || '';
    if (mimeType === 'text/plain' && part.body?.data && !plain) {
      plain = decodeBase64Url(part.body.data);
    } else if (mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);

  if (plain) return plain;
  if (html) return stripHtml(html);
  return '';
}

// Fetches the full plaintext (or html-stripped-to-text) body of one
// message. Used only when generating an AI reply, since it's a heavier
// call than the metadata-only fetch used for search/classification.
async function getMessageBody(auth, messageId) {
  const res = await gmail(auth).users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });
  return extractBodyFromPayload(res.data.payload);
}

async function labelMessage(auth, messageId, labelId) {
  await gmail(auth).users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] }
  });
}

function extractEmailAddress(fromHeader) {
  if (!fromHeader) return null;
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1];
  return fromHeader.trim();
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawMessage({ to, subject, body, inReplyToRfc822MessageId }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject || ''}`,
    'Content-Type: text/plain; charset="UTF-8"'
  ];
  if (inReplyToRfc822MessageId) {
    headers.push(`In-Reply-To: ${inReplyToRfc822MessageId}`);
    headers.push(`References: ${inReplyToRfc822MessageId}`);
  }
  return base64url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

// Creates a draft, threaded as a reply to the original message when
// threadId/inReplyToRfc822MessageId are given.
async function createDraftReply(auth, { to, subject, body, threadId, inReplyToRfc822MessageId }) {
  const raw = buildRawMessage({ to, subject, body, inReplyToRfc822MessageId });
  const requestBody = { message: { raw } };
  if (threadId) requestBody.message.threadId = threadId;

  const res = await gmail(auth).users.drafts.create({ userId: 'me', requestBody });
  return res.data;
}

// Replaces the content of an existing draft (Gmail drafts.update fully
// replaces the message, there's no partial edit).
async function updateDraft(auth, draftId, { to, subject, body, threadId, inReplyToRfc822MessageId }) {
  const raw = buildRawMessage({ to, subject, body, inReplyToRfc822MessageId });
  const requestBody = { message: { raw } };
  if (threadId) requestBody.message.threadId = threadId;

  const res = await gmail(auth).users.drafts.update({ userId: 'me', id: draftId, requestBody });
  return res.data;
}

// Sends an existing draft as-is. This is the one place in the app that can
// actually put a message in someone's inbox — only ever called when the
// user explicitly clicks Send on the dashboard, never automatically.
async function sendDraft(auth, draftId) {
  const res = await gmail(auth).users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
  return res.data;
}

module.exports = {
  SCOPES,
  getAuthUrl,
  exchangeCodeForTokens,
  getFreshClient,
  getProfile,
  listLabels,
  createLabel,
  searchMessages,
  getMessageBody,
  labelMessage,
  extractEmailAddress,
  createDraftReply,
  updateDraft,
  sendDraft
};
