// MediCareX demo simulator.
// Every tick it makes small, realistic changes to a hospital's (fictional) demo data:
// 2-4 bed status changes, new patient arrivals, and small changes to doctors, medicines, ambulances.
// All data stays fictional. Real hospital data would come from the hospital's own systems.

const FN = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Ishita", "Vivaan", "Anaya", "Arjun", "Saanvi", "Reyansh", "Myra", "Aditya", "Kiara", "Dev", "Tara", "Neel", "Riya", "Yash", "Zoya"];
const LN = ["Rao", "Mehta", "Kulkarni", "Bose", "Nair", "Chauhan", "Verma", "Iyer", "Sethi", "Ghosh", "Pillai", "Das", "Malik", "Joshi", "Bhat", "Kapoor"];
const DIS = ["Dengue fever", "Typhoid", "Pneumonia", "Fractured leg", "Hypertension", "Type 2 diabetes", "Appendicitis", "Asthma attack", "Gastroenteritis", "Migraine"];
const RXL = [["Paracetamol 500 mg", "1 tablet", "3 times a day"], ["Amoxicillin 500 mg", "1 capsule", "2 times a day"], ["Pantoprazole 40 mg", "1 tablet", "before breakfast"], ["ORS sachet", "1 sachet in water", "after each loose motion"], ["Atorvastatin 20 mg", "1 tablet", "at night"], ["Salbutamol inhaler", "2 puffs", "when breathless"], ["Ondansetron 4 mg", "1 tablet", "when nauseous"]];

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const pad = (n, l = 3) => String(n).padStart(l, "0");

const MAX_PATIENTS = 4000, MAX_LOG = 200, MAX_NOTES = 100, MAX_MOVES = 30;

function ensure(D) {
  D.patients = D.patients || [];
  D.beds = D.beds || [];
  D.docs = D.docs || [];
  D.meds = D.meds || [];
  D.amb = D.amb || [];
  D.notes = D.notes || [];
  D.log = D.log || [];
  D.upd = D.upd || {};
  if (!D.code) D.code = "HOS";
  if (!D.ids) {
    let maxN = 0;
    D.notes.forEach(n => { if (n.id > maxN) maxN = n.id; });
    D.ids = { p: D.patients.length + 1, n: maxN + 1 };
  }
}

function makePatient(D, status, age, sex, now) {
  const adm = status !== "Registered";
  const total = adm ? rnd(20, 600) * 100 : 0;
  const p = {
    id: D.code + "-P" + pad(D.ids.p++),
    name: pick(FN) + " " + pick(LN),
    age, sex, status, bed: null, hist: [],
    dis: adm ? pick(DIS) : "",
    mob: "",
    bill: { total, paid: adm ? Math.round(total * Math.random() * 0.8 / 100) * 100 : 0 },
    rx: adm ? [0, 1].map(() => { const m = pick(RXL); return { name: m[0], dose: m[1], freq: m[2], days: rnd(3, 10) }; }) : [],
    files: []
  };
  D.patients.push(p);
  return p;
}

function simulate(D, now) {
  ensure(D);
  const stats = { admit: 0, disch: 0, clean: 0, reg: 0, docs: 0, meds: 0, amb: 0 };
  const pmap = new Map(D.patients.map(p => [p.id, p]));
  const by = s => D.beds.filter(b => b.status === s);

  // ---- 1) beds: 2 to 4 changes ----
  const k = rnd(2, 4);
  for (let i = 0; i < k; i++) {
    const av = by("Available"), oc = by("Occupied"), cl = by("Cleaning");
    const roll = Math.random();
    let act = null;
    if (roll < 0.4 && av.length) act = "admit";
    else if (roll < 0.75 && oc.length) act = "discharge";
    else if (cl.length) act = "clean";
    else if (av.length) act = "admit";
    else if (oc.length) act = "discharge";
    if (!act) break;

    if (act === "admit") {
      const b = pick(av);
      const mat = b.ward === "Maternity";
      // waiting registered patient first, otherwise a new arrival
      let p = D.patients.find(x => x.status === "Registered" && (!mat || x.sex === "F"));
      if (p) {
        p.status = "Admitted";
        p.dis = p.dis || pick(DIS);
        if (!p.bill || !p.bill.total) { const t = rnd(20, 600) * 100; p.bill = { total: t, paid: Math.round(t * Math.random() * 0.8 / 100) * 100 }; }
        if (!p.rx || !p.rx.length) p.rx = [0, 1].map(() => { const m = pick(RXL); return { name: m[0], dose: m[1], freq: m[2], days: rnd(3, 10) }; });
      } else {
        p = makePatient(D, "Admitted", mat ? rnd(20, 38) : b.ward === "ICU" ? rnd(35, 88) : rnd(3, 85), mat ? "F" : pick(["M", "F"]), now);
      }
      p.bed = b.id; p.hist = p.hist || []; p.hist.push({ ts: now, ev: "Admitted", bed: b.id });
      b.status = "Occupied"; b.pid = p.id;
      pmap.set(p.id, p);
      stats.admit++;
    } else if (act === "discharge") {
      const b = pick(oc);
      const p = pmap.get(b.pid);
      if (p) { p.status = "Discharged"; p.hist = p.hist || []; p.hist.push({ ts: now, ev: "Discharged", bed: b.id }); p.bed = null; }
      b.status = "Cleaning"; b.pid = null;
      stats.disch++;
    } else {
      const b = pick(cl);
      b.status = "Available"; b.pid = null;
      stats.clean++;
    }
  }
  D.upd.beds = now;

  // ---- 2) new patient arrivals (registered at reception) ----
  const arrivals = rnd(2, 4);
  for (let i = 0; i < arrivals; i++) makePatient(D, "Registered", rnd(8, 75), pick(["M", "F"]), now);
  stats.reg = arrivals;
  if (D.patients.length > MAX_PATIENTS) {
    let extra = D.patients.length - MAX_PATIENTS;
    D.patients = D.patients.filter(p => { if (extra > 0 && p.status === "Discharged") { extra--; return false; } return true; });
  }

  // ---- 3) doctors: 1 or 2 status changes ----
  if (D.docs.length) {
    const n = rnd(1, 2);
    for (let i = 0; i < n; i++) {
      const d = pick(D.docs);
      const nx = pick(["Available", "Available", "Available", "In surgery", "On leave"]);
      if (d.status !== nx) { d.status = nx; stats.docs++; }
    }
    D.upd.docs = now;
  }

  // ---- 4) medicines: 3 to 5 stock changes ----
  if (D.meds.length) {
    const n = rnd(3, 5);
    for (let i = 0; i < n; i++) {
      const m = pick(D.meds);
      const before = m.qty;
      if (m.qty <= m.min && Math.random() < 0.5) {
        const add = Math.max(1, Math.round(m.min * rnd(2, 4)));
        m.qty += add;
        m.moves = m.moves || []; m.moves.unshift({ ts: now, kind: "Receipt", qty: add, note: "Auto restock (demo)" });
      } else if (m.qty > 0) {
        const use = Math.min(m.qty, Math.max(1, Math.round(m.qty * (0.01 + Math.random() * 0.05)) + rnd(0, 3)));
        m.qty -= use;
        m.moves = m.moves || []; m.moves.unshift({ ts: now, kind: "Dispense", qty: use, note: "Ward issue (demo)" });
      }
      if (m.moves && m.moves.length > MAX_MOVES) m.moves.length = MAX_MOVES;
      if (m.qty !== before) stats.meds++;
      if (before > m.min && m.qty <= m.min) {
        D.notes.unshift({ id: D.ids.n++, ts: now, type: "Stock", msg: m.name + ": " + (m.qty === 0 ? "zero stock" : "low stock") + ".", st: "New", ack: null });
      }
    }
    D.upd.meds = now;
  }

  // ---- 5) ambulances: 1 or 2 status changes ----
  if (D.amb.length) {
    const n = rnd(1, 2);
    for (let i = 0; i < n; i++) {
      const a = pick(D.amb);
      const nx = pick(["Available", "On Duty", "Available", "On Duty", "Maintenance"]);
      if (a.status !== nx) { a.status = nx; a.upd = now; stats.amb++; }
    }
    D.upd.amb = now;
  }

  // ---- 6) activity log entry ----
  D.log.unshift({ ts: now, actor: "System (demo simulator)", action: "Auto update", entity: stats.admit + " admitted, " + stats.disch + " discharged, " + stats.clean + " beds cleaned, " + stats.reg + " new registrations" });
  if (D.log.length > MAX_LOG) D.log.length = MAX_LOG;
  if (D.notes.length > MAX_NOTES) D.notes.length = MAX_NOTES;
  return stats;
}

module.exports = { simulate };
