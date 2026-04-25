const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const ftp      = require('basic-ftp');

const FTP_HOST   = process.env.FTP_HOST || 'sxb1plzcpnl510389.prod.sxb1.secureserver.net';
const FTP_USER   = process.env.FTP_USER || 'wtq97o2y5psu';
const FTP_PASS   = process.env.FTP_PASS || 'KUBIcPanelSifre1!';
const FTP_REMOTE = process.env.FTP_REMOTE || '/public_html/animes.json';

async function ftpSyncAnimes() {
  const client = new ftp.Client(30000);
  try {
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false, port: 21 });
    await client.uploadFrom(ANIMES_FILE, FTP_REMOTE);
    console.log('[FTP] ✅ animes.json hostinge yüklendi.');
  } catch (e) {
    console.error('[FTP] ❌ sync hatası:', e.message);
  } finally {
    client.close();
  }
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kblyben_db_user:S31fclGU8s5ViSZT@session.zhzbrfb.mongodb.net/AniLandDB?retryWrites=true&w=majority';

async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log('[AniLand] ✅ MongoDB bağlantısı kuruldu.');
}

// ─── Mongoose Şemaları & Modeller ─────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true },
  email:        { type: String, required: true },
  hash:         String,
  salt:         String,
  role:         { type: String, default: 'user' },
  joined:       Number,
  bio:          String,
  photoDataUrl: String,
}, { _id: false, versionKey: false });

const AnimeSchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  title:       String,
  slug:        { type: String, unique: true },
  emoji:       String,
  genre:       String,
  score:       String,
  eps:         String,
  year:        mongoose.Schema.Types.Mixed,
  color1:      String,
  color2:      String,
  desc:        String,
  epLinks:     mongoose.Schema.Types.Mixed,
  epTitles:    mongoose.Schema.Types.Mixed,
  epSubs:      mongoose.Schema.Types.Mixed,
  epMeta:      mongoose.Schema.Types.Mixed,
  coverImage:  String,
  bannerImage: String,
  altTitle:    String,
  addedAt:     Number,
  updatedAt:   Number,
}, { _id: false, versionKey: false });

const CommentStoreSchema = new mongoose.Schema({
  key:      { type: String, required: true, unique: true },
  comments: mongoose.Schema.Types.Mixed,
}, { versionKey: false });

const RatingStoreSchema = new mongoose.Schema({
  slug:    { type: String, required: true, unique: true },
  ratings: mongoose.Schema.Types.Mixed,
}, { versionKey: false });

const FollowStoreSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true },
  following: [String],
}, { versionKey: false });

const NotificationStoreSchema = new mongoose.Schema({
  username:      { type: String, required: true, unique: true },
  notifications: mongoose.Schema.Types.Mixed,
}, { versionKey: false });

const SettingsSchema = new mongoose.Schema({
  _id:           { type: String, default: 'settings' },
  marqueeItems:  mongoose.Schema.Types.Mixed,
  featuredAnime: mongoose.Schema.Types.Mixed,
  homeSchedule:  mongoose.Schema.Types.Mixed,
}, { versionKey: false });

const UserModel         = mongoose.model('User',             UserSchema);
const AnimeModel        = mongoose.model('Anime',            AnimeSchema);
const CommentStore      = mongoose.model('CommentStore',     CommentStoreSchema);
const RatingStore       = mongoose.model('RatingStore',      RatingStoreSchema);
const FollowStore       = mongoose.model('FollowStore',      FollowStoreSchema);
const NotificationStore = mongoose.model('NotificationStore',NotificationStoreSchema);
const SettingsModel     = mongoose.model('Settings',         SettingsSchema);

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch {
  console.warn('[AniLand] ⚠️  "ws" paketi bulunamadı. Watch Together devre dışı.');
  console.warn('[AniLand]    Kurmak için: npm install ws');
}


const PORT          = process.env.PORT || 3030;
const USERS_FILE    = path.join(__dirname, 'users.json');
const ANIMES_FILE   = path.join(__dirname, 'animes.json');
const COMMENTS_FILE = path.join(__dirname, 'comments.json');
const RATINGS_FILE  = path.join(__dirname, 'ratings.json');
const FOLLOWS_FILE  = path.join(__dirname, 'follows.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const HTML_FILE     = path.join(__dirname, 'aniland.html');
const ANIME_FILE    = path.join(__dirname, 'anime.html');
const SEZON_FILE    = path.join(__dirname, 'sezon.html');
const TAKVIM_FILE   = path.join(__dirname, 'takvim.html');
const TOP100_FILE   = path.join(__dirname, 'top100.html');

// CORS: production'da ALLOWED_ORIGIN env var ile kısıtla
// örn: ALLOWED_ORIGIN=https://aniland.com node server.js
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ─── HTML önbelleği (bir kez oku, bellekte tut) ──────────────────────────────
const _htmlCaches = {};
const _htmlMtimes = {};
function getHtml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    if (!_htmlCaches[filePath] || _htmlMtimes[filePath] !== mtime) {
      _htmlCaches[filePath] = fs.readFileSync(filePath, 'utf8');
      _htmlMtimes[filePath] = mtime;
      if (_htmlMtimes[filePath]) console.log(`[AniLand] 🔄 HTML yenilendi: ${path.basename(filePath)}`);
    }
  } catch { return null; }
  return _htmlCaches[filePath];
}

// ─── Basit Async Mutex ───────────────────────────────────────────────────────
// JSON dosyalarına eş zamanlı yazma (race condition) önler.
class Mutex {
  constructor() { this._queue = []; this._locked = false; }
  lock() {
    return new Promise(resolve => {
      if (!this._locked) { this._locked = true; resolve(); }
      else this._queue.push(resolve);
    });
  }
  unlock() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

const usersMutex    = new Mutex();
const animesMutex   = new Mutex();
const commentsMutex = new Mutex();
const ratingsMutex  = new Mutex();
const followsMutex  = new Mutex();
const notificationsMutex = new Mutex();

// ─── PBKDF2 yardımcıları ─────────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// ─── Kullanıcı verisi ─────────────────────────────────────────────────────────
async function readUsers() {
  return UserModel.find({}).lean();
}

async function writeUsers(users) {
  await UserModel.deleteMany({});
  if (users.length) await UserModel.insertMany(users, { ordered: false }).catch(() => {});
}

async function withUsers(fn) {
  await usersMutex.lock();
  try {
    const users = await readUsers();
    const result = await fn(users);
    return result;
  } finally {
    usersMutex.unlock();
  }
}

// ─── Anime verisi (local JSON + FTP sync) ────────────────────────────────────
async function readAnimes() {
  try {
    const raw = fs.readFileSync(ANIMES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeAnimes(list) {
  fs.writeFileSync(ANIMES_FILE, JSON.stringify(list, null, 2), 'utf8');
  ftpSyncAnimes();
}

async function withAnimes(fn) {
  await animesMutex.lock();
  try {
    const list = await readAnimes();
    const result = await fn(list);
    return result;
  } finally {
    animesMutex.unlock();
  }
}

// ─── Yorum verisi ─────────────────────────────────────────────────────────────
async function readComments() {
  const docs = await CommentStore.find({}).lean();
  const result = {};
  for (const d of docs) result[d.key] = d.comments;
  return result;
}

async function writeComments(data) {
  const ops = Object.entries(data).map(([key, comments]) => ({
    updateOne: { filter: { key }, update: { $set: { comments } }, upsert: true }
  }));
  if (ops.length) await CommentStore.bulkWrite(ops);
}

async function withComments(fn) {
  await commentsMutex.lock();
  try {
    const data = await readComments();
    const result = await fn(data);
    return result;
  } finally {
    commentsMutex.unlock();
  }
}

// ─── Puan verisi ──────────────────────────────────────────────────────────────
async function readRatings() {
  const docs = await RatingStore.find({}).lean();
  const result = {};
  for (const d of docs) result[d.slug] = d.ratings || {};
  return result;
}

async function writeRatings(data) {
  const ops = Object.entries(data).map(([slug, ratings]) => ({
    updateOne: { filter: { slug }, update: { $set: { ratings } }, upsert: true }
  }));
  if (ops.length) await RatingStore.bulkWrite(ops);
}

async function withRatings(fn) {
  await ratingsMutex.lock();
  try {
    const data = await readRatings();
    const result = await fn(data);
    return result;
  } finally {
    ratingsMutex.unlock();
  }
}

// ─── Takipçi verisi ───────────────────────────────────────────────────────────
async function readFollows() {
  const docs = await FollowStore.find({}).lean();
  const result = {};
  for (const d of docs) result[d.username] = d.following || [];
  return result;
}

async function writeFollows(data) {
  const ops = Object.entries(data).map(([username, following]) => ({
    updateOne: { filter: { username }, update: { $set: { following } }, upsert: true }
  }));
  if (ops.length) await FollowStore.bulkWrite(ops);
}

async function withFollows(fn) {
  await followsMutex.lock();
  try {
    const data = await readFollows();
    const result = await fn(data);
    return result;
  } finally {
    followsMutex.unlock();
  }
}

// ─── Site ayarları ────────────────────────────────────────────────────────────
const settingsMutex = new Mutex();
const DEFAULT_SETTINGS = {
  marqueeItems: ['AniLand\'e Hoş Geldiniz!'],
  featuredAnime: { slug: '', title: 'Editörün Seçimi', desc: '', genres: [], emoji: '⭐', btnText: '▶ Şimdi İzle' },
  homeSchedule: [
    { day: 'Pzt', items: [] }, { day: 'Sal', items: [] }, { day: 'Çar', items: [] },
    { day: 'Per', items: [] }, { day: 'Cum', items: [] }, { day: 'Cmt', items: [] }, { day: 'Paz', items: [] }
  ]
};

async function readSettings() {
  const doc = await SettingsModel.findById('settings').lean();
  return { ...DEFAULT_SETTINGS, ...(doc || {}) };
}

async function writeSettings(data) {
  await SettingsModel.findByIdAndUpdate('settings', { $set: data }, { upsert: true, new: true });
}

async function withSettings(fn) {
  await settingsMutex.lock();
  try {
    const data = await readSettings();
    const result = await fn(data);
    return result;
  } finally {
    settingsMutex.unlock();
  }
}

// ─── Bildirim verisi ──────────────────────────────────────────────────────────
async function readNotifications() {
  const docs = await NotificationStore.find({}).lean();
  const result = {};
  for (const d of docs) result[d.username] = d.notifications || [];
  return result;
}

async function writeNotifications(data) {
  const ops = Object.entries(data).map(([username, notifications]) => ({
    updateOne: { filter: { username }, update: { $set: { notifications } }, upsert: true }
  }));
  if (ops.length) await NotificationStore.bulkWrite(ops);
}

async function withNotifications(fn) {
  await notificationsMutex.lock();
  try {
    const data = await readNotifications();
    const result = await fn(data);
    return result;
  } finally {
    notificationsMutex.unlock();
  }
}

async function ensureAdminExists() {
  const users = await readUsers();
  if (users.find(u => u.username === 'admin')) return;
  const { hash, salt } = hashPassword('admin123');
  users.push({
    username: 'admin',
    email: 'admin@aniland.com',
    hash, salt,
    role: 'admin',
    joined: Date.now()
  });
  await writeUsers(users);
  console.log('[AniLand] Admin kullanıcısı oluşturuldu. Kullanıcı: admin | Şifre: admin123');
}

// ─── Aktif izleyici takibi (in-memory) ────────────────────────────────────────
// { slug: { ep: Map<ip, lastSeen> } }
const viewerMap = new Map();
const VIEWER_TTL = 2 * 60 * 1000; // 2 dakika

function pingViewer(slug, ep, ip) {
  if (!slug) return;
  if (!viewerMap.has(slug)) viewerMap.set(slug, new Map());
  const key = `${ep}:${ip}`;
  viewerMap.get(slug).set(key, Date.now());
}

function getViewerCount(slug) {
  if (!viewerMap.has(slug)) return 0;
  const now = Date.now();
  let count = 0;
  for (const [k, t] of viewerMap.get(slug)) {
    if (now - t < VIEWER_TTL) count++;
    else viewerMap.get(slug).delete(k);
  }
  return count;
}

// ─── Oturum yönetimi (in-memory) ──────────────────────────────────────────────
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 gün

const sessions = new Map();

function createToken(userRecord) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username: userRecord.username,
    email:    userRecord.email,
    role:     userRecord.role,
    joined:   userRecord.joined,
    loginAt:  Date.now()
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.loginAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

// ─── Brute-force koruması ─────────────────────────────────────────────────────
// IP başına 5 hatalı denemeden sonra 15 dakika kilit.
const loginAttempts = new Map(); // ip → { count, lockedUntil }
const MAX_ATTEMPTS  = 5;
const LOCK_MS       = 15 * 60 * 1000;

function checkBruteForce(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { blocked: false };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - now) / 60000);
    return { blocked: true, remaining };
  }
  // Kilit süresi dolmuş — sıfırla
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    loginAttempts.delete(ip);
  }
  return { blocked: false };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCK_MS;
    console.warn(`[AniLand] Brute-force: ${ip} 15 dakika kilitlendi.`);
  }
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

// ─── HTTP yardımcıları ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 50e6) reject(new Error('Too large'));
    });
    req.on('end', () => {
      if (!data.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(),
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// E-posta basit format kontrolü
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Watch Together — Oda Yönetimi ───────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoomSafeState(room) {
  return {
    code: room.code,
    animeSlug: room.animeSlug,
    animeTitle: room.animeTitle,
    episode: room.episode,
    currentTime: room.currentTime,
    isPlaying: room.isPlaying,
    members: Array.from(room.members.values()).map(m => ({
      username: m.username,
      joinedAt: m.joinedAt
    }))
  };
}

function broadcastToRoom(room, message, excludeUsername = null) {
  const payload = JSON.stringify(message);
  for (const [username, member] of room.members) {
    if (excludeUsername && username === excludeUsername) continue;
    if (member.ws.readyState === 1) {
      member.ws.send(payload);
    }
  }
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room && room.members.size === 0) {
    rooms.delete(code);
    console.log(`[Watch Together] Oda silindi: ${code}`);
  }
}

function formatTime(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

// ─── WebSocket mesaj işleyici ──────────────────────────────────────────────────
function handleWsMessage(ws, session, rawData) {
  let msg;
  try { msg = JSON.parse(rawData); } catch { return; }

  const { type, roomCode } = msg;
  const username = session.username;

  // ── Oda Oluştur ──────────────────────────────────────────────────────────
  if (type === 'room:create') {
    const { animeSlug, animeTitle, episode } = msg;
    if (!animeSlug) {
      return ws.send(JSON.stringify({ type: 'error', message: 'animeSlug gerekli.' }));
    }
    if (ws.roomCode) leaveRoom(ws, session);
    const code = generateRoomCode();
    const room = {
      code, animeSlug,
      animeTitle: animeTitle || animeSlug,
      episode: episode || 1,
      currentTime: 0,
      isPlaying: false,
      createdAt: Date.now(),
      members: new Map()
    };
    room.members.set(username, { ws, username, joinedAt: Date.now() });
    rooms.set(code, room);
    ws.roomCode = code;
    ws.username = username;
    console.log(`[Watch Together] Oda oluşturuldu: ${code} | ${username} | ${animeTitle}`);
    ws.send(JSON.stringify({ type: 'room:created', state: getRoomSafeState(room) }));
    return;
  }

  // ── Odaya Katıl ───────────────────────────────────────────────────────────
  if (type === 'room:join') {
    if (!roomCode) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Oda kodu gerekli.' }));
    }
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
      return ws.send(JSON.stringify({
        type: 'error',
        message: 'Oda bulunamadı. Kod yanlış veya oda kapanmış olabilir.'
      }));
    }
    // Aynı kullanıcı zaten bu odadaysa tekrar katılmasın
    if (ws.roomCode === roomCode.toUpperCase() && room.members.has(username)) {
      return ws.send(JSON.stringify({ type: 'room:joined', state: getRoomSafeState(room) }));
    }
    if (ws.roomCode) leaveRoom(ws, session);
    room.members.set(username, { ws, username, joinedAt: Date.now() });
    ws.roomCode = roomCode.toUpperCase();
    ws.username = username;
    console.log(`[Watch Together] ${username} katıldı: ${roomCode}`);
    ws.send(JSON.stringify({ type: 'room:joined', state: getRoomSafeState(room) }));
    broadcastToRoom(room, { type: 'room:memberUpdate', members: getRoomSafeState(room).members }, username);
    broadcastToRoom(room, { type: 'chat:system', message: `${username} odaya katıldı 👋`, timestamp: Date.now() }, username);
    return;
  }

  // ── Aşağıdaki mesajlar için oda üyesi olmak şart ─────────────────────────
  const room = rooms.get(ws.roomCode);
  if (!room || !room.members.has(username)) {
    return ws.send(JSON.stringify({ type: 'error', message: 'Bir odada değilsin.' }));
  }

  if (type === 'sync:play') {
    room.isPlaying = true;
    room.currentTime = msg.currentTime || 0;
    broadcastToRoom(room, { type: 'sync:play', currentTime: room.currentTime, by: username, timestamp: Date.now() });
    return;
  }

  if (type === 'sync:pause') {
    room.isPlaying = false;
    room.currentTime = msg.currentTime || room.currentTime;
    broadcastToRoom(room, { type: 'sync:pause', currentTime: room.currentTime, by: username, timestamp: Date.now() });
    return;
  }

  if (type === 'sync:seek') {
    room.currentTime = msg.currentTime || 0;
    if (msg.episode) room.episode = msg.episode;
    broadcastToRoom(room, { type: 'sync:seek', currentTime: room.currentTime, episode: room.episode, by: username, timestamp: Date.now() });
    return;
  }

  if (type === 'sync:episode') {
    if (!msg.episode) return;
    room.episode = msg.episode;
    room.currentTime = 0;
    room.isPlaying = false;
    broadcastToRoom(room, { type: 'sync:episode', episode: room.episode, by: username, timestamp: Date.now() });
    return;
  }

  if (type === 'chat:message') {
    const text = (msg.text || '').trim().slice(0, 500);
    if (!text) return;
    broadcastToRoom(room, { type: 'chat:message', username, text, timestamp: Date.now() });
    return;
  }

  if (type === 'chat:emoji') {
    const allowed = ['🔥','😭','😂','🤯','❤️','👏','😱','💀','⚡','🗡️'];
    const emoji = allowed.includes(msg.emoji) ? msg.emoji : '🔥';
    broadcastToRoom(room, { type: 'chat:emoji', username, emoji, timestamp: Date.now() });
    return;
  }

  if (type === 'room:leave') {
    leaveRoom(ws, session);
    ws.send(JSON.stringify({ type: 'room:left' }));
    return;
  }
}

function leaveRoom(ws, session) {
  const code = ws.roomCode;
  const username = ws.username || session?.username;
  if (!code || !username) return;
  const room = rooms.get(code);
  if (!room) return;
  room.members.delete(username);
  ws.roomCode = null;
  console.log(`[Watch Together] ${username} ayrıldı: ${code} (kalan: ${room.members.size})`);
  if (room.members.size === 0) {
    cleanupRoom(code);
  } else {
    broadcastToRoom(room, { type: 'room:memberUpdate', members: getRoomSafeState(room).members });
    broadcastToRoom(room, { type: 'chat:system', message: `${username} odadan ayrıldı 👋`, timestamp: Date.now() });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const routes = {

  'POST /api/register': async (req, res) => {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const { username, email, password } = body;
    if (!username || !email || !password)
      return json(res, 400, { error: 'Tüm alanları doldurun.' });
    if (!isValidEmail(email))
      return json(res, 400, { error: 'Geçerli bir e-posta adresi girin.' });
    if (password.length < 6)
      return json(res, 400, { error: 'Şifre en az 6 karakter olmalı.' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return json(res, 400, { error: 'Kullanıcı adı 3-20 karakter, sadece harf/rakam/alt çizgi.' });

    return withUsers(async (users) => {
      if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return json(res, 409, { error: 'Bu kullanıcı adı zaten alınmış.' });
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return json(res, 409, { error: 'Bu e-posta zaten kayıtlı.' });

      const { hash, salt } = hashPassword(password);
      const newUser = { username, email, hash, salt, role: 'user', joined: Date.now() };
      users.push(newUser);
      await writeUsers(users);
      const token = createToken(newUser);
      return json(res, 200, { token, user: { username, email, role: 'user', joined: newUser.joined } });
    });
  },

  'POST /api/login': async (req, res) => {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const ip = getClientIp(req);
    const bf = checkBruteForce(ip);
    if (bf.blocked)
      return json(res, 429, { error: `Çok fazla hatalı deneme. ${bf.remaining} dakika sonra tekrar dene.` });

    const { usernameOrEmail, password } = body;
    if (!usernameOrEmail || !password)
      return json(res, 400, { error: 'Kullanıcı adı ve şifre gerekli.' });

    const users = await readUsers();
    const user  = users.find(u =>
      u.username.toLowerCase() === usernameOrEmail.toLowerCase() ||
      u.email.toLowerCase()    === usernameOrEmail.toLowerCase()
    );

    if (!user) {
      console.warn(`[login] başarısız — kullanıcı bulunamadı: "${usernameOrEmail}" (ip: ${ip})`);
      recordFailedLogin(ip);
      return json(res, 401, { error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    let valid = false;
    try { valid = verifyPassword(password, user.hash, user.salt); }
    catch { valid = false; }

    if (!valid) {
      console.warn(`[login] başarısız — yanlış şifre: "${user.username}" (ip: ${ip})`);
      recordFailedLogin(ip);
      return json(res, 401, { error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    console.log(`[login] başarılı — kullanıcı: "${user.username}" rol: ${user.role} (ip: ${ip})`);
    clearLoginAttempts(ip);
    const token = createToken(user);
    return json(res, 200, {
      token,
      user: { username: user.username, email: user.email, role: user.role, joined: user.joined }
    });
  },

  'POST /api/logout': async (req, res) => {
    destroySession(getToken(req));
    return json(res, 200, { ok: true });
  },

  'GET /api/me': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Oturum açık değil.' });
    const users = await readUsers();
    const user  = users.find(u => u.username === session.username);
    if (!user) return json(res, 401, { error: 'Kullanıcı bulunamadı.' });
    return json(res, 200, {
      user: {
        username: user.username,
        email: user.email,
        role: user.role,
        joined: user.joined,
        loginAt: session.loginAt
      }
    });
  },

  'GET /api/users': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    const users = (await readUsers()).map(({ hash, salt, ...safe }) => safe);
    return json(res, 200, { users });
  },

  'DELETE /api/users': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    const target = extra.username;
    if (!target || target === 'admin')
      return json(res, 400, { error: 'Bu kullanıcı silinemez.' });

    return withUsers(async (users) => {
      const before = users.length;
      const newList = users.filter(u => u.username !== target);
      if (newList.length === before) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });
      await writeUsers(newList);
      for (const [token, data] of sessions) {
        if (data.username === target) sessions.delete(token);
      }
      return json(res, 200, { ok: true });
    });
  },

  'PATCH /api/users/role': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const { role } = body;
    if (!['admin','user'].includes(role))
      return json(res, 400, { error: 'Geçersiz rol.' });

    return withUsers(async (users) => {
      const user = users.find(u => u.username === extra.username);
      if (!user) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });
      user.role = role;
      await writeUsers(users);
      return json(res, 200, { ok: true });
    });
  },

  'DELETE /api/account': async (req, res) => {
    const token   = getToken(req);
    const session = getSession(token);
    if (!session) return json(res, 401, { error: 'Oturum açık değil.' });
    if (session.username === 'admin')
      return json(res, 400, { error: 'Admin hesabı silinemez.' });

    return withUsers(async (users) => {
      const newList = users.filter(u => u.username !== session.username);
      await writeUsers(newList);
      destroySession(token);
      return json(res, 200, { ok: true });
    });
  },

  'PATCH /api/password': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Oturum açık değil.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword)
      return json(res, 400, { error: 'Mevcut ve yeni şifre gerekli.' });
    if (newPassword.length < 6)
      return json(res, 400, { error: 'Yeni şifre en az 6 karakter olmalı.' });

    return withUsers(async (users) => {
      const user = users.find(u => u.username === session.username);
      if (!user) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });
      if (!verifyPassword(currentPassword, user.hash, user.salt))
        return json(res, 401, { error: 'Mevcut şifre hatalı.' });
      const { hash, salt } = hashPassword(newPassword);
      user.hash = hash;
      user.salt = salt;
      await writeUsers(users);
      return json(res, 200, { ok: true });
    });
  },

  // ── Anime API ────────────────────────────────────────────────────────────

  'GET /api/animes': async (req, res) => {
    return json(res, 200, { animes: await readAnimes() });
  },

  // ── Site Ayarları ────────────────────────────────────────────────────────
  'GET /api/settings': async (_req, res) => {
    return json(res, 200, await readSettings());
  },

  'PATCH /api/settings': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    return withSettings(async (settings) => {
      if (Array.isArray(body.marqueeItems)) settings.marqueeItems = body.marqueeItems;
      if (body.featuredAnime && typeof body.featuredAnime === 'object')
        settings.featuredAnime = { ...settings.featuredAnime, ...body.featuredAnime };
      if (Array.isArray(body.homeSchedule)) settings.homeSchedule = body.homeSchedule;
      await writeSettings(settings);
      return json(res, 200, { ok: true, settings });
    });
  },

  // Herkese açık sıralama endpoint'i — kullanıcı puanları + yorum sayısına göre
  'GET /api/animes/ranked': async (_req, res) => {
    const animes   = await readAnimes();
    const ratings  = await readRatings();
    const comments = await readComments();

    // Yorum sayısı haritası
    const commentCounts = {};
    for (const [key, list] of Object.entries(comments)) {
      const slug = key.split(':')[0];
      commentCounts[slug] = (commentCounts[slug] || 0) + list.length;
    }
    const maxComments = Math.max(1, ...Object.values(commentCounts).concat([1]));

    const ranked = animes.map(a => {
      const r = ratings[a.slug] || {};
      const vals = Object.values(r);
      const avgRating = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      const ratingCount = vals.length;
      const commentCount = commentCounts[a.slug] || 0;
      const ownScore = parseFloat(a.score) || 0;
      const normalizedComments = commentCount / maxComments;

      let composite;
      if (ratingCount > 0) {
        // Kullanıcı puanı var: ağırlık %60 puan, %20 yorum, %20 kendi skoru
        composite = (avgRating / 5 * 10 * 0.6) + (normalizedComments * 2) + (ownScore / 10 * 2);
      } else {
        // Puan yok: kendi skoru + yorum bonusu
        composite = (ownScore / 10 * 7) + (normalizedComments * 3);
      }

      return Object.assign({}, a, {
        avgRating: Math.round(avgRating * 100) / 100,
        ratingCount,
        commentCount,
        composite: Math.round(composite * 1000) / 1000,
        // Normalize display score: her zaman 0-10 skalasında
        displayScore: ratingCount > 0
          ? Math.round(avgRating * 2 * 100) / 100  // 1-5 → 1-10
          : ownScore,
      });
    }).sort((a, b) => b.composite - a.composite);

    return json(res, 200, { animes: ranked });
  },

  'POST /api/animes': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    if (!body.title || !body.genre)
      return json(res, 400, { error: 'title ve genre zorunlu.' });

    return withAnimes(async (list) => {
      const slug = body.slug || body.title.toLowerCase()
        .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
        .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

      if (list.find(a => a.slug === slug))
        return json(res, 409, { error: 'Bu slug zaten mevcut: ' + slug });

      // ID her zaman sunucu tarafında üretilir
      const anime = {
        id: Date.now().toString(),
        title: body.title,
        slug,
        emoji: body.emoji || '🎬',
        genre: body.genre,
        score: body.score || '',
        eps: body.eps || '1',
        year: body.year || new Date().getFullYear(),
        color1: body.color1 || '#1a0a2e',
        color2: body.color2 || '#2e0a1a',
        desc: body.desc || '',
        epLinks:  body.epLinks  || {},
        epTitles: body.epTitles || {},
        epSubs:   body.epSubs   || {},
        epMeta:   body.epMeta   || {},
        coverImage:  body.coverImage  || '',
        bannerImage: body.bannerImage || '',
        altTitle:    body.altTitle    || '',
        addedAt: Date.now()
      };
      list.unshift(anime);
      await writeAnimes(list);
      console.log(`[POST /api/animes] eklendi — "${anime.title}" (slug: ${anime.slug}, epLink sayısı: ${Object.keys(anime.epLinks).length})`);
      return json(res, 200, { anime });
    });
  },

  'DELETE /api/animes': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    const id = extra.id;
    if (!id) return json(res, 400, { error: 'id gerekli.' });

    return withAnimes(async (list) => {
      const before = list.length;
      const newList = list.filter(a => a.id !== id);
      if (newList.length === before) return json(res, 404, { error: 'Anime bulunamadı.' });
      await writeAnimes(newList);
      return json(res, 200, { ok: true });
    });
  },

  'DELETE /api/animes/clear': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    return withAnimes(async () => {
      await writeAnimes([]);
      return json(res, 200, { ok: true });
    });
  },

  'PATCH /api/animes': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    const { id } = extra;
    if (!id) return json(res, 400, { error: 'id gerekli.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    if (!body.title || !body.genre)
      return json(res, 400, { error: 'title ve genre zorunlu.' });

    return withAnimes(async (list) => {
      const idx = list.findIndex(a => a.id === id);
      if (idx === -1) return json(res, 404, { error: 'Anime bulunamadı.' });

      const newSlug = body.slug || body.title.toLowerCase()
        .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
        .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

      const conflicting = list.find((a, i) => a.slug === newSlug && i !== idx);
      if (conflicting)
        return json(res, 409, { error: 'Bu slug başka bir animede kullanılıyor: ' + newSlug });

      const anime = list[idx];
      anime.title   = body.title;
      anime.slug    = newSlug;
      if (body.emoji  !== undefined) anime.emoji  = body.emoji;
      if (body.genre)                anime.genre  = body.genre;
      if (body.score  !== undefined) anime.score  = body.score;
      if (body.eps    !== undefined) anime.eps    = body.eps;
      if (body.year   !== undefined) anime.year   = body.year;
      if (body.color1 !== undefined) anime.color1 = body.color1;
      if (body.color2 !== undefined) anime.color2 = body.color2;
      if (body.desc   !== undefined) anime.desc   = body.desc;
      if (body.epLinks  !== undefined) anime.epLinks  = body.epLinks;
      if (body.epTitles !== undefined) anime.epTitles = body.epTitles;
      if (body.epSubs   !== undefined) anime.epSubs   = body.epSubs;
      if (body.epMeta   !== undefined) anime.epMeta   = body.epMeta;
      if (body.coverImage  !== undefined) anime.coverImage  = body.coverImage;
      if (body.bannerImage !== undefined) anime.bannerImage = body.bannerImage;
      if (body.altTitle    !== undefined) anime.altTitle    = body.altTitle;
      anime.updatedAt = Date.now();
      list[idx] = anime;
      await writeAnimes(list);
      console.log(`[PATCH /api/animes] güncellendi — "${anime.title}" (id: ${id}, epLink sayısı: ${Object.keys(anime.epLinks||{}).length})`);
      return json(res, 200, { anime });
    });
  },

  'POST /api/animes/bulk': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const animes = body.animes;
    if (!Array.isArray(animes) || animes.length === 0)
      return json(res, 400, { error: 'animes dizisi gerekli.' });
    if (animes.length > 500)
      return json(res, 400, { error: 'Tek seferde en fazla 500 anime içe aktarılabilir.' });

    return withAnimes(async (list) => {
      const slugIndex = new Map(list.map((a, i) => [a.slug, i]));
      let added = 0, updated = 0, skipped = 0;
      const results = [];
      for (const a of animes) {
        if (!a.title || !a.genre) { skipped++; results.push({ title: a.title || '?', status: 'skipped', reason: 'title/genre eksik' }); continue; }
        const slug = (a.slug || a.title.toLowerCase()
          .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
          .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c')
          .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')) || 'anime-' + Date.now();
        if (slugIndex.has(slug)) {
          // Güncelle — mevcut id ve addedAt korunsun
          const idx = slugIndex.get(slug);
          const existing = list[idx];
          list[idx] = {
            ...existing, slug,
            title:       a.title,
            emoji:       a.emoji       || existing.emoji,
            genre:       a.genre,
            score:       a.score       || existing.score,
            eps:         a.eps         || existing.eps,
            year:        a.year        || existing.year,
            color1:      a.color1      || existing.color1,
            color2:      a.color2      || existing.color2,
            desc:        a.desc        || existing.desc,
            epLinks:     a.epLinks     || existing.epLinks,
            epTitles:    a.epTitles    || existing.epTitles,
            epSubs:      a.epSubs      || existing.epSubs,
            epMeta:      a.epMeta      || existing.epMeta,
            coverImage:  a.coverImage  || existing.coverImage,
            bannerImage: a.bannerImage || existing.bannerImage,
            altTitle:    a.altTitle    || existing.altTitle,
            updatedAt:   Date.now(),
          };
          updated++;
          results.push({ title: a.title, status: 'updated', slug });
        } else {
          const anime = {
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            title: a.title, slug,
            emoji:       a.emoji       || '🎬',
            genre:       a.genre,
            score:       a.score       || '',
            eps:         a.eps         || '1',
            year:        a.year        || new Date().getFullYear(),
            color1:      a.color1      || '#1a0a2e',
            color2:      a.color2      || '#2e0a1a',
            desc:        a.desc        || '',
            epLinks:     a.epLinks     || {},
            epTitles:    a.epTitles    || {},
            epSubs:      a.epSubs      || {},
            epMeta:      a.epMeta      || {},
            coverImage:  a.coverImage  || '',
            bannerImage: a.bannerImage || '',
            altTitle:    a.altTitle    || '',
            addedAt:     Date.now(),
          };
          list.unshift(anime);
          slugIndex.set(slug, 0);
          added++;
          results.push({ title: a.title, status: 'added', slug });
        }
      }
      await writeAnimes(list);
      return json(res, 200, { added, updated, skipped, results });
    });
  },

  // POST /api/admin/sync-cdn — CDN'den HTML ve animes.json'u yeniden çeker (admin only)
  'POST /api/admin/sync-cdn': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });
    const results = { html: false, animes: false };
    try { await syncHtmlFromCDN();   results.html   = true; } catch (e) { console.error('[sync-cdn] HTML hatası:', e.message); }
    try { await syncAnimesFromCDN(); results.animes = true; } catch (e) { console.error('[sync-cdn] Animes hatası:', e.message); }
    return json(res, 200, { ok: true, results });
  },

  'GET /api/analytics': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    const animes   = await readAnimes();
    const users    = await readUsers();
    const comments = await readComments();
    const ratings  = await readRatings();

    // Tür dağılımı
    const genreDist = {};
    animes.forEach(a => { genreDist[a.genre || 'Diğer'] = (genreDist[a.genre || 'Diğer'] || 0) + 1; });

    // En yüksek puanlı animeler
    const topRated = animes
      .map(a => {
        const r = ratings[a.slug] || {};
        const vals = Object.values(r);
        const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
        return { id: a.id, slug: a.slug, title: a.title, emoji: a.emoji, avg: Math.round(avg * 10) / 10, count: vals.length };
      })
      .filter(a => a.count > 0)
      .sort((a, b) => b.avg - a.avg || b.count - a.count)
      .slice(0, 10);

    // En çok yorum yapılan animeler
    const commentCounts = {};
    for (const [key, list] of Object.entries(comments)) {
      const slug = key.split(':')[0];
      commentCounts[slug] = (commentCounts[slug] || 0) + list.length;
    }
    const mostCommented = Object.entries(commentCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([slug, count]) => {
        const a = animes.find(x => x.slug === slug);
        return { slug, title: a ? a.title : slug, emoji: a ? a.emoji : '🎬', count };
      });

    // Son 30 günde kayıt olan kullanıcılar (güne göre)
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const usersByDay = {};
    users.forEach(u => {
      if (u.joined && (now - u.joined) < thirtyDays) {
        const d = new Date(u.joined).toISOString().slice(0, 10);
        usersByDay[d] = (usersByDay[d] || 0) + 1;
      }
    });

    // Toplam sayılar
    let totalComments = 0, totalReplies = 0;
    for (const list of Object.values(comments)) {
      totalComments += list.length;
      list.forEach(c => { totalReplies += (c.replies || []).length; });
    }
    let totalRatings = 0;
    for (const rMap of Object.values(ratings)) totalRatings += Object.keys(rMap).length;

    return json(res, 200, {
      totals: { animes: animes.length, users: users.length, comments: totalComments, replies: totalReplies, ratings: totalRatings },
      genreDistribution: genreDist,
      topRated,
      mostCommented,
      usersByDay,
    });
  },

  // ── Yorum API ────────────────────────────────────────────────────────────

  // GET /api/comments/:slug/:ep  — yorumları getir
  'GET /api/comments': async (req, res, extra) => {
    const { slug, ep } = extra;
    if (!slug || !ep) return json(res, 400, { error: 'slug ve ep gerekli.' });
    const data = await readComments();
    const key  = slug + ':' + ep;
    return json(res, 200, { comments: data[key] || [] });
  },

  // POST /api/comments/:slug/:ep  — yorum ekle
  'POST /api/comments': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep } = extra;
    if (!slug || !ep) return json(res, 400, { error: 'slug ve ep gerekli.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const text = (body.text || '').trim();
    if (!text)          return json(res, 400, { error: 'Yorum metni boş olamaz.' });
    if (text.length > 500) return json(res, 400, { error: 'Yorum en fazla 500 karakter.' });

    const gradients = [
      'linear-gradient(135deg,#6b35ff,#ff6b9d)',
      'linear-gradient(135deg,#00f5d4,#0a6b5e)',
      'linear-gradient(135deg,#ffd166,#ff6b35)',
      'linear-gradient(135deg,#ff3860,#6b35ff)',
      'linear-gradient(135deg,#00c9ae,#0060ff)',
    ];
    const emojis = ['🦊','🐉','⚡','🌸','🎭','🔥','🌊','⭐'];
    const seed   = session.username.charCodeAt(0) || 0;

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      if (!data[key]) data[key] = [];
      const comment = {
        id:          Date.now().toString() + Math.random().toString(36).slice(2,6),
        username:    session.username,
        text,
        ts:          Date.now(),
        likes:       0,
        likedBy:     [],
        avatarGrad:  gradients[seed % gradients.length],
        avatarEmoji: emojis[seed % emojis.length],
      };
      data[key].push(comment);
      await writeComments(data);
      return json(res, 200, { comment });
    });
  },

  // DELETE /api/comments/:slug/:ep/:id  — yorum sil (kendi yorumu veya admin)
  'DELETE /api/comments': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id } = extra;
    if (!slug || !ep || !id) return json(res, 400, { error: 'slug, ep ve id gerekli.' });

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      const list = data[key] || [];
      const idx  = list.findIndex(c => c.id === id);
      if (idx === -1) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (list[idx].username !== session.username && session.role !== 'admin')
        return json(res, 403, { error: 'Yetki yok.' });
      list.splice(idx, 1);
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { ok: true });
    });
  },

  // POST /api/comments/:slug/:ep/:id/like  — beğen / beğeniyi geri al
  'POST /api/comments/like': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id } = extra;
    if (!slug || !ep || !id) return json(res, 400, { error: 'slug, ep ve id gerekli.' });

    return withComments(async (data) => {
      const key  = slug + ':' + ep;
      const list = data[key] || [];
      const c    = list.find(x => x.id === id);
      if (!c) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (!c.likedBy) c.likedBy = [];
      const already = c.likedBy.includes(session.username);
      if (already) {
        c.likedBy = c.likedBy.filter(u => u !== session.username);
        c.likes   = Math.max(0, (c.likes || 0) - 1);
      } else {
        c.likedBy.push(session.username);
        c.likes = (c.likes || 0) + 1;
      }
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { likes: c.likes, liked: !already });
    });
  },

  // POST /api/comments/:slug/:ep/:id/reply  — yanıt ekle
  'POST /api/comments/reply': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id } = extra;
    if (!slug || !ep || !id) return json(res, 400, { error: 'slug, ep ve id gerekli.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const text = (body.text || '').trim();
    if (!text)          return json(res, 400, { error: 'Yanıt metni boş olamaz.' });
    if (text.length > 300) return json(res, 400, { error: 'Yanıt en fazla 300 karakter.' });

    const gradients = [
      'linear-gradient(135deg,#6b35ff,#ff6b9d)',
      'linear-gradient(135deg,#00f5d4,#0a6b5e)',
      'linear-gradient(135deg,#ffd166,#ff6b35)',
      'linear-gradient(135deg,#ff3860,#6b35ff)',
      'linear-gradient(135deg,#00c9ae,#0060ff)',
    ];
    const emojis = ['🦊','🐉','⚡','🌸','🎭','🔥','🌊','⭐'];
    const seed   = session.username.charCodeAt(0) || 0;

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      const list = data[key] || [];
      const comment = list.find(c => c.id === id);
      if (!comment) return json(res, 404, { error: 'Yorum bulunamadı.' });
      
      if (!comment.replies) comment.replies = [];
      const reply = {
        id:          Date.now().toString() + Math.random().toString(36).slice(2,6),
        commentId:   id,
        username:    session.username,
        text,
        ts:          Date.now(),
        likes:       0,
        likedBy:     [],
        avatarGrad:  gradients[seed % gradients.length],
        avatarEmoji: emojis[seed % emojis.length],
      };
      comment.replies.push(reply);
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { reply });
    });
  },

  // DELETE /api/comments/:slug/:ep/:id/reply/:replyId  — yanıtı sil
  'DELETE /api/comments/reply': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id, replyId } = extra;
    if (!slug || !ep || !id || !replyId) return json(res, 400, { error: 'Tüm parametreler gerekli.' });

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      const list = data[key] || [];
      const comment = list.find(c => c.id === id);
      if (!comment) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (!comment.replies) comment.replies = [];
      
      const replyIdx = comment.replies.findIndex(r => r.id === replyId);
      if (replyIdx === -1) return json(res, 404, { error: 'Yanıt bulunamadı.' });
      
      const reply = comment.replies[replyIdx];
      if (reply.username !== session.username && session.role !== 'admin')
        return json(res, 403, { error: 'Yetki yok.' });
      
      comment.replies.splice(replyIdx, 1);
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { ok: true });
    });
  },

  // POST /api/comments/:slug/:ep/:id/dislike  — yorumu beğenme / geri al
  'POST /api/comments/dislike': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id } = extra;
    if (!slug || !ep || !id) return json(res, 400, { error: 'slug, ep ve id gerekli.' });

    return withComments(async (data) => {
      const key  = slug + ':' + ep;
      const list = data[key] || [];
      const c    = list.find(x => x.id === id);
      if (!c) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (!c.dislikedBy) c.dislikedBy = [];
      if (!c.dislikes) c.dislikes = 0;
      const already = c.dislikedBy.includes(session.username);
      if (already) {
        c.dislikedBy = c.dislikedBy.filter(u => u !== session.username);
        c.dislikes   = Math.max(0, c.dislikes - 1);
      } else {
        // Beğeni varsa kaldır
        if (c.likedBy && c.likedBy.includes(session.username)) {
          c.likedBy = c.likedBy.filter(u => u !== session.username);
          c.likes   = Math.max(0, (c.likes || 0) - 1);
        }
        c.dislikedBy.push(session.username);
        c.dislikes++;
      }
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { dislikes: c.dislikes, disliked: !already, likes: c.likes || 0 });
    });
  },

  // POST /api/comments/:slug/:ep/:id/reply/:replyId/like  — yanıtı beğen
  'POST /api/comments/reply/like': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id, replyId } = extra;
    if (!slug || !ep || !id || !replyId) return json(res, 400, { error: 'Tüm parametreler gerekli.' });

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      const list = data[key] || [];
      const comment = list.find(c => c.id === id);
      if (!comment) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (!comment.replies) comment.replies = [];
      
      const reply = comment.replies.find(r => r.id === replyId);
      if (!reply) return json(res, 404, { error: 'Yanıt bulunamadı.' });
      
      if (!reply.likedBy) reply.likedBy = [];
      const already = reply.likedBy.includes(session.username);
      if (already) {
        reply.likedBy = reply.likedBy.filter(u => u !== session.username);
        reply.likes   = Math.max(0, (reply.likes || 0) - 1);
      } else {
        reply.likedBy.push(session.username);
        reply.likes = (reply.likes || 0) + 1;
      }
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { likes: reply.likes, liked: !already });
    });
  },

  // POST /api/comments/:slug/:ep/:id/reply/:replyId/dislike  — yanıtı beğenme / geri al
  'POST /api/comments/reply/dislike': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug, ep, id, replyId } = extra;
    if (!slug || !ep || !id || !replyId) return json(res, 400, { error: 'Tüm parametreler gerekli.' });

    return withComments(async (data) => {
      const key = slug + ':' + ep;
      const list = data[key] || [];
      const comment = list.find(c => c.id === id);
      if (!comment) return json(res, 404, { error: 'Yorum bulunamadı.' });
      if (!comment.replies) comment.replies = [];
      const reply = comment.replies.find(r => r.id === replyId);
      if (!reply) return json(res, 404, { error: 'Yanıt bulunamadı.' });
      if (!reply.dislikedBy) reply.dislikedBy = [];
      if (!reply.dislikes) reply.dislikes = 0;
      const already = reply.dislikedBy.includes(session.username);
      if (already) {
        reply.dislikedBy = reply.dislikedBy.filter(u => u !== session.username);
        reply.dislikes   = Math.max(0, reply.dislikes - 1);
      } else {
        if (reply.likedBy && reply.likedBy.includes(session.username)) {
          reply.likedBy = reply.likedBy.filter(u => u !== session.username);
          reply.likes   = Math.max(0, (reply.likes || 0) - 1);
        }
        reply.dislikedBy.push(session.username);
        reply.dislikes++;
      }
      data[key] = list;
      await writeComments(data);
      return json(res, 200, { dislikes: reply.dislikes, disliked: !already, likes: reply.likes || 0 });
    });
  },

  // ── Puan API ─────────────────────────────────────────────────────────────

  // GET /api/ratings/:slug  — anime puanlarını getir
  'GET /api/ratings': async (req, res, extra) => {
    const { slug } = extra;
    if (!slug) return json(res, 400, { error: 'slug gerekli.' });
    const data    = await readRatings();
    const ratings = data[slug] || {};
    const values  = Object.values(ratings);
    const avg     = values.length ? (values.reduce((a,b) => a+b, 0) / values.length) : 0;
    const token   = getToken(req);
    const session = getSession(token);
    const myRating = session ? (ratings[session.username] || 0) : 0;
    return json(res, 200, { avg: Math.round(avg * 10) / 10, count: values.length, myRating });
  },

  // POST /api/ratings/:slug  — puan ver / güncelle
  'POST /api/ratings': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { slug } = extra;
    if (!slug) return json(res, 400, { error: 'slug gerekli.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const score = parseInt(body.score);
    if (!score || score < 1 || score > 5)
      return json(res, 400, { error: 'Puan 1-5 arasında olmalı.' });

    return withRatings(async (data) => {
      if (!data[slug]) data[slug] = {};
      data[slug][session.username] = score;
      await writeRatings(data);
      const values = Object.values(data[slug]);
      const avg    = values.reduce((a,b) => a+b, 0) / values.length;
      return json(res, 200, { avg: Math.round(avg * 10) / 10, count: values.length, myRating: score });
    });
  },

  // ── Kullanıcı Arama ──────────────────────────────────────────────────────
  'GET /api/users/search': async (req, res, extra) => {
    const q = (extra.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return json(res, 400, { error: 'En az 2 karakter girin.' });
    const users = await readUsers();
    const results = users
      .filter(u => u.username.toLowerCase().includes(q))
      .slice(0, 10)
      .map(u => ({
        username: u.username,
        role:     u.role,
        joined:   u.joined
      }));
    return json(res, 200, { users: results });
  },

  // ── Herkese Açık Profil ──────────────────────────────────────────────────
  'GET /api/profile': async (req, res, extra) => {
    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });
    const users = await readUsers();
    const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });

    // Yorumları say
    const allComments = await readComments();
    let commentCount = 0;
    for (const list of Object.values(allComments)) {
      commentCount += list.filter(c => c.username === user.username).length;
    }

    // Puanları say
    const allRatings = await readRatings();
    let ratingCount = 0;
    for (const ratingMap of Object.values(allRatings)) {
      if (ratingMap[user.username]) ratingCount++;
    }

    // Takipçileri say
    const follows = await readFollows();
    let followerCount = 0;
    let followingCount = 0;
    for (const followers of Object.values(follows)) {
      if (followers.includes(user.username)) followerCount++;
    }
    followingCount = follows[user.username] ? follows[user.username].length : 0;

    return json(res, 200, {
      profile: {
        username:    user.username,
        role:        user.role,
        joined:      user.joined,
        comments:    commentCount,
        ratings:     ratingCount,
        followers:   followerCount,
        following:   followingCount,
        bio:         user.bio         || '',
        photoDataUrl: user.photoDataUrl || '',
      }
    });
  },

  // ── Profil Güncelle (bio + fotoğraf) ────────────────────────────────────
  'PATCH /api/profile': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Geçersiz istek gövdesi.' }); }

    const { bio, photoDataUrl } = body;

    return withUsers(async (users) => {
      const idx = users.findIndex(u => u.username === session.username);
      if (idx === -1) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });

      if (typeof bio === 'string') {
        users[idx].bio = bio.slice(0, 300); // max 300 karakter
      }
      if (typeof photoDataUrl === 'string') {
        // Sadece base64 data URL kabul et (güvenlik)
        if (photoDataUrl === '' || photoDataUrl.startsWith('data:image/')) {
          users[idx].photoDataUrl = photoDataUrl;
        }
      }
      await writeUsers(users);
      return json(res, 200, { ok: true });
    });
  },

  // ── Takipçi Sistemi ──────────────────────────────────────────────────────
  'POST /api/user/follow': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });
    if (username.toLowerCase() === session.username.toLowerCase())
      return json(res, 400, { error: 'Kendini takip edemezsin.' });

    const users = await readUsers();
    if (!users.find(u => u.username.toLowerCase() === username.toLowerCase()))
      return json(res, 404, { error: 'Kullanıcı bulunamadı.' });

    return withFollows(async (follows) => {
      if (!follows[session.username]) follows[session.username] = [];
      if (follows[session.username].includes(username))
        return json(res, 400, { error: 'Zaten takip ediyorsun.' });

      follows[session.username].push(username);
      await writeFollows(follows);

      // Bildirim gönder
      return withNotifications(async (notif) => {
        const targetUser = username;
        if (!notif[targetUser]) notif[targetUser] = [];
        notif[targetUser].push({
          id: Date.now().toString(),
          type: 'follow',
          from: session.username,
          ts: Date.now(),
          read: false,
        });
        await writeNotifications(notif);
        return json(res, 200, { ok: true });
      });
    });
  },

  'DELETE /api/user/follow': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });

    return withFollows(async (follows) => {
      if (!follows[session.username] || !follows[session.username].includes(username))
        return json(res, 400, { error: 'Zaten takip etmiyorsun.' });

      follows[session.username] = follows[session.username].filter(u => u !== username);
      await writeFollows(follows);
      return json(res, 200, { ok: true });
    });
  },

  'GET /api/user/followers': async (req, res, extra) => {
    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });

    const users = await readUsers();
    if (!users.find(u => u.username.toLowerCase() === username.toLowerCase()))
      return json(res, 404, { error: 'Kullanıcı bulunamadı.' });

    const follows = await readFollows();
    const followers = [];
    for (const [follower, following] of Object.entries(follows)) {
      if (following.includes(username)) {
        const user = users.find(u => u.username === follower);
        if (user) {
          followers.push({
            username: user.username,
            role: user.role,
            joined: user.joined
          });
        }
      }
    }
    return json(res, 200, { followers });
  },

  'GET /api/user/following': async (_req, res, extra) => {
    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });

    const users = await readUsers();
    if (!users.find(u => u.username.toLowerCase() === username.toLowerCase()))
      return json(res, 404, { error: 'Kullanıcı bulunamadı.' });

    const follows = await readFollows();
    const followingList = (follows[username] || []).map(uname => {
      const user = users.find(u => u.username === uname);
      return user ? { username: user.username, role: user.role, joined: user.joined } : null;
    }).filter(Boolean);
    return json(res, 200, { following: followingList });
  },

  // GET /api/user/:username/comments — kullanıcının tüm yorumları
  'GET /api/user/comments': async (_req, res, extra) => {
    const { username } = extra;
    if (!username) return json(res, 400, { error: 'username gerekli.' });
    const data = await readComments();
    const animes = await readAnimes();
    const results = [];
    for (const [key, comments] of Object.entries(data)) {
      const [slug, ep] = key.split('::');
      const anime = animes.find(a => a.slug === slug);
      for (const c of comments) {
        if (c.username === username) {
          results.push({ text: c.text, ts: c.ts, slug, ep, animeTitle: anime ? anime.title : slug });
        }
        for (const r of (c.replies || [])) {
          if (r.username === username) {
            results.push({ text: r.text, ts: r.ts, slug, ep, animeTitle: anime ? anime.title : slug, isReply: true });
          }
        }
      }
    }
    results.sort((a, b) => b.ts - a.ts);
    return json(res, 200, { comments: results });
  },

  // ── Bildirim Sistemi ────────────────────────────────────────────────────
  'GET /api/notifications': async (req, res) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const notif = await readNotifications();
    const userNotif = notif[session.username] || [];
    const unreadCount = userNotif.filter(n => !n.read).length;
    return json(res, 200, { notifications: userNotif, unreadCount });
  },

  'PATCH /api/notifications': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { id } = extra;
    if (!id) return json(res, 400, { error: 'id gerekli.' });

    return withNotifications(async (notif) => {
      const userNotif = notif[session.username] || [];
      const idx = userNotif.findIndex(n => n.id === id);
      if (idx === -1) return json(res, 404, { error: 'Bildirim bulunamadı.' });
      userNotif[idx].read = true;
      notif[session.username] = userNotif;
      await writeNotifications(notif);
      return json(res, 200, { ok: true });
    });
  },

  'DELETE /api/notifications': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });

    const { id } = extra;
    if (!id) return json(res, 400, { error: 'id gerekli.' });

    return withNotifications(async (notif) => {
      const userNotif = notif[session.username] || [];
      const idx = userNotif.findIndex(n => n.id === id);
      if (idx === -1) return json(res, 404, { error: 'Bildirim bulunamadı.' });
      userNotif.splice(idx, 1);
      notif[session.username] = userNotif;
      await writeNotifications(notif);
      return json(res, 200, { ok: true });
    });
  },

  'GET /api/room': async (req, res, extra) => {
    const session = getSession(getToken(req));
    if (!session) return json(res, 401, { error: 'Giriş gerekli.' });
    const room = rooms.get(extra.code);
    if (!room) return json(res, 404, { error: 'Oda bulunamadı.' });
    return json(res, 200, { room: getRoomSafeState(room) });
  },
};

// ─── Ana HTTP sunucusu ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {

  const _t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - _t0;
    if (req.url.startsWith('/api/')) {
      console.log(`[${req.method}] ${req.url} → ${res.statusCode} (${ms}ms)`);
    }
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = req.url.split('?')[0];

  // ─── Statik HTML sayfaları (temiz URL'ler) ──────────────────────────────
  // Dosya servisi: temiz URL → disk dosyası
  const htmlServe = {
    '/':       HTML_FILE,
    '/admin':  HTML_FILE,
    '/anime':  ANIME_FILE,
    '/sezon':  SEZON_FILE,
    '/takvim': TAKVIM_FILE,
    '/top100': TOP100_FILE,
  };
  // Yönlendirme: .html uzantılı → temiz URL (301)
  const htmlRedirects = {
    '/index.html':   '/',
    '/aniland.html': '/',
    '/anime.html':   '/anime',
    '/sezon.html':   '/sezon',
    '/takvim.html':  '/takvim',
    '/top100.html':  '/top100',
  };

  if (req.method === 'GET') {
    if (url in htmlRedirects) {
      res.writeHead(301, { ...corsHeaders(), 'Location': htmlRedirects[url] });
      return res.end();
    }
    if (url in htmlServe) {
      const html = getHtml(htmlServe[url]);
      if (!html) { json(res, 404, { error: 'Sayfa bulunamadı.' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ─── SEO: robots.txt ──────────────────────────────────────────────────
    if (url === '/robots.txt') {
      const robots = [
        'User-agent: *',
        'Allow: /',
        '',
        'Sitemap: https://aniland.net/sitemap.xml',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(robots);
    }

    // ─── SEO: anime deep-link sayfaları (/anime/:slug ve /anime/:slug/ep/:n)
    const _animePathMatch = url.match(/^\/anime\/([^/]+?)(?:\/ep\/(\d+))?$/);
    if (_animePathMatch) {
      const _slug = _animePathMatch[1];
      const _ep   = _animePathMatch[2] ? parseInt(_animePathMatch[2]) : null;

      let html = getHtml(HTML_FILE);
      if (!html) { json(res, 404, { error: 'Sayfa bulunamadı.' }); return; }

      let _anime = null;
      try { _anime = (await readAnimes()).find(a => a.slug === _slug) || null; } catch (_) {}

      if (_anime) {
        const _rawTitle = _ep
          ? `${_anime.title} - Bölüm ${_ep} | AniLand`
          : `${_anime.title} | AniLand — Anime İzle`;
        const _rawDesc  = (_anime.desc || `${_anime.title} animesini Türkçe altyazılı ücretsiz izle.`).slice(0, 155);
        const _canon    = _ep
          ? `https://aniland.net/anime/${_slug}/ep/${_ep}`
          : `https://aniland.net/anime/${_slug}`;
        const _ogImg    = _anime.coverImage || _anime.bannerImage || 'https://aniland.net/og-image.png';

        // HTML attribute-safe escape
        const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const _title = esc(_rawTitle);
        const _desc  = esc(_rawDesc);
        const _img   = esc(_ogImg);

        // Eski generic meta tag'leri sil, sonra anime-specific olanları <head> başına ekle
        html = html
          .replace(/<title>[^<]*<\/title>/, '')
          .replace(/<meta\s+name="description"[^>]*>/gi, '')
          .replace(/<meta\s+name="keywords"[^>]*>/gi, '')
          .replace(/<link\s+rel="canonical"[^>]*>/gi, '')
          .replace(/<meta\s+property="og:[^>]*>/gi, '')
          .replace(/<meta\s+name="twitter:[^>]*>/gi, '');

        const _ld = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'TVSeries',
          name: _anime.title,
          description: _rawDesc,
          image: _ogImg,
          url: _canon,
          genre: _anime.genre || undefined,
          numberOfEpisodes: _anime.eps || undefined,
        });

        const _headInject = [
          `<title>${_title}</title>`,
          `<meta name="description" content="${_desc}">`,
          `<meta name="robots" content="index, follow">`,
          `<link rel="canonical" href="${esc(_canon)}">`,
          `<meta property="og:type" content="website">`,
          `<meta property="og:url" content="${esc(_canon)}">`,
          `<meta property="og:title" content="${_title}">`,
          `<meta property="og:description" content="${_desc}">`,
          `<meta property="og:image" content="${_img}">`,
          `<meta property="og:locale" content="tr_TR">`,
          `<meta property="og:site_name" content="AniLand">`,
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:title" content="${_title}">`,
          `<meta name="twitter:description" content="${_desc}">`,
          `<meta name="twitter:image" content="${_img}">`,
          `<script type="application/ld+json">${_ld}</script>`,
          `<script>window.__DEEPLINK__=${JSON.stringify({slug:_slug,ep:_ep})};</script>`,
        ].join('\n');

        html = html.replace('<head>', '<head>\n' + _headInject);
      } else {
        // Anime bulunamadı — generic html sun, deeplink client'ta graceful fail olur
        const _inject = `<script>window.__DEEPLINK__=${JSON.stringify({slug:_slug,ep:_ep})};</script>`;
        html = html.replace('<head>', '<head>\n' + _inject);
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    // ─── SEO: sitemap.xml ─────────────────────────────────────────────────
    if (url === '/sitemap.xml') {
      const BASE = 'https://aniland.net';
      const today = new Date().toISOString().split('T')[0];
      const staticPages = ['/', '/anime', '/sezon', '/takvim', '/top100'];
      let animes = [];
      try { animes = await readAnimes(); } catch (_) {}

      const urlTags = [
        ...staticPages.map(p => `  <url><loc>${BASE}${p}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>${p === '/' ? '1.0' : '0.8'}</priority></url>`),
        ...animes
          .filter(a => a.slug)
          .map(a => `  <url><loc>${BASE}/anime/${a.slug}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`),
      ].join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlTags}\n</urlset>`;
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(xml);
    }
  }

  // Parametreli route'lar
  if (url.match(/^\/api\/users\/([^/]+)$/) && req.method === 'DELETE')
    return routes['DELETE /api/users'](req, res, { username: url.split('/')[3] });

  if (url.match(/^\/api\/users\/([^/]+)\/role$/) && req.method === 'PATCH')
    return routes['PATCH /api/users/role'](req, res, { username: url.split('/')[3] });

  if (url === '/api/animes/clear' && req.method === 'DELETE')
    return routes['DELETE /api/animes/clear'](req, res, {});

  if (url.match(/^\/api\/animes\/([^/]+)$/) && req.method === 'DELETE')
    return routes['DELETE /api/animes'](req, res, { id: url.split('/')[3] });

  if (url.match(/^\/api\/animes\/([^/]+)$/) && req.method === 'PATCH')
    return routes['PATCH /api/animes'](req, res, { id: url.split('/')[3] });

  if (url === '/api/animes' && req.method === 'GET')
    return routes['GET /api/animes'](req, res, {});

  if (url === '/api/animes' && req.method === 'POST')
    return routes['POST /api/animes'](req, res, {});

  if (url === '/api/animes/bulk' && req.method === 'POST')
    return routes['POST /api/animes/bulk'](req, res, {});

  if (url === '/api/admin/sync-cdn' && req.method === 'POST')
    return routes['POST /api/admin/sync-cdn'](req, res, {});

  if (url === '/api/analytics' && req.method === 'GET')
    return routes['GET /api/analytics'](req, res, {});


  if (url === '/api/settings' && req.method === 'GET')
    return routes['GET /api/settings'](req, res, {});

  if (url === '/api/settings' && req.method === 'PATCH')
    return routes['PATCH /api/settings'](req, res, {});

  if (url === '/api/animes/ranked' && req.method === 'GET')
    return routes['GET /api/animes/ranked'](req, res, {});

  // Yorumlar: /api/comments/:slug/:ep[/:id[/like|dislike|/reply[/:replyId[/like|/dislike]]]]
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)$/) && req.method === 'GET') {
    const [,, slug, ep] = url.split('/');
    return routes['GET /api/comments'](req, res, { slug, ep });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)$/) && req.method === 'POST') {
    const [,, slug, ep] = url.split('/');
    return routes['POST /api/comments'](req, res, { slug, ep });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)$/) && req.method === 'DELETE') {
    const parts = url.split('/');
    return routes['DELETE /api/comments'](req, res, { slug: parts[3], ep: parts[4], id: parts[5] });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/like$/) && req.method === 'POST') {
    const parts = url.split('/');
    return routes['POST /api/comments/like'](req, res, { slug: parts[3], ep: parts[4], id: parts[5] });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/dislike$/) && req.method === 'POST') {
    const parts = url.split('/');
    return routes['POST /api/comments/dislike'](req, res, { slug: parts[3], ep: parts[4], id: parts[5] });
  }

  // Yanıtlar: /api/comments/:slug/:ep/:id/reply[/:replyId[/like|/dislike]]
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/reply$/) && req.method === 'POST') {
    const parts = url.split('/');
    return routes['POST /api/comments/reply'](req, res, { slug: parts[3], ep: parts[4], id: parts[5] });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/reply\/([^/]+)$/) && req.method === 'DELETE') {
    const parts = url.split('/');
    return routes['DELETE /api/comments/reply'](req, res, { slug: parts[3], ep: parts[4], id: parts[5], replyId: parts[7] });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/reply\/([^/]+)\/like$/) && req.method === 'POST') {
    const parts = url.split('/');
    return routes['POST /api/comments/reply/like'](req, res, { slug: parts[3], ep: parts[4], id: parts[5], replyId: parts[7] });
  }
  if (url.match(/^\/api\/comments\/([^/]+)\/(\d+)\/([^/]+)\/reply\/([^/]+)\/dislike$/) && req.method === 'POST') {
    const parts = url.split('/');
    return routes['POST /api/comments/reply/dislike'](req, res, { slug: parts[3], ep: parts[4], id: parts[5], replyId: parts[7] });
  }

  // Puanlar: /api/ratings/:slug
  if (url.match(/^\/api\/ratings\/([^/]+)$/) && req.method === 'GET') {
    const slug = url.split('/')[3];
    return routes['GET /api/ratings'](req, res, { slug });
  }
  if (url.match(/^\/api\/ratings\/([^/]+)$/) && req.method === 'POST') {
    const slug = url.split('/')[3];
    return routes['POST /api/ratings'](req, res, { slug });
  }

  // Kullanıcı arama: /api/users/search?q=...
  if (url === '/api/users/search' && req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    return routes['GET /api/users/search'](req, res, { q: params.get('q') || '' });
  }

  // Herkese açık profil: /api/profile/:username
  if (url.match(/^\/api\/profile\/([^/]+)$/) && req.method === 'GET') {
    const username = url.split('/')[3];
    return routes['GET /api/profile'](req, res, { username });
  }

  if (url === '/api/profile' && req.method === 'PATCH')
    return routes['PATCH /api/profile'](req, res, {});

  // Aktif izleyici ping/get
  if (url.startsWith('/api/viewers') && req.method === 'POST') {
    const body = await readBody(req);
    let data = {};
    try { data = JSON.parse(body); } catch {}
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'anon';
    pingViewer(data.slug, data.ep || 1, ip);
    return json(res, 200, { ok: true });
  }
  if (url.startsWith('/api/viewers/') && req.method === 'GET') {
    const slug = url.split('/api/viewers/')[1];
    return json(res, 200, { count: getViewerCount(slug) });
  }

  // Takipçi sistemi: /api/user/:username/follow[ers]
  if (url.match(/^\/api\/user\/([^/]+)\/follow$/) && req.method === 'POST') {
    const username = url.split('/')[3];
    return routes['POST /api/user/follow'](req, res, { username });
  }

  if (url.match(/^\/api\/user\/([^/]+)\/follow$/) && req.method === 'DELETE') {
    const username = url.split('/')[3];
    return routes['DELETE /api/user/follow'](req, res, { username });
  }

  if (url.match(/^\/api\/user\/([^/]+)\/followers$/) && req.method === 'GET') {
    const username = url.split('/')[3];
    return routes['GET /api/user/followers'](req, res, { username });
  }

  if (url.match(/^\/api\/user\/([^/]+)\/following$/) && req.method === 'GET') {
    const username = url.split('/')[3];
    return routes['GET /api/user/following'](req, res, { username });
  }

  if (url.match(/^\/api\/user\/([^/]+)\/comments$/) && req.method === 'GET') {
    const username = url.split('/')[3];
    return routes['GET /api/user/comments'](req, res, { username });
  }

  // Bildirimler: /api/notifications[/:id]
  if (url === '/api/notifications' && req.method === 'GET')
    return routes['GET /api/notifications'](req, res, {});

  if (url.match(/^\/api\/notifications\/([^/]+)$/) && req.method === 'PATCH') {
    const id = url.split('/')[3];
    return routes['PATCH /api/notifications'](req, res, { id });
  }

  if (url.match(/^\/api\/notifications\/([^/]+)$/) && req.method === 'DELETE') {
    const id = url.split('/')[3];
    return routes['DELETE /api/notifications'](req, res, { id });
  }

  // Kullanıcı profil URL'i: /u/:username  (SPA route)
  if (url.match(/^\/u\/([a-zA-Z0-9_]+)$/) && req.method === 'GET') {
    const html = getHtml(HTML_FILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.match(/^\/api\/room\/([A-Z0-9]{6})$/i) && req.method === 'GET')
    return routes['GET /api/room'](req, res, { code: url.split('/')[3].toUpperCase() });

  // ── Animecix import (SSE) ────────────────────────────────────────────
  if (url.startsWith('/api/import-animecix') && req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const qToken = params.get('token');
    const session = getSession(qToken || getToken(req));
    if (!session || session.role !== 'admin')
      return json(res, 403, { error: 'Yetki yok.' });

    const animeUrl = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
    if (!animeUrl || !animeUrl.includes('animecix.tv'))
      return json(res, 400, { error: 'Geçerli animecix.tv URL gerekli.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    });

    const send = (line) => res.write(`data: ${line}\n\n`);
    send('[*] Scraping başlatılıyor...');

    const { spawn } = require('child_process');
    const py = spawn('python', [require('path').join(__dirname, 'a.py'), animeUrl], {
      cwd: __dirname,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });

    py.stdout.setEncoding('utf-8');
    py.stderr.setEncoding('utf-8');
    py.stdout.on('data', d => d.split('\n').forEach(l => { if (l.trim()) send(l); }));
    py.stderr.on('data', d => d.split('\n').forEach(l => { if (l.trim()) send('[err] ' + l); }));
    py.on('close', code => {
      send(code === 0 ? '__DONE__' : `__ERROR__ (kod: ${code})`);
      res.end();
    });

    req.on('close', () => { try { py.kill(); } catch {} });
    return;
  }

  // Sabit route'lar
  const key = `${req.method} ${url}`;
  if (routes[key]) {
    try {
      return await routes[key](req, res, {});
    } catch (err) {
      console.error('[AniLand] Route hatası:', err.message);
      return json(res, 500, { error: 'Sunucu hatası.' });
    }
  }

  json(res, 404, { error: 'Sayfa bulunamadı.' });
});

// ─── WebSocket sunucusu ───────────────────────────────────────────────────────
if (WebSocketServer) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const token = urlParams.get('token');
    const session = getSession(token);

    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Geçersiz oturum. Lütfen giriş yapın.' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.username = session.username;
    ws.roomCode = null;

    console.log(`[Watch Together] Bağlandı: ${session.username}`);

    ws.on('message', (data) => {
      try { handleWsMessage(ws, session, data.toString()); }
      catch (err) { console.error('[Watch Together] Mesaj hatası:', err); }
    });

    ws.on('close', () => {
      console.log(`[Watch Together] Bağlantı kesildi: ${session.username}`);
      leaveRoom(ws, session);
    });

    ws.on('error', (err) => {
      console.error(`[Watch Together] WS hatası (${session.username}):`, err.message);
    });

    ws.send(JSON.stringify({ type: 'connected', username: session.username }));
  });

  console.log('[AniLand] ✅ Watch Together WebSocket aktif');
}

// ─── Başlat ───────────────────────────────────────────────────────────────────
async function syncAnimesFromCDN() {
  try {
    console.log('[AniLand] animes.json CDN\'den çekiliyor...');
    const res = await new Promise((resolve, reject) => {
      https.get('https://cdn.aniland.net/animes.json', r => resolve(r)).on('error', reject);
    });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    fs.writeFileSync(ANIMES_FILE, Buffer.concat(chunks), 'utf8');
    console.log('[AniLand] ✅ animes.json CDN\'den alındı.');
  } catch (e) {
    console.error('[AniLand] ❌ CDN sync hatası:', e.message);
  }
}

async function startServer() {
  await connectDB();
  await ensureAdminExists();
  await syncAnimesFromCDN();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ AniLand backend çalışıyor → Port: ${PORT}`);
    console.log(`🌐 CORS origin: ${ALLOWED_ORIGIN}\n`);
  });
}

startServer().catch(err => {
  console.error('[AniLand] Başlatma hatası:', err);
  process.exit(1);
});
