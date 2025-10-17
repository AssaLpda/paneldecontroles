/************ Config ************/
const BONIF_PAIR_WINDOW_MIN = 30;  // ventana general de emparejamiento
const BONUS_SMALL_WINDOW_MIN = 2;  // ventana corta para "carga-bono" (misma cantidad que la bonif)
const BONUS_BASE_WINDOW_MIN  = 2;  // ventana para buscar carga base alrededor
const BONUS_PCT_MIN = 0.08;        // 8%
const BONUS_PCT_MAX = 0.35;        // 35%
const USE_DAY_MATCH_WHEN_NO_TIME = true;

/************ Estado ************/
let state = {
  roundPesos: false,
  cargas: [],           // {user, amountCents, date, time, raw, ts}
  bonifs: [],           // {user, amountCents, date, time, raw, ts}
  transf: [],           // {amountCents, nameCandidate, date, time, raw, ts, source:'telepago'|'galicia'}
  retiros: [],          // {source:'carga-descarga'|'transferencia-debito', who, amountCents, date, time, raw, ts}
  cargasEmparejadasPorBonif: new Set(), // idx de cargas excluidas por bonif
  cmpMonto: []          // [{amountCents, cntCargas, cntTransf, estado}]
};

/* ==== Galicia buffer / flags ==== */
let GALICIA_BUFFER = [];                 // [{date,name,amountStr,amountCents}]
let INCLUDE_GALICIA_IN_ANALYSIS = false; // incluir en el próximo "Analizar" sin pegar al textarea

/************ Utils ************/
const $ = (sel) => document.querySelector(sel);
const lines = (t) => (t||"").split(/\r?\n/);

const moneyFmt = (cents) => (cents/100).toLocaleString("es-AR", {style:"currency", currency:"ARS"});
const parseArsToCents = (txt) => {
  if (!txt) return null;
  const s = (""+txt).replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!s || s === "." || s === "-" || s === "-.") return null;
  const n = Math.round(parseFloat(s)*100);
  return isNaN(n) ? null : n;
};

const stripDiacritics = (s) => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const norm = (s) => stripDiacritics((s||"").toLowerCase()).replace(/[^a-z0-9]+/g,"").trim();
const normSp = (s) => stripDiacritics((s||"").toLowerCase()).replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();

const levenshtein = (a,b) => {
  a=a||""; b=b||"";
  const m=a.length,n=b.length; if(!m) return n; if(!n) return m;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const c=a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+c);
    }
  }
  return dp[m][n];
};
const similarity = (a,b) => {
  a=norm(a); b=norm(b);
  if(!a||!b) return 0;
  const d=levenshtein(a,b);
  const M=Math.max(a.length,b.length);
  return M? (1-d/M):0;
};

const extractTime = (l)=> (l.match(/\b([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/)||[])[0] || null;

// ---- Fecha tolerante (incluye “pegada” a la hora) ----
function extractDateDMYToISO(line){
  const m = (line||"").match(/\b([0-3]\d)\/([01]\d)\/(\d{4})\b/);
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}
function extractDateISOLoose(line){
  const m = (line||"").match(/(20\d{2}-[01]\d-[0-3]\d)/);
  return m ? m[1] : null;
}
function extractAnyDateToISO(line){
  return extractDateISOLoose(line) || extractDateDMYToISO(line);
}
function mkTimestamp(dateISO, timeHHMM){
  if (!dateISO || !timeHHMM) return null;
  const s = `${dateISO}T${timeHHMM}:00`;
  const t = Date.parse(s); // UTC, suficiente para diferencias
  return isNaN(t) ? null : t;
}
function diffMinutes(tsA, tsB){
  if (tsA==null || tsB==null) return Infinity;
  return Math.abs(tsA - tsB) / 60000;
}
const sameDay = (a,b)=> !!a && !!b && a===b;

// Montos en segmento
function findAmountCentsInSegment(seg){
  if (!seg) return null;
  const mArs = seg.match(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/);
  if (mArs) {
    const c = parseArsToCents(mArs[0]);
    if (c != null) return Math.abs(c);
  }
  const mInt = seg.match(/\b\d{3,}(?:,\d{2})?\b/);
  if (mInt) {
    const raw = mInt[0];
    if (/,/.test(raw)) {
      const c = parseArsToCents(raw);
      if (c != null) return Math.abs(c);
    } else {
      const n = parseInt(raw, 10);
      if (!isNaN(n)) return Math.abs(n * 100);
    }
  }
  return null;
}

// Detecta montos negativos (retiros)
function findNegativeAmountCents(line){
  if (!line) return null;
  const m1 = line.match(/-\s?\d{1,3}(?:\.\d{3})*,\d{2}\b/);
  if (m1) {
    const c = parseArsToCents(m1[0]);
    if (c != null) return { cents: Math.abs(c), token: m1[0] };
  }
  const m2 = line.match(/-\s?\d{3,}(?:,\d{2})?\b/);
  if (m2) {
    const raw = m2[0].replace(/\s+/g,"");
    if (/,/.test(raw)) {
      const c = parseArsToCents(raw);
      if (c != null) return { cents: Math.abs(c), token: m2[0] };
    } else {
      const n = parseInt(raw.replace("-", ""), 10);
      if (!isNaN(n)) return { cents: n*100, token: m2[0] };
    }
  }
  return null;
}

/* Helpers para buscadores por monto */
function extractAmountFromCargaLine(l){
  if (!l) return null;
  const mAll = [...l.matchAll(/\d{1,3}(?:\.\d{3})*,\d{2}\b/g)];
  if (mAll.length){
    const token = mAll[mAll.length-1][0];
    const c = parseArsToCents(token);
    if (c!=null) return Math.abs(c);
  }
  const mk = l.match(/(Carga|Bonificaci(?:o|ó)n|Descarga)\b/i);
  const seg = mk ? l.slice(mk.index + mk[0].length) : l;
  let c = findAmountCentsInSegment(seg);
  if (c==null) c = findAmountCentsInSegment(l);
  return c!=null ? Math.abs(c) : null;
}
function extractAmountFromTransfLine(l){
  if (!l) return null;
  const time = extractTime(l);
  let seg = l;
  const mDMY = l.match(/\b[0-3]\d\/[01]\d\/\d{4}\b/);
  const mISO = l.match(/(20\d{2}-[01]\d-[0-3]\d)/);
  if (mDMY) seg = l.slice(l.indexOf(mDMY[0]) + mDMY[0].length);
  else if (mISO) seg = l.slice(l.indexOf(mISO[0]) + mISO[0].length);
  if (time){
    const idx = seg.lastIndexOf(time);
    if (idx>-1) seg = seg.slice(0, idx);
  }
  let c = findAmountCentsInSegment(seg);
  if (c==null) c = findAmountCentsInSegment(l);
  return c!=null ? Math.abs(c) : null;
}

/************ Parsers ************/
function parseCargas(text, roundPesos=false){
  const out=[], bonifs=[], retiros=[];
  for (const raw of lines(text)){
    const l = (raw||"").trim(); if(!l) continue;

    const date = extractAnyDateToISO(l);
    const time = extractTime(l);
    const ts   = mkTimestamp(date, time);

    // Descarga → RETIRO (no cuenta como carga)
    if (/descarga/i.test(l)){
      const seg = l.split(/descarga/i)[1] || l;
      let cents = null;
      const neg = findNegativeAmountCents(seg);
      if (neg) cents = neg.cents;
      if (cents==null){
        const pos = findAmountCentsInSegment(seg) || findAmountCentsInSegment(l);
        if (pos != null) cents = pos;
      }
      // usuario justo antes de "Descarga" si existe
      let user = null;
      const mUD = l.match(/\b([a-z0-9_]{3,})\s+Descarga\b/i);
      if (mUD && /[a-z]/i.test(mUD[1])) user = mUD[1];
      else {
        const mUser = l.match(/\b([a-z0-9_]{4,})\b/i);
        if (mUser && /[a-z]/i.test(mUser[1])) user = mUser[1];
      }

      if (cents!=null){
        if (roundPesos) cents = Math.round(cents/100)*100;
        retiros.push({source:'carga-descarga', who:user, amountCents:cents, date, time, raw:l, ts});
        continue;
      }
    }

    const isBonif = /bonificaci(?:o|ó)n/i.test(l);

    // usuario:
    let user = null;
    if (isBonif){
      const mUB = l.match(/\b([a-z0-9_]{3,})\s+Bonificaci(?:o|ó)n\b/i);
      if (mUB && /[a-z]/i.test(mUB[1])) user = mUB[1];
      else {
        const mUser = l.match(/\b([a-z0-9_]{4,})\b/i);
        if (mUser && /[a-z]/i.test(mUser[1])) user = mUser[1];
      }
    } else {
      const mCarga = l.match(/\b([a-z0-9_]+)\s+Carga\b/i);
      if (mCarga && /[a-z]/i.test(mCarga[1])) user = mCarga[1];
      else {
        const mUser = l.match(/\b([a-z0-9_]{4,})\b/i);
        if (mUser && /[a-z]/i.test(mUser[1])) user = mUser[1];
      }
    }

    // monto
    let cents = null;
    if (isBonif){
      const seg = l.split(/bonificaci(?:o|ó)n/i)[1]||"";
      const m = seg.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}\b/);
      if (m) cents = parseArsToCents(m[0]);
    } else {
      const after = l.split(/Carga/i)[1];
      if (after){
        const m = after.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}\b/);
        if (m) cents = parseArsToCents(m[0]);
      }
      if (cents==null){
        const all=[...l.matchAll(/-?\d{1,3}(?:\.\d{3})*,\d{2}\b/g)];
        if (all.length) cents = parseArsToCents(all.pop()[0]);
      }
    }
    if (cents==null) continue;

    if (roundPesos) cents = Math.round(cents/100)*100;

    if (isBonif) bonifs.push({user, amountCents:Math.abs(cents), date, time, raw:l, ts});
    else out.push({user, amountCents:Math.abs(cents), date, time, raw:l, ts});
  }
  state.retiros.push(...retiros);
  return {cargas:out, bonifs};
}

function parseTransferencias(text, roundPesos=false){
  const arr = [];
  const ls = lines(text);
  for (const raw0 of ls){
    let raw = (raw0||"").trim();
    if (!raw) continue;

    // 🔶 detectar marcador manual para Galicia (#GALICIA) aunque venga en el textarea
    const isGaliciaMarked = /(^|\s)#GALICIA(\s|$)/i.test(raw);
    if (isGaliciaMarked){
      raw = raw.replace(/(^|\s)#GALICIA(\s|$)/ig, " ").replace(/\s+/g," ").trim(); // limpiamos el marcador para mostrar
    }

    const dateISO = extractAnyDateToISO(raw);
    const time = extractTime(raw);
    const ts   = mkTimestamp(dateISO, time);

    // ¿Retiros (débito) en extracto?
    const neg = findNegativeAmountCents(raw);
    if (neg){
      let nameCandidate = null;
      const line = raw.replace(/\s+/g," ").trim();
      const idx = line.indexOf(neg.token.replace(/\s+/g," "));
      let after = idx>-1 ? line.slice(idx + neg.token.length) : line;
      if (time){
        const it = after.lastIndexOf(time);
        if (it>-1) after = after.slice(0,it);
      }
      nameCandidate = after.replace(/\s+/g," ").replace(/[|;]+/g," ").trim() || null;
      let cents = neg.cents;
      if (roundPesos) cents = Math.round(cents/100)*100;
      state.retiros.push({
        source:'transferencia-debito',
        who: nameCandidate,
        amountCents: cents,
        date: dateISO || null,
        time: time || null,
        raw,
        ts
      });
      continue;
    }

    // Segmento: después de fecha y antes de hora
    let seg = raw;
    const mDMY = raw.match(/\b[0-3]\d\/[01]\d\/\d{4}\b/);
    const mISO = raw.match(/(20\d{2}-[01]\d-[0-3]\d)/);
    if (mDMY) seg = raw.slice(raw.indexOf(mDMY[0]) + mDMY[0].length);
    else if (mISO) seg = raw.slice(raw.indexOf(mISO[0]) + mISO[0].length);
    if (time) {
      const idxTime = seg.lastIndexOf(time);
      if (idxTime > -1) seg = seg.slice(0, idxTime);
    }

    // Monto positivo
    let cents = findAmountCentsInSegment(seg);
    if (cents == null || cents === 0) {
      const fallback = findAmountCentsInSegment(raw);
      if (fallback == null || fallback === 0) continue;
      cents = fallback;
    }

    // Nombre probable
    let nameCandidate = null;
    const line = raw.replace(/\s+/g, " ").trim();
    const tokenArs = (raw.match(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/)||[])[0];
    let token = tokenArs;
    if (!token) {
      const asInt = String(Math.round(cents/100));
      const mTok = raw.match(new RegExp(`\\b${asInt}\\b`));
      token = mTok ? mTok[0] : null;
    }
    if (token) {
      const idxA = line.indexOf(token);
      let mid = idxA > -1 ? line.slice(idxA + token.length) : seg;
      if (time) {
        const iT = mid.lastIndexOf(time);
        if (iT > -1) mid = mid.slice(0, iT);
      }
      const n = mid.replace(/\s+/g, " ").replace(/[|;]+/g," ").trim();
      nameCandidate = n || null;
    }

    if (roundPesos) cents = Math.round(cents/100)*100;

    arr.push({
      amountCents: Math.abs(cents),
      nameCandidate,
      date: dateISO || null,
      time: time || null,
      raw,
      ts,
      // 🔶 si tiene marcador, lo tratamos como Galicia; si no, Telepago/RECA
      source: isGaliciaMarked ? 'galicia' : 'telepago'
    });
  }
  return arr;
}

/************ Emparejar bonif ↔ carga (1:1) ************/
function matchBonif(cargas, bonifs){
  const paired = new Set();

  // index por usuario para buscar base cerca
  const byUser = new Map();
  cargas.forEach((c, i)=>{
    const u = c.user || "__";
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push({...c, _i:i});
  });
  for (const arr of byUser.values()) arr.sort((a,b)=> (a.ts??0)-(b.ts??0));

  // 1) Detectar CARGA-BONO (mismo monto que bonif) con ventana corta
  for (const b of bonifs){
    const u = b.user || "__";
    const arr = byUser.get(u) || [];
    const sameAmount = arr.filter(c => c.amountCents === b.amountCents && !paired.has(c._i));
    let chosen = null;
    for (const c of sameAmount){
      if (b.ts!=null && c.ts!=null){
        if (diffMinutes(b.ts, c.ts) <= BONUS_SMALL_WINDOW_MIN){
          let hasBase = false;
          for (const base of arr){
            if (base._i === c._i) continue;
            if (base.amountCents === b.amountCents) continue; // no la pequeña
            const r = b.amountCents / base.amountCents; // % bonif aprox
            if (r >= BONUS_PCT_MIN && r <= BONUS_PCT_MAX){
              const dt = (base.ts!=null && b.ts!=null) ? diffMinutes(base.ts, b.ts) : Infinity;
              if (dt <= BONUS_BASE_WINDOW_MIN) { hasBase = true; break; }
            }
          }
          chosen = c; break;
        }
      } else if (USE_DAY_MATCH_WHEN_NO_TIME){
        if (sameDay(b.date, c.date)){ chosen = c; break; }
      }
    }
    if (chosen){
      paired.add(chosen._i);
      continue;
    }
  }

  // 2) Emparejamiento general (mismo usuario + monto), ventana estándar
  const ord = cargas.map((c,i)=>({...c,_i:i}))
                   .sort((a,b)=> (a.date||"").localeCompare(b.date||"") || (a.time||"").localeCompare(b.time||""));
  for (const b of bonifs){
    const cand = ord
      .filter(c=>{
        const sameUserAndAmount = c.user && b.user && norm(c.user)===norm(b.user) && c.amountCents===b.amountCents;
        return sameUserAndAmount && !paired.has(c._i);
      })
      .filter(c=>{
        if (b.time && c.time){
          const dt = diffMinutes(b.ts, c.ts);
          const sameDateOrUnknown = (!b.date || !c.date) ? true : (b.date===c.date);
          return sameDateOrUnknown && dt<=BONIF_PAIR_WINDOW_MIN;
        }
        if (USE_DAY_MATCH_WHEN_NO_TIME){
          return (!b.date || !c.date) ? true : (b.date===c.date);
        }
        return false;
      });
    if (cand.length) paired.add(cand[0]._i);
  }
  return paired;
}

/************ Agregados ************/
const multisetByAmount = (list)=>{
  const m = new Map();
  for (const it of list) m.set(it.amountCents, (m.get(it.amountCents)||0)+1);
  return m;
};
function buildCmpMonto(cargasConsideradas, transf){
  const mc = multisetByAmount(cargasConsideradas);
  const mt = multisetByAmount(transf);
  const am = new Set([...mc.keys(), ...mt.keys()]);
  const rows=[];
  for (const a of am){
    const c=mc.get(a)||0, t=mt.get(a)||0;
    let estado = "green"; if (c>t) estado="red"; else if (c<t) estado="yellow";
    rows.push({amountCents:a, cntCargas:c, cntTransf:t, estado});
  }
  rows.sort((x,y)=>x.amountCents-y.amountCents);
  return rows;
}

/************ Helper: cargas consideradas (excluye cargas-bono) ************/
function getCargasConsideradas(){
  return state.cargas.filter((_, i) => !state.cargasEmparejadasPorBonif.has(i));
}

/************ Render ************/
function renderResumen(){
  const cargasConsideradas = getCargasConsideradas();

  const totalC = cargasConsideradas.reduce((s,c)=>s+c.amountCents,0);
  const totalB = state.bonifs.reduce((s,b)=>s+(b.amountCents*2),0);

  // separar Telepago/RECA vs Galicia
  const tele = state.transf.filter(t=>t.source!=="galicia");
  const gali = state.transf.filter(t=>t.source==="galicia");

  const totalT_Tele = tele.reduce((s,t)=>s+t.amountCents,0);
  const totalT_Gal  = gali.reduce((s,t)=>s+t.amountCents,0);
  const totalT = totalT_Tele + totalT_Gal;

  const totalR = state.retiros.reduce((s,r)=>s+r.amountCents,0);
  const dif = (totalC - totalB) - totalT;
  const difClass = dif >= 0 ? 'ok' : 'bad';
  const difLabel = dif > 0 ? 'Ganancia' : (dif < 0 ? 'Pérdida' : 'Balanceado');

  const ul = $("#summaryList");
  ul.innerHTML = `
    <li>💳 Cargas: <strong>${moneyFmt(totalC)}</strong> <span class="tiny">(${cargasConsideradas.length})</span></li>
    <li class="bonif">🎁 Ajuste Bonif (x2): −${moneyFmt(totalB)} <span class="tiny">(${state.bonifs.length})</span></li>
    <li>🏦 Transferencias (Telepago/RECA): <strong>${moneyFmt(totalT_Tele)}</strong> <span class="tiny">(${tele.length})</span></li>
    <li>🏦 Transferencias <strong style="color:#ffa726">Galicia</strong>: <strong style="color:#ffa726">${moneyFmt(totalT_Gal)}</strong> <span class="tiny" style="color:#ffa726">(${gali.length})</span></li>
    <li>🏦 Transferencias Totales: <strong>${moneyFmt(totalT)}</strong> <span class="tiny">(${state.transf.length})</span></li>
    <li>💸 Retiros: <strong class="bad">−${moneyFmt(totalR)}</strong> <span class="tiny">(${state.retiros.length})</span> — <a href="#" id="openRetirosLink">ver detalle</a></li>
    <li>${difLabel}: <strong class="${difClass}">${moneyFmt(dif)}</strong></li>
  `;

  const link = $("#openRetirosLink");
  if (link) link.addEventListener("click", (e)=>{ e.preventDefault(); openRetirosModal(); });
}

function fillTable(bodyId, mapObj){
  const tbody = $(bodyId);
  if (!tbody) return;
  if (!mapObj || mapObj.size===0){
    tbody.innerHTML = `<tr><td colspan="2" class="tiny">Sin datos</td></tr>`;
    return;
  }
  const rows = [...mapObj.entries()].sort((a,b)=>a[0]-b[0]).map(([cents, cnt])=>`
    <tr data-amount="${cents}">
      <td>${moneyFmt(cents)}</td>
      <td>${cnt}</td>
    </tr>
  `).join("");
  tbody.innerHTML = rows;
}

function renderBonifs(){
  const tb = $("#bonifBody");
  if (!tb) return;
  if (!state.bonifs.length){
    tb.innerHTML = `<tr><td colspan="2" class="tiny">No se detectaron bonificaciones.</td></tr>`;
    const note = $("#bonifNote"); if (note) note.textContent = "";
    return;
  }
  tb.innerHTML = state.bonifs.map(b=>`
    <tr>
      <td class="bonif">${moneyFmt(b.amountCents)}</td>
      <td><span class="tiny">${b.raw}</span></td>
    </tr>
  `).join("");
  const note = $("#bonifNote");
  if (note) note.textContent = "Estas bonificaciones no se comparan como cargas y descuentan x2 del total.";
}

function renderFSCC(cargasConsideradas){
  const mC = multisetByAmount(cargasConsideradas);
  const mT = multisetByAmount(state.transf);

  const falt = new Map(), sobr = new Map();
  const am = new Set([...mC.keys(), ...mT.keys()]);
  for (const a of am){
    const c=mC.get(a)||0, t=mT.get(a)||0;
    if (c>t) falt.set(a, c-t);
    if (t>c) sobr.set(a, t-c);
  }
  fillTable("#faltantesBody", falt);
  fillTable("#sobrantesBody", sobr);

  const tbC = $("#coincidenBody");
  if (tbC){
    if (am.size===0){
      tbC.innerHTML = `<tr><td colspan="3" class="tiny">Sin datos</td></tr>`;
    } else {
      const rows = [...am].sort((a,b)=>a-b).map(a=>{
        const c=mC.get(a)||0, t=mT.get(a)||0;
        if (!c && !t) return "";
        return `<tr data-amount="${a}"><td>${moneyFmt(a)}</td><td>${c}</td><td>${t}</td></tr>`;
      }).join("");
      tbC.innerHTML = rows;
    }
  }

  const fN = $("#faltantesNote"); if (fN) fN.textContent = "Cargas que no tienen transferencia equivalente por monto (y cantidad).";
  const sN = $("#sobrantesNote"); if (sN) sN.textContent = "Transferencias que no tienen carga equivalente por monto (y cantidad).";

  ["faltantesBody","sobrantesBody","coincidenBody"].forEach(id=>{
    const cont = document.getElementById(id);
    if (!cont) return;
    cont.addEventListener("click",(ev)=>{
      const tr = ev.target.closest("tr[data-amount]");
      if(!tr) return;
      openDetalleMonto(parseInt(tr.dataset.amount,10));
    });
  });
}

function renderCmpMonto(){
  const tb = $("#cmpMontoBody");
  if (!tb) return;
  if (!state.cmpMonto.length){
    tb.innerHTML = `<tr><td colspan="4" class="tiny">Sin datos</td></tr>`;
    return;
  }
  tb.innerHTML = state.cmpMonto.map(r=>{
    const label = r.estado==='red' ? 'Cargas > Transf' : (r.estado==='yellow' ? 'Cargas < Transf' : 'Iguales');
    const chip = r.estado==='red' ? 'stateChip stateRed' : (r.estado==='yellow' ? 'stateChip stateYellow' : 'stateChip stateGreen');
    return `
      <tr data-amount="${r.amountCents}">
        <td>${moneyFmt(r.amountCents)}</td>
        <td>${r.cntCargas}</td>
        <td>${r.cntTransf}</td>
        <td><span class="${chip}">${label}</span></td>
      </tr>
    `;
  }).join("");

  tb.addEventListener("click",(ev)=>{
    const tr = ev.target.closest("tr[data-amount]");
    if(!tr) return;
    openDetalleMonto(parseInt(tr.dataset.amount,10));
  });
}

/************ Modal detalle por monto ************/
function openDetalleMonto(amountCents){
  const backdrop = $("#modalBackdrop"), titleEl=$("#modalTitle"), bodyEl=$("#modalBody");
  if (!backdrop || !titleEl || !bodyEl) return;

  const cargasConsideradas = getCargasConsideradas();
  const cSel = cargasConsideradas.filter(c=> c.amountCents===amountCents);
  const tSel = state.transf.filter(t=> t.amountCents===amountCents);

  const cRows = cSel.length ? cSel.map(c=>`
    <tr><td>${c.user||'(sin usuario)'}</td><td>${c.date||''} ${c.time||''}</td><td>${moneyFmt(c.amountCents)}</td><td><span class="tiny">${c.raw}</span></td></tr>
  `).join("") : `<tr><td colspan="4" class="tiny">Sin cargas en este monto.</td></tr>`;

  const tRows = tSel.length ? tSel.map(t=>`
    <tr><td>${t.nameCandidate||'(sin nombre)'}</td><td>${t.date||''} ${t.time||''}</td><td>${moneyFmt(t.amountCents)}</td><td>${t.source==='galicia' ? '<span class="tiny" style="color:#ffa726">Galicia</span>' : '<span class="tiny">Telepago/RECA</span>'} — <span class="tiny">${t.raw}</span></td></tr>
  `).join("") : `<tr><td colspan="4" class="tiny">Sin transferencias en este monto.</td></tr>`;

  titleEl.textContent = `Detalle — ${moneyFmt(amountCents)}`;
  bodyEl.innerHTML = `
    <div class="card" style="background:var(--panel)">
      <h3 style="margin-top:0">Cargas (${cSel.length})</h3>
      <table>
        <thead><tr><th>Usuario</th><th>Fecha/Hora</th><th>Monto</th><th>Fuente</th></tr></thead>
        <tbody>${cRows}</tbody>
      </table>
    </div>
    <div class="card" style="background:var(--panel); margin-top:12px;">
      <h3 style="margin-top:0">Transferencias (${tSel.length})</h3>
      <table>
        <thead><tr><th>Titular</th><th>Fecha/Hora</th><th>Monto</th><th>Origen / Fuente</th></tr></thead>
        <tbody>${tRows}</tbody>
      </table>
    </div>
  `;
  backdrop.classList.remove("hidden");
}

/************ Modal Retiros ************/
function openRetirosModal(){
  const backdrop = $("#modalBackdrop"), titleEl=$("#modalTitle"), bodyEl=$("#modalBody");
  if (!backdrop || !titleEl || !bodyEl) return;

  const r = state.retiros.slice().sort((a,b)=>(a.ts??0)-(b.ts??0));
  const total = r.reduce((s,x)=>s+x.amountCents,0);
  const rows = r.length ? r.map(x=>`
    <tr>
      <td>${x.who || '(sin nombre/usuario)'}</td>
      <td>${x.source==='carga-descarga'?'Descarga (Cargas)': x.source==='transferencia-debito' ? 'Débito (Billetera)' : x.source||'-'}</td>
      <td>${x.date||''} ${x.time||''}</td>
      <td>- ${moneyFmt(x.amountCents)}</td>
      <td><span class="tiny">${x.raw}</span></td>
    </tr>
  `).join("") : `<tr><td colspan="5" class="tiny">No se detectaron retiros.</td></tr>`;

  titleEl.textContent = `Retiros — Total: -${moneyFmt(total)} (${r.length})`;
  bodyEl.innerHTML = `
    <div class="card" style="background:var(--panel)">
      <table>
        <thead><tr><th>Persona/Usuario</th><th>Origen</th><th>Fecha/Hora</th><th>Monto</th><th>Fuente</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  backdrop.classList.remove("hidden");
}

/* =========================
   BÚSQUEDA AVANZADA POR PERSONA
   ========================= */

// Limpia username: quita prefijos tipo A1/X7/Z9 al inicio, dígitos y guiones/underscores
function cleanUsername(u){
  if (!u) return "";
  let s = stripDiacritics(u).toLowerCase();
  s = s.replace(/[^a-z0-9]+/g,"");
  s = s.replace(/^([a-z]\d+)+/i,"");
  s = s.replace(/\d+/g,"");
  return s;
}
function splitRealName(name){
  const stop = new Set(["de","del","la","las","los","y"]);
  const raw = normSp(name).split(" ").filter(Boolean);
  const toks = raw.filter(t => !stop.has(t));
  const first = toks[0] || "";
  const last  = toks.length>1 ? toks[toks.length-1] : "";
  const initials = first ? first[0] : "";
  return { tokens:toks, first, last, initials, fullNoSpace: toks.join("") };
}
function scoreUserVsName(user, name){
  const u = cleanUsername(user);
  const {first, last, initials, fullNoSpace} = splitRealName(name);

  if (!u || (!first && !last)) return 0;

  let sFull = similarity(u, fullNoSpace);
  let sLast = last ? similarity(u, last) : 0;
  let sFirst= first? similarity(u, first): 0;

  let sInitLast = 0;
  if (last){
    const patt = initials + last;
    sInitLast = similarity(u, patt);
    if (u.startsWith(initials + last.slice(0, Math.max(3, Math.min(5,last.length))))) {
      sInitLast += 0.15;
    }
  }

  let sSub = 0;
  const nameAll = first + last;
  if (u.length>=4 && (nameAll.includes(u) || u.includes(last.slice(0,4)) || (first && u.includes(first.slice(0,4))))) {
    sSub = 0.1;
  }

  let sPref = 0;
  if (first && u.startsWith(first.slice(0,4))) sPref += 0.05;
  if (last  && u.startsWith(last.slice(0,4)))  sPref += 0.05;

  let s = Math.max(sFull, sLast, sFirst, sInitLast) + sSub + sPref;
  if (s > 1) s = 1;
  return s;
}
function summarize(list, kind){
  const sum = list.reduce((s,x)=>s+x.amountCents,0);
  return { count: list.length, totalCents: sum, label: `${kind}: ${list.length} — ${moneyFmt(sum)}` };
}
function advPersonSearch(queryRaw){
  const q = (queryRaw||"").trim();
  if (!q) return { pairs:[], usersFound:[], namesFound:[], resumenUsers:null, resumenNames:null };

  const cargasConsideradas = getCargasConsideradas();

  const allUsers = Array.from(new Set(cargasConsideradas.map(c=>c.user).filter(Boolean)));
  const allNames = Array.from(new Set(state.transf.map(t=>t.nameCandidate).filter(Boolean)));

  const userRanks = allUsers.map(u=>{
    const s1 = similarity(q, u);
    const s2 = similarity(q, cleanUsername(u));
    return {u, score: Math.max(s1, s2)};
  }).filter(x=> x.score >= 0.35).sort((a,b)=> b.score - a.score);

  const nameRanks = allNames.map(n=>{
    const {fullNoSpace} = splitRealName(n);
    const s1 = similarity(q, n);
    const s2 = similarity(q, fullNoSpace);
    const s3 = similarity(normSp(q), normSp(n));
    return {n, score: Math.max(s1,s2,s3)};
  }).filter(x=> x.score >= 0.35).sort((a,b)=> b.score - a.score);

  const usersFound = userRanks.map(x=>x.u);
  const namesFound = nameRanks.map(x=>x.n);

  const PAIR_MIN = 0.62;
  const PAIR_FALLBACK = 0.52;

  const pairs = [];
  const considerUsers = usersFound.length ? usersFound : allUsers;
  const considerNames = namesFound.length ? namesFound : allNames;

  for (const u of considerUsers){
    let best = [];
    for (const n of considerNames){
      const s = scoreUserVsName(u,n);
      if (s >= PAIR_MIN) best.push({user:u, name:n, score:s});
    }
    if (!best.length){
      for (const n of considerNames){
        const s = scoreUserVsName(u,n);
        if (s >= PAIR_FALLBACK) best.push({user:u, name:n, score:s});
      }
    }
    best.sort((a,b)=> b.score - a.score);
    pairs.push(...best.slice(0,3));
  }
  const seen = new Set();
  const pairsUnique = [];
  for (const p of pairs){
    const k = `${p.user}||${p.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairsUnique.push(p);
  }
  pairsUnique.sort((a,b)=> b.score - a.score);

  const selUsers = usersFound.length ? usersFound : [];
  const selNames = namesFound.length ? namesFound : [];

  const cargasSel = selUsers.length ? getCargasConsideradas().filter(c=> selUsers.includes(c.user)) : [];
  const transfSel = selNames.length ? state.transf.filter(t=> selNames.includes(t.nameCandidate)) : [];

  const resumenUsers = selUsers.length ? summarize(cargasSel, "Cargas") : null;
  const resumenNames = selNames.length ? summarize(transfSel, "Transferencias") : null;

  return { pairs: pairsUnique, usersFound: selUsers, namesFound: selNames, resumenUsers, resumenNames, cargasSel, transfSel };
}
function renderAdvPersonResults(R){
  const cont = $("#advResults");
  if (!cont) return;

  const fmtUserList = R.usersFound?.length
    ? `<span class="tiny">Usuarios: ${R.usersFound.join(", ")}</span>`
    : `<span class="tiny">Usuarios: (sin coincidencias claras)</span>`;
  const fmtNameList = R.namesFound?.length
    ? `<span class="tiny">Titulares: ${R.namesFound.join(", ")}</span>`
    : `<span class="tiny">Titulares: (sin coincidencias claras)</span>`;

  const rowsPairs = (R.pairs && R.pairs.length)
    ? R.pairs.slice(0,50).map(p=>{
        const cargasUser = getCargasConsideradas().filter(c=> c.user===p.user);
        const transfName = state.transf.filter(t=> t.nameCandidate===p.name);
        const su = summarize(cargasUser, "Cargas");
        const st = summarize(transfName, "Transf");
        return `<tr data-user="${p.user}" data-name="${p.name}">
          <td><code>${p.user}</code></td>
          <td>${p.name}</td>
          <td>${(p.score*100|0)}%</td>
          <td>${su.count} / ${moneyFmt(su.totalCents)}</td>
          <td>${st.count} / ${moneyFmt(st.totalCents)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="tiny">Sin emparejamientos probables. Mostramos coincidencias sueltas debajo.</td></tr>`;

  const cargasRows = (R.cargasSel && R.cargasSel.length)
    ? R.cargasSel.map(c=>`<tr><td>${c.user||"(sin usuario)"}</td><td>${c.date||""} ${c.time||""}</td><td>${moneyFmt(c.amountCents)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="tiny">Sin cargas seleccionadas.</td></tr>`;
  const transfRows = (R.transfSel && R.transfSel.length)
    ? R.transfSel.map(t=>`<tr><td>${t.nameCandidate||"(sin nombre)"}</td><td>${t.date||""} ${t.time||""}</td><td>${moneyFmt(t.amountCents)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="tiny">Sin transferencias seleccionadas.</td></tr>`;

  const statsUsers = R.resumenUsers ? `<div class="tiny">${R.resumenUsers.label}</div>` : "";
  const statsNames = R.resumenNames ? `<div class="tiny">${R.resumenNames.label}</div>` : "";

  cont.innerHTML = `
    <div class="card" style="background:var(--panel); margin-top:6px;">
      <h3 style="margin:0 0 6px 0;">Emparejamientos probables (usuario ↔ titular)</h3>
      <div class="tiny" style="margin-bottom:8px">${fmtUserList}<br/>${fmtNameList}</div>
      <table>
        <thead><tr><th>Usuario</th><th>Titular</th><th>Score</th><th>Cargas (# / $)</th><th>Transf (# / $)</th></tr></thead>
        <tbody id="advPairsBody">${rowsPairs}</tbody>
      </table>
      <div class="note">Tip: el score considera <em>inicial+apellido</em>, prefijos y similitud global (e.g. <code>dpena</code> ↔ <code>Diego Pena</code>).</div>
    </div>

    <div class="cards" style="margin-top:10px;">
      <div class="card">
        <h3 style="margin-top:0">Cargas encontradas</h3>
        ${statsUsers}
        <table>
          <thead><tr><th>Usuario</th><th>Fecha/Hora</th><th>Monto</th></tr></thead>
          <tbody>${cargasRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Transferencias encontradas</h3>
        ${statsNames}
        <table>
          <thead><tr><th>Titular</th><th>Fecha/Hora</th><th>Monto</th></tr></thead>
          <tbody>${transfRows}</tbody>
        </table>
      </div>
    </div>
  `;

  const tb = $("#advPairsBody");
  if (tb){
    tb.addEventListener("click",(ev)=>{
      const tr = ev.target.closest("tr[data-user][data-name]");
      if (!tr) return;
      const u = tr.dataset.user;
      const n = tr.dataset.name;

      const cargasUser = getCargasConsideradas().filter(c=> c.user===u);
      const transfName = state.transf.filter(t=> t.nameCandidate===n);

      const totalU = cargasUser.reduce((s,x)=>s+x.amountCents,0);
      const totalN = transfName.reduce((s,x)=>s+x.amountCents,0);

      const cRows = cargasUser.length ? cargasUser.map(c=>
        `<tr><td>${c.date||""} ${c.time||""}</td><td>${moneyFmt(c.amountCents)}</td><td><span class="tiny">${c.raw}</span></td></tr>`
      ).join("") : `<tr><td colspan="3" class="tiny">Sin cargas.</td></tr>`;

      const tRows = transfName.length ? transfName.map(t=>
        `<tr><td>${t.date||""} ${t.time||""}</td><td>${moneyFmt(t.amountCents)}</td><td><span class="tiny">${t.raw}</span></td></tr>`
      ).join("") : `<tr><td colspan="3" class="tiny">Sin transferencias.</td></tr>`;

      const backdrop = $("#modalBackdrop"), titleEl=$("#modalTitle"), bodyEl=$("#modalBody");
      if (!backdrop || !titleEl || !bodyEl) return;

      titleEl.textContent = `Detalle persona — ${u} ↔ ${n}`;
      bodyEl.innerHTML = `
        <div class="card" style="background:var(--panel)">
          <h3 style="margin-top:0">Cargas de ${u} — Total ${moneyFmt(totalU)}</h3>
          <table>
            <thead><tr><th>Fecha/Hora</th><th>Monto</th><th>Fuente</th></tr></thead>
            <tbody>${cRows}</tbody>
          </table>
        </div>
        <div class="card" style="background:var(--panel); margin-top:12px;">
          <h3 style="margin-top:0">Transferencias de ${n} — Total ${moneyFmt(totalN)}</h3>
          <table>
            <thead><tr><th>Fecha/Hora</th><th>Monto</th><th>Fuente</th></tr></thead>
            <tbody>${tRows}</tbody>
          </table>
        </div>
      `;
      backdrop.classList.remove("hidden");
    });
  }
}

/************ Export CSV ************/
function exportCSV(){
  const cargasConsideradas = getCargasConsideradas();
  const mC = multisetByAmount(cargasConsideradas);
  const mT = multisetByAmount(state.transf);

  const sep = ";";
  let csv = "";

  const totalC = cargasConsideradas.reduce((s,c)=>s+c.amountCents,0);
  const totalB = state.bonifs.reduce((s,b)=>s+(b.amountCents*2),0);
  const tele = state.transf.filter(t=>t.source!=="galicia");
  const gali = state.transf.filter(t=>t.source==="galicia");
  const totalT_Tele = tele.reduce((s,t)=>s+t.amountCents,0);
  const totalT_Gal  = gali.reduce((s,t)=>s+t.amountCents,0);
  const totalT = totalT_Tele + totalT_Gal;
  const totalR = state.retiros.reduce((s,r)=>s+r.amountCents,0);
  const dif = (totalC-totalB)-totalT;

  csv += `Resumen${sep}${sep}\n`;
  csv += `Cargas${sep}${(totalC/100).toFixed(2)}\n`;
  csv += `Bonif_x2${sep}${(totalB/100).toFixed(2)}\n`;
  csv += `Transf_Telepago_RECA${sep}${(totalT_Tele/100).toFixed(2)}\n`;
  csv += `Transf_Galicia${sep}${(totalT_Gal/100).toFixed(2)}\n`;
  csv += `Transf_Totales${sep}${(totalT/100).toFixed(2)}\n`;
  csv += `Retiros${sep}-${(totalR/100).toFixed(2)}\n`;
  csv += `Diferencia(C-B)-T${sep}${(dif/100).toFixed(2)}\n\n`;

  csv += `Comparacion_por_monto${sep}${sep}${sep}\n`;
  csv += `Monto${sep}#Cargas${sep}#Transf${sep}Estado\n`;
  for (const r of state.cmpMonto){
    const label = r.estado==='red'?'Cargas>Transf':(r.estado==='yellow'?'Cargas<Transf':'Iguales');
    csv += `${(r.amountCents/100).toFixed(2)}${sep}${r.cntCargas}${sep}${r.cntTransf}${sep}${label}\n`;
  }
  csv += `\n`;

  csv += `Faltantes${sep}Veces\n`;
  for (const [a,c] of [...mC.entries()].sort((x,y)=>x[0]-y[0])){
    const t=mT.get(a)||0; if (c>t) csv += `${(a/100).toFixed(2)}${sep}${c-t}\n`;
  }
  csv += `\nSobrantes${sep}Veces\n`;
  for (const [a,t] of [...mT.entries()].sort((x,y)=>x[0]-y[0])){
    const c=mC.get(a)||0; if (t>c) csv += `${(a/100).toFixed(2)}${sep}${t-c}\n`;
  }
  csv += `\nCoincidencias${sep}Veces\n`;
  for (const a of new Set([...mC.keys(),...mT.keys()])){
    const c=mC.get(a)||0, t=mT.get(a)||0; const v=Math.min(c,t);
    if (v>0) csv += `${(a/100).toFixed(2)}${sep}${v}\n`;
  }

  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download=`reporte_${Date.now()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/************ Buscadores por monto (paneles) ************/
function updateFilterList(textareaId, filterId, listId, countId){
  const txt = $(textareaId).value || "";
  const qRaw = $(filterId).value.trim();

  let qCents = parseArsToCents(qRaw);
  if (qCents!=null) qCents = Math.abs(qCents);
  const useRound = $("#roundPesos").checked;
  if (useRound && qCents!=null) qCents = Math.round(qCents/100)*100;

  const isCargas = textareaId === "#cargasInput";

  let items = [];
  if (qRaw && qCents!=null){
    items = lines(txt).filter(l=>{
      if (!l || !l.trim()) return false;
      const cents = isCargas ? extractAmountFromCargaLine(l) : extractAmountFromTransfLine(l);
      if (cents==null) return false;
      const cmp = useRound ? Math.round(cents/100)*100 : cents;
      return cmp === qCents;
    });
  } else {
    items = lines(txt).filter(l=> l && (!qRaw || l.toLowerCase().includes(qRaw.toLowerCase())));
  }

  $(countId).textContent = `${items.length} coincidencias`;
  $(listId).innerHTML = items.length ? items.map(l=> `<div>${l.replace(/</g,"&lt;")}</div>`).join("") : `<div class="nores">Sin coincidencias</div>`;
}

/************ Pipeline principal ************/
function analizar(){
  state.roundPesos = $("#roundPesos").checked;

  // reset retiros
  state.retiros = [];

  const {cargas, bonifs} = parseCargas($("#cargasInput").value, state.roundPesos);
  const transfFromText = parseTransferencias($("#transfInput").value, state.roundPesos);

  // Base: Telepago/RECA
  let mergedTrans = transfFromText.slice();

  // Agregar Galicia si está activado el flag de incluir automáticamente
  if (INCLUDE_GALICIA_IN_ANALYSIS && GALICIA_BUFFER.length){
    const galAsTrans = GALICIA_BUFFER.map(it => ({
      amountCents: state.roundPesos ? Math.round(it.amountCents/100)*100 : it.amountCents,
      nameCandidate: it.name,
      date: extractDateDMYToISO(it.date) ? extractDateDMYToISO(it.date) : it.date, // guardamos ISO si es posible
      time: null,
      raw: `${it.date} ${it.name} ${it.amountStr}`,
      ts: null,
      source: 'galicia'
    }));
    mergedTrans.push(...galAsTrans);
  }

  state.cargas = cargas;
  state.bonifs = bonifs;
  state.transf = mergedTrans;

  // Emparejar bonificaciones y marcar cargas-bono para EXCLUIR
  state.cargasEmparejadasPorBonif = matchBonif(state.cargas, state.bonifs);
  const cargasConsideradas = getCargasConsideradas();

  state.cmpMonto = buildCmpMonto(cargasConsideradas, state.transf);

  $("#results").classList.remove("hidden");
  renderResumen();
  renderBonifs();
  renderFSCC(cargasConsideradas);
  renderCmpMonto();

  updateFilterList("#cargasInput","#filterCargas","#filterCargasList","#filterCargasCount");
  updateFilterList("#transfInput","#filterTransf","#filterTransfList","#filterTransfCount");

  // refrescar búsqueda avanzada de persona si hay query
  const advQ = $("#advQuery");
  if (advQ && advQ.value.trim()){
    const R = advPersonSearch(advQ.value);
    renderAdvPersonResults(R);
  }
}

/************ Eventos ************/
window.addEventListener("DOMContentLoaded", ()=>{
  const btnAnalyze = $("#analyzeBtn"); if (btnAnalyze) btnAnalyze.addEventListener("click", analizar);
  const btnExport = $("#exportBtn"); if (btnExport) btnExport.addEventListener("click", exportCSV);
  const btnClear  = $("#clearBtn");  if (btnClear)  btnClear.addEventListener("click", ()=>{
    ["#cargasInput","#transfInput","#filterCargas","#filterTransf","#advQuery"].forEach(id=>{ const el=$(id); if(el) el.value=""; });
    ["#filterCargasList","#filterTransfList","#advResults","#summaryList","#bonifBody","#faltantesBody","#sobrantesBody","#coincidenBody","#cmpMontoBody"].forEach(id=>{ const el=$(id); if(el) el.innerHTML=""; });
    $("#filterCargasCount").textContent = "0 coincidencias";
    $("#filterTransfCount").textContent = "0 coincidencias";
    $("#results").classList.add("hidden");
    state = { ...state, cargas:[], bonifs:[], transf:[], retiros:[], cargasEmparejadasPorBonif:new Set(), cmpMonto:[] };
    GALICIA_BUFFER = [];
    INCLUDE_GALICIA_IN_ANALYSIS = false;
  });

  $("#filterCargas").addEventListener("input", ()=> updateFilterList("#cargasInput","#filterCargas","#filterCargasList","#filterCargasCount"));
  $("#filterTransf").addEventListener("input", ()=> updateFilterList("#transfInput","#filterTransf","#filterTransfList","#filterTransfCount"));

  // Búsqueda avanzada por persona (en vivo)
  const advRun = ()=>{
    const q = $("#advQuery") ? $("#advQuery").value : "";
    const R = advPersonSearch(q);
    renderAdvPersonResults(R);
  };
  const btnAdv = $("#btnAdvSearch"); if (btnAdv) btnAdv.addEventListener("click", advRun);
  const advQ = $("#advQuery"); if (advQ){
    advQ.addEventListener("input", advRun);
    advQ.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); advRun(); }});
  }

  const mClose = $("#modalClose"); if (mClose) mClose.addEventListener("click", ()=> $("#modalBackdrop").classList.add("hidden"));
  const mBack  = $("#modalBackdrop"); if (mBack) mBack.addEventListener("click", (ev)=>{ if (ev.target.id==="modalBackdrop") $("#modalBackdrop").classList.add("hidden"); });

  // Inyectar botón Galicia
  setupGaliciaUI();
});

/************ Galicia normalizada (botón + modal + parser) ************/
function setupGaliciaUI(){
  const actions = document.querySelector(".actions");
  if (!actions || document.getElementById("btnGalicia")) return;
  const btn = document.createElement("button");
  btn.id = "btnGalicia";
  btn.className = "secondary";
  btn.textContent = "Ver Galicia normalizada";
  actions.appendChild(btn);
  btn.addEventListener("click", openGaliciaModal);
}

function openGaliciaModal(){
  const backdrop = $("#modalBackdrop");
  const title = $("#modalTitle");
  const body = $("#modalBody");
  if (!backdrop || !title || !body) return;

  title.textContent = "Galicia (pegar extracto y analizar)";
  body.innerHTML = `
    <div class="tiny" style="margin-bottom:8px">
      Pegá el extracto tal como lo copiás del banco. Se detectan bloques entre comillas y el formato simple con coma en el apellido.
    </div>
    <textarea id="galiciaInput" placeholder='Ejemplo:
16/10/2025\t" TRANSFERENCIA DE TERCEROS
 LUCIA PAOLA NAVARRETE
 27317397149
 4530000800013506908785
 VARIOS
 589244045300449034
 135069087800
"\t0,00\t3.000,00

16/10/2025\t" TRANSFERENCIA DE TERCEROS
 CIGLIUTTI, LEONARDO
 20239001964
 0270043420052141930018
 VARIOS
 4517XXXXXXXXXX32
   5214193001
 A001"\t0,00\t32.000,00

16/10/2025 CIGLIUTTI, LEONARDO 32.000,00'></textarea>

    <div class="actions" style="padding:10px 0 0; gap:8px; flex-wrap:wrap">
      <button id="btnParseGalicia" class="secondary">Analizar Galicia</button>
      <button id="btnCopyGalicia" class="subtle secondary" disabled>Copiar listado</button>
      <button id="btnSendGalicia" class="subtle secondary" disabled>Enviar al comparador</button>
      <label class="tiny" style="display:flex; align-items:center; gap:6px">
        <input type="checkbox" id="chkIncludeGalicia" />
        Incluir automáticamente en el próximo “Analizar”
      </label>
    </div>

    <div id="galiciaOut" class="filterList" style="margin-top:10px">
      <div class="nores">No se detectaron registros de Galicia. Pegá el extracto y presioná “Analizar Galicia”.</div>
    </div>
    <div id="galiciaNote" class="note"></div>
  `;

  const parseBtn = $("#btnParseGalicia");
  const copyBtn  = $("#btnCopyGalicia");
  const sendBtn  = $("#btnSendGalicia");
  const outBox   = $("#galiciaOut");
  const noteBox  = $("#galiciaNote");
  const chkInc   = $("#chkIncludeGalicia");

  chkInc.checked = INCLUDE_GALICIA_IN_ANALYSIS;

  function renderGalicia(){
    const raw = ($("#galiciaInput")?.value || "").trim();
    GALICIA_BUFFER = parseGaliciaRaw(raw); // [{date,name,amountStr,amountCents}]
    if (!GALICIA_BUFFER.length){
      outBox.innerHTML = `<div class="nores">No se detectaron registros de Galicia. Pegá el extracto y presioná “Analizar Galicia”.</div>`;
      noteBox.textContent = "";
      copyBtn.disabled = true;
      sendBtn.disabled = true;
      return;
    }
    const list = GALICIA_BUFFER.map(it => `${it.date} - ${it.name} - ${it.amountStr}`).join("\n");
    outBox.innerHTML = list.split("\n").map(l => `<div>${l}</div>`).join("");
    noteBox.innerHTML = `Registros detectados: <strong>${GALICIA_BUFFER.length}</strong>. Se mostrarán por aparte en el Resumen <span style="color:#ffa726">(naranja)</span> y se incluirán en la comparación.`;
    copyBtn.disabled = false;
    sendBtn.disabled = false;
    copyBtn.dataset.clip = list;
  }

  parseBtn.addEventListener("click", renderGalicia);
  copyBtn.addEventListener("click", ()=> {
    const txt = copyBtn.dataset.clip || "";
    if (!txt) return;
    navigator.clipboard.writeText(txt).then(()=>{
      copyBtn.textContent = "¡Copiado!";
      setTimeout(()=> copyBtn.textContent = "Copiar listado", 1200);
    });
  });

  // Enviar al comparador = volcar al textarea de transferencias (con marcador #GALICIA)
  sendBtn.addEventListener("click", ()=>{
    if (!GALICIA_BUFFER.length) return;
    const linesToAppend = GALICIA_BUFFER.map(it => `${it.date} ${it.name} ${it.amountStr} #GALICIA`).join("\n");
    const t = $("#transfInput");
    t.value = (t.value ? (t.value.trim()+"\n") : "") + linesToAppend + "\n";
    // Evitar duplicar desde buffer si ya los pegaste
    INCLUDE_GALICIA_IN_ANALYSIS = false;
    const chk = $("#chkIncludeGalicia"); if (chk) chk.checked = false;

    sendBtn.textContent = "¡Enviado!";
    setTimeout(()=> sendBtn.textContent = "Enviar al comparador", 1200);
  });

  chkInc.addEventListener("change", (e)=>{
    INCLUDE_GALICIA_IN_ANALYSIS = !!e.target.checked;
  });

  backdrop.classList.remove("hidden");
}

/* ---------- Parser Galicia (bloques + simple) ---------- */
function parseGaliciaRaw(raw){
  if (!raw) return [];
  const L = lines(raw);
  const isDate = (s)=> /^\s*\d{2}\/\d{2}\/\d{4}\b/.test(s);

  // agrupar por bloques que comienzan con fecha
  const blocks = [];
  let cur = [];
  for (let i=0;i<L.length;i++){
    const ln = L[i];
    if (isDate(ln)){
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [ln];
    } else {
      if (!cur.length) continue;
      cur.push(ln);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));

  const items = [];
  for (const block of blocks){
    // formato simple: "DD/MM/YYYY TITULAR Monto"
    const simple = block.match(/^\s*(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/m);
    if (simple){
      const date = simple[1];
      const name = cleanGaliciaName(simple[2]);
      const amountStr = normalizeArsAmount(simple[3]);
      const amountCents = parseArsToCents(amountStr);
      if (amountCents>0) items.push({date, name, amountStr, amountCents});
      continue;
    }

    // formato con comillas (bloque RECA)
    const dateMatch = block.match(/^\s*(\d{2}\/\d{2}\/\d{4})\b/);
    const date = dateMatch ? dateMatch[1] : "";

    const linesInBlock = block.split(/\r?\n/);
    const nameCandidates = [];
    let insideQuote = false;
    for (const ln of linesInBlock){
      if (ln.includes(`"`)) insideQuote = !insideQuote;
      if (!insideQuote) continue;
      const t = ln.trim();
      if (!t) continue;
      if (/TRANSFERENCIA DE TERCEROS/i.test(t)) continue;
      if (/VARIOS/i.test(t)) continue;
      if (/^[\d\sXx]+$/.test(t)) continue;
      if (/^\d{4,}$/.test(t)) continue;
      if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(t)) nameCandidates.push(t);
    }
    let name = "";
    const commaFirst = nameCandidates.find(s => /,/.test(s));
    if (commaFirst) name = commaFirst;
    else name = nameCandidates.find(s => s.split(/\s+/).length>=2) || nameCandidates[0] || "";
    name = cleanGaliciaName(name);

    const moneyTokens = block.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];
    let amountStr = "";
    let amountCents = null;
    for (let i = moneyTokens.length - 1; i >= 0; i--){
      const tok = normalizeArsAmount(moneyTokens[i]);
      const cents = parseArsToCents(tok);
      if (cents && cents > 0){ amountStr = tok; amountCents = cents; break; }
    }
    if (date && name && amountCents!=null && amountCents>0){
      items.push({date, name, amountStr, amountCents});
    }
  }
  return items;
}

function normalizeArsAmount(s){
  let t = (s||"").toString().trim();
  if (/^\d+(?:\.\d{2})$/.test(t)) t = t.replace(".", ",");
  t = t.replace(/[^\d.,]/g,"");
  return t;
}
function cleanGaliciaName(s){
  return (s||"")
    .replace(/^"+|"+$/g,"")
    .replace(/\s+/g," ")
    .trim()
    .toUpperCase();
}














