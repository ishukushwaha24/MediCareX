// MediCareX backend: Express + JSON file storage.
// Run: npm install && npm start   (then open http://localhost:3000)
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { simulate } = require("./sim");

const TICK_MS = (Number(process.env.TICK_SECONDS) || 300) * 1000; // auto-update every 5 minutes
const SIMULATE = process.env.SIMULATE !== "0";                    // set SIMULATE=0 to turn demo auto-updates off
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "482916"; // Doctor/Staff code, checked on the server
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const DATA_FILE = path.join(__dirname, "data.json");
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// ---------- storage ----------
let DB = {}; // { hospitalId: { data: {...}, version: n, updated: ts } }
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { DB = {}; }
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(DB), err => {
      if (!err) fs.rename(tmp, DATA_FILE, () => {});
    });
  }, 300);
}

// ---------- tokens (HMAC signed, no extra library) ----------
const b64 = s => Buffer.from(s).toString("base64url");
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const p = verify(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!p) return res.status(401).json({ error: "Login required" });
  req.user = p;
  next();
}
const canWrite = u => u.type === "doctor" || u.type === "staff";

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "30mb" })); // reports are stored as base64

// simple login rate limit (per IP): 10 tries / 5 minutes
const tries = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (tries.get(ip) || []).filter(t => now - t < 300000);
  arr.push(now);
  tries.set(ip, arr);
  return arr.length > 10;
}

app.post("/api/login", (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  const { name = "", mobile = "", gmail = "", type = "patient", code = "", guest = false } = req.body || {};
  if (guest) {
    return res.json({ token: sign({ type: "patient", name: "", mobile: "", exp: Date.now() + TOKEN_TTL_MS }), type: "patient" });
  }
  if (String(name).trim().length < 2) return res.status(400).json({ error: "name" });
  if (!/^[6-9][0-9]{9}$/.test(mobile)) return res.status(400).json({ error: "mobile" });
  if (!/^[a-z0-9](?:[a-z0-9.]{4,28})[a-z0-9]@gmail\.com$/i.test(gmail) || gmail.includes("..")) return res.status(400).json({ error: "gmail" });
  if (!["patient", "doctor", "staff"].includes(type)) return res.status(400).json({ error: "type" });
  if (type !== "patient") {
    const a = Buffer.from(String(code)), b = Buffer.from(ACCESS_CODE);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: "code" });
  }
  const token = sign({ type, name: String(name).trim(), mobile, gmail, exp: Date.now() + TOKEN_TTL_MS });
  res.json({ token, type });
});

app.get("/api/me", auth, (req, res) => res.json({ type: req.user.type, name: req.user.name, mobile: req.user.mobile }));

// ---------- live updates (Server-Sent Events) ----------
// Every logged-in browser keeps one open connection. When staff/doctor saves a change,
// the server pushes a tiny "something changed" message (no patient data) to everyone.
const clients = new Set();
app.get("/api/events", (req, res) => {
  const user = verify(String(req.query.t || "")); // EventSource cannot set headers, so token comes in the URL
  if (!user) return res.status(401).end();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");
  res.write("event: hello\ndata: {}\n\n");
  const c = { res, user };
  clients.add(c);
  req.on("close", () => clients.delete(c));
});
function broadcast(event, payload) {
  const msg = "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const c of clients) { try { c.res.write(msg); } catch (e) { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.res.write(": ping\n\n"); } catch (e) { clients.delete(c); } } }, 25000);

// All hospitals' data. Patients only get their own patient records (matched by mobile).
app.get("/api/db", auth, (req, res) => {
  const out = {}, versions = {};
  for (const id of Object.keys(DB)) {
    const d = JSON.parse(JSON.stringify(DB[id].data));
    if (!canWrite(req.user)) {
      d.patients = (d.patients || []).filter(p => req.user.mobile && p.mob === req.user.mobile);
    }
    out[id] = d;
    versions[id] = DB[id].version;
  }
  res.json({ db: out, versions, serverTime: Date.now(), nextTick: SIMULATE ? nextTickAt() : 0 });
});

// Any logged-in user (even a patient or guest) can create a hospital's starting demo data,
// but only if it does not exist yet. This lets the auto-updates run for every hospital that anyone opens.
app.post("/api/db/:hid/init", auth, (req, res) => {
  const id = String(req.params.hid);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) return res.status(400).json({ error: "bad hospital id" });
  if (DB[id]) return res.json({ ok: true, existing: true, version: DB[id].version });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.beds) || !Array.isArray(data.patients)) {
    return res.status(400).json({ error: "bad data" });
  }
  if (Object.keys(DB).length >= 400) return res.status(400).json({ error: "too many hospitals" });
  if (JSON.stringify(data).length > 5e6) return res.status(400).json({ error: "too large" });
  DB[id] = { data, version: 1, updated: Date.now() };
  saveSoon();
  res.json({ ok: true, existing: false, version: 1 });
});

// Staff/Doctor only: save one hospital's data
app.put("/api/db/:hid", auth, (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: "Read only account" });
  const id = String(req.params.hid);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) return res.status(400).json({ error: "bad hospital id" });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.beds) || !Array.isArray(data.patients)) {
    return res.status(400).json({ error: "bad data" });
  }
  const current = DB[id] ? DB[id].version : 0;
  // Stale-write protection: the browser says which version it was editing.
  // If someone else saved in between, refuse instead of silently overwriting their change.
  const base = req.body.base;
  if (typeof base === "number" && base !== current) {
    return res.status(409).json({ error: "conflict", version: current });
  }
  const version = current + 1;
  DB[id] = { data, version, updated: Date.now() };
  saveSoon();
  broadcast("update", { hid: id, version, by: req.user.name || "Staff" });
  res.json({ ok: true, version });
});

app.delete("/api/db/:hid", auth, (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: "Read only account" });
  const id = String(req.params.hid);
  delete DB[id];
  saveSoon();
  broadcast("update", { hid: id, version: 0, by: req.user.name || "Staff" });
  res.json({ ok: true });
});

// ---------- auto-update ticks (every 5 minutes, on the clock: :00, :05, :10 ...) ----------
const nextTickAt = () => Math.ceil((Date.now() + 1) / TICK_MS) * TICK_MS;
function runTick() {
  const now = Date.now();
  let n = 0;
  for (const id of Object.keys(DB)) {
    try {
      simulate(DB[id].data, now);
      DB[id].version += 1;
      DB[id].updated = now;
      n++;
    } catch (e) { console.error("tick failed for " + id + ":", e.message); }
  }
  if (n) { saveSoon(); broadcast("update", { hid: "*", version: 0, by: "", auto: true }); }
  console.log(new Date(now).toLocaleTimeString() + " auto-update: " + n + " hospital(s), " + clients.size + " browser(s) notified");
}
function scheduleTick() {
  setTimeout(() => { if (SIMULATE) runTick(); scheduleTick(); }, nextTickAt() - Date.now());
}
scheduleTick();
if (SIMULATE) console.log("Auto-update ON: demo data changes every " + TICK_MS / 1000 + " seconds (SIMULATE=0 to turn off)");

// frontend
app.use(express.static(path.join(__dirname, "public")));

//app.listen(PORT, () => console.log("MediCareX running on http://localhost:" + PORT));
app.listen(PORT, "0.0.0.0", () => {
    console.log(`MediCareX running on port ${PORT}`);
});
