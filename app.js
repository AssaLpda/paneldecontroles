// ================== Comparador Cargas vs Transferencias ==================
// (Incluye buscador por monto en Cargas y Transferencias)

// ===== Config =====
const BONIF_PAIR_WINDOW_MIN = 30;
const USE_DAY_MATCH_WHEN_NO_TIME = true;

// ===== Utiles =====
const moneyFmt = (cents) => {
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents);
  const pesos = Math.floor(v / 100);
  const cent = (v % 100).toString().padStart(2, "0");
  return sign + pesos.toLocaleString("es-AR") + "," + cent;
};

const parseArsToCents = (str, roundPesos=false) => {
  let s = (str || "").toString().trim();
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/\./g, "");
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return roundPesos ? Math.round(n) * 100 : Math.round(n * 100);
};

const findAllArsInLine = (line) => {
  const regex = /(?<!\d)(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?)(?!\d)/g;
  const out = []; let m;
  while ((m = regex.exec(line)) !== null) out.push({ value: m[1], index: m.index });
  return out;
};

const normUser = (s) => (s||"").trim().toLowerCase();
const extractDate = (line) => { const m = line.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const extractTime = (line) => { const m = line.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/); return m ? m[1] : null; };
const toMinutes = (hhmmss) => {
  if (!hhmmss) return null;
  const parts = hhmmss.split(":").map(n=>parseInt(n,10));
  return (parts[0]||0)*60 + (parts[1]||0);
};
const escapeHtml = (s="") =>
  s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

// ===== Parsers detallados =====
const parseCargasDetailed = (text, roundPesos=false) => {
  const lines = text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const cargas = [];
  const cargasMontos = [];
  for (const line of lines) {
    if (/bonificaci[oó]n/i.test(line)) continue;

    let monto = null;
    const cargaMatch = line.match(/Carga\s+([$\s-]*[\d\.,]+)/i);
    if (cargaMatch) {
      monto = parseArsToCents(cargaMatch[1], roundPesos);
    } else {
      const all = findAllArsInLine(line);
      if (all.length) monto = parseArsToCents(all[all.length-1].value, roundPesos);
    }
    if (monto === null) continue;

    let usuario = null;
    const uBefore = line.match(/(\S+)\s+Carga\s+([$\s-]*[\d\.,]+)/i);
    if (uBefore) usuario = uBefore[1];
    if (!usuario) {
      const pieces = line.split(/\s+/);
      usuario = pieces.find(t => /[a-z0-9_]/i.test(t) && t.length>=4) || "";
    }

    const fecha = extractDate(line);
    const time = extractTime(line);
    const mins = toMinutes(time);

    const item = { monto, line, usuario: normUser(usuario), fecha, mins };
    cargas.push(item);
    cargasMontos.push(monto);
  }
  return { cargas, cargasMontos };
};

const parseBonificacionesDetailed = (text, roundPesos=false) => {
  const lines = text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (!/bonificaci[oó]n/i.test(line)) continue;
    const afterWord = line.split(/bonificaci[oó]n/i)[1] || "";
    const candidates = findAllArsInLine(afterWord);
    if (!candidates.length) continue;
    const cents = parseArsToCents(candidates[0].value, roundPesos);
    if (cents === null) continue;
    const abs = Math.abs(cents);
    const snippet = line.length>120 ? line.slice(0,117)+'...' : line;

    let usuario = null;
    const uMatch = line.match(/(\S+)\s+Bonificaci[oó]n/i);
    if (uMatch) usuario = uMatch[1];
    if (!usuario) {
      const pieces = line.split(/\s+/);
      usuario = pieces.find(t => /[a-z0-9_]/i.test(t) && t.length>=4) || "";
    }
    const fecha = extractDate(line);
    const time = extractTime(line);
    const mins = toMinutes(time);

    items.push({ monto: abs, doble: abs*2, snippet, usuario: normUser(usuario), fecha, mins });
  }
  return items;
};

const parseTransferencias = (text, roundPesos=false) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const montos = [];
  for (const raw of lines) {
    const line = raw;
    const lower = line.toLowerCase();

    // Telepago
    const telepagoMatch = line.match(/^\s*([\d.]+)(?:[^\d]|$)/);
    const hasTime = /\b\d{1,2}:\d{2}\b/.test(line);
    if (telepagoMatch && hasTime) {
      const firstNumber = telepagoMatch[1];
      const cents = parseArsToCents(firstNumber, roundPesos);
      if (cents) montos.push(cents);
      continue;
    }

    // RECA / genérico
    const candidates = findAllArsInLine(line);
    if (!candidates.length) continue;
    let filtered = candidates;

    if (lower.includes("saldo")) {
      filtered = candidates.filter(c => {
        const window = line.slice(Math.max(0, c.index - 10), c.index + 20).toLowerCase();
        return !(window.includes("saldo"));
      });
    }

    filtered = filtered.filter(c => {
      const cents = parseArsToCents(c.value, roundPesos);
      return cents !== null && cents !== 0;
    });

    for (const c of filtered) {
      const cents = parseArsToCents(c.value, roundPesos);
      if (cents !== null) montos.push(cents);
    }
  }
  return montos;
};

// ===== Emparejamiento 1 a 1: bonificación -> SOLO una carga del MISMO MONTO =====
const indicesCargasAsociadasABonif = (cargas, bonifs) => {
  const sortByTime = (a,b) => {
    const fa = a.fecha || "", fb = b.fecha || "";
    if (fa !== fb) return fa.localeCompare(fb);
    const ma = a.mins ?? -1, mb = b.mins ?? -1;
    return ma - mb;
  };
  const cargasIdx = cargas.map((c,idx)=>({ ...c, idx })).sort(sortByTime);
  const bonifsOrd = [...bonifs].sort(sortByTime);

  const used = new Set();
  const matched = new Set();

  for (const b of bonifsOrd) {
    let candidatos = cargasIdx.filter(c =>
      !used.has(c.idx) &&
      c.usuario && b.usuario && c.usuario === b.usuario &&
      c.monto === b.monto
    );

    if (!candidatos.length) continue;

    const hasTimeB = b.mins != null;
    let candidatosFiltrados = candidatos;

    if (hasTimeB) {
      candidatosFiltrados = candidatos.filter(c => {
        if (c.fecha && b.fecha && c.fecha !== b.fecha) return false;
        if (c.mins == null) return USE_DAY_MATCH_WHEN_NO_TIME ? (c.fecha && b.fecha && c.fecha === b.fecha) : true;
        return Math.abs(c.mins - b.mins) <= BONIF_PAIR_WINDOW_MIN;
      });
      if (!candidatosFiltrados.length && USE_DAY_MATCH_WHEN_NO_TIME) {
        candidatosFiltrados = candidatos.filter(c => c.fecha && b.fecha && c.fecha === b.fecha);
      }
    } else if (USE_DAY_MATCH_WHEN_NO_TIME) {
      candidatosFiltrados = candidatos.filter(c => c.fecha && b.fecha && c.fecha === b.fecha);
    }

    if (!candidatosFiltrados.length) continue;

    let elegido = candidatosFiltrados[0];
    if (hasTimeB) {
      elegido = candidatosFiltrados.reduce((best,cur)=>{
        const dBest = (best.mins==null||b.mins==null)?Infinity:Math.abs(best.mins-b.mins);
        const dCur  = (cur.mins==null || b.mins==null)?Infinity:Math.abs(cur.mins - b.mins);
        return dCur < dBest ? cur : best;
      }, elegido);
    }

    used.add(elegido.idx);
    matched.add(elegido.idx);
  }

  return matched;
};

// ===== Multiset helpers =====
const toFreqMap = (arr) => {
  const map = new Map();
  for (const v of arr) map.set(v, (map.get(v) || 0) + 1);
  return map;
};
const sumCents = (arr) => arr.reduce((a,b)=>a+b,0);

const compareMultisets = (cargas, transfs) => {
  const A = toFreqMap(cargas);
  const B = toFreqMap(transfs);

  const faltan = new Map();
  const sobran = new Map();
  const coinciden = [];

  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const a = A.get(k) || 0;
    const b = B.get(k) || 0;
    if (a > b) faltan.set(k, a - b);
    if (b > a) sobran.set(k, b - a);
    coinciden.push([k, a, b]);
  }
  coinciden.sort((x,y)=>x[0]-y[0]);
  return { faltan, sobran, coinciden };
};

// ===== UI =====
const $ = s => document.querySelector(s);

const cargasInput = $('#cargasInput');
const transfInput = $('#transfInput');
const analyzeBtn = $('#analyzeBtn');
const exportBtn  = $('#exportBtn');
const clearBtn   = $('#clearBtn');
const roundPesosChk = $('#roundPesos');

const results = $('#results');
const summaryList = $('#summaryList');
const bonifBody = $('#bonifBody');
const bonifNote = $('#bonifNote');
const faltantesBody = $('#faltantesBody');
const sobrantesBody = $('#sobrantesBody');
const coincidenBody = $('#coincidenBody');
const faltantesNote = $('#faltantesNote');
const sobrantesNote = $('#sobrantesNote');

// Buscador (DOM)
const filterCargas = $('#filterCargas');
const filterTransf = $('#filterTransf');
const filterCargasCount = $('#filterCargasCount');
const filterTransfCount = $('#filterTransfCount');
const filterCargasList = $('#filterCargasList');
const filterTransfList = $('#filterTransfList');

// ===== Render helpers =====
const renderRows = (tbody, map) => {
  tbody.innerHTML = '';
  const entries = [...map.entries()].sort((a,b)=>a[0]-b[0]);
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="2"><span class="ok">Nada para mostrar.</span></td></tr>`;
    return;
  }
  for (const [monto, cant] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${moneyFmt(monto)}</td><td>${cant}</td>`;
    tbody.appendChild(tr);
  }
};

const renderCoinciden = (tbody, arr) => {
  tbody.innerHTML = '';
  if (!arr.length) {
    tbody.innerHTML = `<tr><td colspan="3">—</td></tr>`;
    return;
  }
  for (const [monto, cA, cB] of arr) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${moneyFmt(monto)}</td><td>${cA}</td><td>${cB}</td>`;
    tbody.appendChild(tr);
  }
};

const renderBonifs = (tbody, bonifItems) => {
  tbody.innerHTML = '';
  if (!bonifItems.length) {
    tbody.innerHTML = `<tr><td colspan="2"><span class="ok">No se detectaron bonificaciones.</span></td></tr>`;
    bonifNote.textContent = 'Las bonificaciones no se comparan ni cuentan como carga. Solo ajustan el total (descuento x2).';
    return;
  }
  for (const it of bonifItems) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="bonif">- ${moneyFmt(it.monto)}</td><td>${it.snippet}</td>`;
    tbody.appendChild(tr);
  }
  const totalDoble = bonifItems.reduce((a,i)=>a+i.doble,0);
  bonifNote.textContent = `Total de doble descuento aplicado: - ${moneyFmt(totalDoble)} (sobre el total de cargas).`;
};

const renderSummary = (cargasMontos, transfs, bonifItems) => {
  summaryList.innerHTML = '';
  const li = (html) => { const x=document.createElement('li'); x.innerHTML=html; return x; };

  const totalCargas = sumCents(cargasMontos);
  const totalTransf = sumCents(transfs);
  const bonifsDoubleCents = bonifItems.reduce((a,i)=>a+i.doble,0);
  const totalCargasAjust = totalCargas - bonifsDoubleCents;
  const diff = totalCargasAjust - totalTransf;

  summaryList.append(
    li(`<strong>Cantidad de cargas (sin bonificaciones):</strong> ${cargasMontos.length}`),
    li(`<strong>Cantidad de transferencias:</strong> ${transfs.length}`),
    li(`<strong>Bonificaciones detectadas:</strong> ${bonifItems.length}`),
    li(`<strong>Total en cargas (sin ajuste):</strong> ${moneyFmt(totalCargas)}`),
    li(`<strong>Ajuste por bonificaciones (descuento x2):</strong> -${moneyFmt(bonifsDoubleCents)}`),
    li(`<strong>Total en cargas AJUSTADO:</strong> ${moneyFmt(totalCargasAjust)}`),
    li(`<strong>Total en transferencias:</strong> ${moneyFmt(totalTransf)}`),
    li(`<strong>Diferencia (cargas AJUSTADAS - transferencias):</strong> <span class="${diff===0?'ok':'bad'}">${moneyFmt(diff)}</span>`)
  );
};

let lastState = null;

const analyze = () => {
  const roundPesos = !!roundPesosChk.checked;

  const { cargas, cargasMontos } = parseCargasDetailed(cargasInput.value || "", roundPesos);
  const bonifItems = parseBonificacionesDetailed(cargasInput.value || "", roundPesos);
  const transfs = parseTransferencias(transfInput.value || "", roundPesos);

  const idxExcluir = indicesCargasAsociadasABonif(cargas, bonifItems);
  const cargasParaComparar = cargas
    .filter((c,idx)=> !idxExcluir.has(idx))
    .map(c => c.monto);

  const { faltan, sobran, coinciden } = compareMultisets(cargasParaComparar, transfs);

  renderSummary(cargasMontos, transfs, bonifItems);
  renderBonifs(bonifBody, bonifItems);
  renderRows(faltantesBody, faltan);
  renderRows(sobrantesBody, sobran);
  renderCoinciden(coincidenBody, coinciden);

  faltantesNote.textContent = faltan.size
    ? 'Sólo se listan cargas sin bonificación asociada que no tienen transferencia equivalente.'
    : 'No faltan transferencias respecto de las cargas (descontando cargas asociadas a bonificaciones).';
  sobrantesNote.textContent = sobran.size
    ? 'Plata acreditada en billetera que no tiene carga equivalente la misma cantidad de veces.'
    : 'No hay plata acreditada sin su carga equivalente.';

  results.classList.remove('hidden');

  lastState = {
    roundPesos,
    cargasMontos,
    transfs,
    bonifItems,
    cargasParaComparar,
    faltan, sobran, coinciden
  };
};

// ===== Export CSV =====
const mapToSortedArray = (map) => [...map.entries()].sort((a,b)=>a[0]-b[0]);

const csvEscape = (s) => {
  const str = (s ?? "").toString();
  if (/[",\n;]/.test(str)) return `"${str.replace(/"/g,'""')}"`;
  return str;
};

const downloadCSV = (filename, csv) => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};

const exportCSV = () => {
  if (!lastState) { alert('Primero analizá los datos.'); return; }
  const { cargasMontos, transfs, bonifItems, faltan, sobran, coinciden } = lastState;

  const totalCargas = sumCents(cargasMontos);
  const totalTransf = sumCents(transfs);
  const bonifsDouble = bonifItems.reduce((a,i)=>a+i.doble,0);
  const totalCargasAjust = totalCargas - bonifsDouble;
  const diff = totalCargasAjust - totalTransf;

  const lines = [];
  lines.push('Resumen');
  lines.push('Campo;Valor');
  lines.push(`Cantidad de cargas (sin bonificaciones);${cargasMontos.length}`);
  lines.push(`Cantidad de transferencias;${transfs.length}`);
  lines.push(`Bonificaciones detectadas;${bonifItems.length}`);
  lines.push(`Total en cargas (sin ajuste);${moneyFmt(totalCargas)}`);
  lines.push(`Ajuste por bonificaciones (x2);-${moneyFmt(bonifsDouble)}`);
  lines.push(`Total en cargas AJUSTADO;${moneyFmt(totalCargasAjust)}`);
  lines.push(`Total en transferencias;${moneyFmt(totalTransf)}`);
  lines.push(`Diferencia (cargas AJUSTADAS - transferencias);${moneyFmt(diff)}`);
  lines.push('');

  lines.push('Bonificaciones (no se comparan ni cuentan como carga)');
  lines.push('Monto;Fuente');
  if (bonifItems.length) {
    for (const it of bonifItems) lines.push(`${moneyFmt(it.monto)};${csvEscape(it.snippet)}`);
  } else lines.push('—;—');
  lines.push('');

  lines.push('Cargas SIN transferencia equivalente (excluye cargas asociadas a bonificación)');
  lines.push('Monto;Faltan (veces)');
  const faltArr = mapToSortedArray(faltan);
  if (faltArr.length) for (const [m,c] of faltArr) lines.push(`${moneyFmt(m)};${c}`); else lines.push('—;—');
  lines.push('');

  lines.push('Plata acreditada pero no cargada en fichas');
  lines.push('Monto;Sobran (veces)');
  const sobrArr = mapToSortedArray(sobran);
  if (sobrArr.length) for (const [m,c] of sobrArr) lines.push(`${moneyFmt(m)};${c}`); else lines.push('—;—');
  lines.push('');

  lines.push('Coincidencias (monto y cantidad)');
  lines.push('Monto;En Cargas;En Transferencias');
  if (coinciden.length) for (const [m,a,b] of coinciden) lines.push(`${moneyFmt(m)};${a};${b}`); else lines.push('—;—;—');

  const csv = lines.join('\n');
  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  downloadCSV(`reporte_cargas_vs_transferencias_${ts}.csv`, csv);
};

// ===== Buscador por monto =====
const filterLinesByAmount = (text, amountStr, roundPesos=false) => {
  const res = { lines:[], error:null, cents:null };
  const target = parseArsToCents(amountStr, roundPesos);
  if (amountStr.trim() && target === null) { res.error = 'Monto inválido'; return res; }
  if (!amountStr.trim()) return res; // vacío => sin resultados (0)
  res.cents = target;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const nums = findAllArsInLine(line);
    let match = false;
    for (const n of nums) {
      const cents = parseArsToCents(n.value, roundPesos);
      if (cents !== null && cents === target) { match = true; break; }
    }
    if (match) res.lines.push(raw); // conservar formato original
  }
  return res;
};

const updateFilterUI = (which) => {
  const roundPesos = !!roundPesosChk.checked;

  if (which === 'cargas') {
    const q = filterCargas.value || '';
    const { lines, error } = filterLinesByAmount(cargasInput.value || '', q, roundPesos);
    if (error) {
      filterCargasCount.textContent = 'Error';
      filterCargasList.innerHTML = `<div class="err">${escapeHtml(error)}</div>`;
      return;
    }
    filterCargasCount.textContent = `${lines.length} coincidencia${lines.length===1?'':'s'}`;
    filterCargasList.innerHTML = lines.length
      ? `<pre>${escapeHtml(lines.join('\n'))}</pre>`
      : `<div class="nores">Escribí un monto para ver coincidencias…</div>`;
  } else if (which === 'transf') {
    const q = filterTransf.value || '';
    const { lines, error } = filterLinesByAmount(transfInput.value || '', q, roundPesos);
    if (error) {
      filterTransfCount.textContent = 'Error';
      filterTransfList.innerHTML = `<div class="err">${escapeHtml(error)}</div>`;
      return;
    }
    filterTransfCount.textContent = `${lines.length} coincidencia${lines.length===1?'':'s'}`;
    filterTransfList.innerHTML = lines.length
      ? `<pre>${escapeHtml(lines.join('\n'))}</pre>`
      : `<div class="nores">Escribí un monto para ver coincidencias…</div>`;
  }
};

// ===== Eventos =====
document.addEventListener('DOMContentLoaded', () => {
  analyzeBtn?.addEventListener('click', analyze);
  exportBtn?.addEventListener('click', exportCSV);
  clearBtn?.addEventListener('click', () => {
    cargasInput.value = '';
    transfInput.value = '';
    results.classList.add('hidden');
    filterCargas.value = '';
    filterTransf.value = '';
    updateFilterUI('cargas');
    updateFilterUI('transf');
    lastState = null;
  });

  // Ctrl+Enter para analizar rápido
  [cargasInput, transfInput].forEach(el => {
    el?.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') analyze(); });
  });

  // Buscadores: reaccionan al tipear
  filterCargas?.addEventListener('input', () => updateFilterUI('cargas'));
  filterTransf?.addEventListener('input', () => updateFilterUI('transf'));

  // Si cambia el redondeo, refrescar los buscadores
  roundPesosChk?.addEventListener('change', () => {
    updateFilterUI('cargas');
    updateFilterUI('transf');
  });

  // Inicializar listas vacías
  updateFilterUI('cargas');
  updateFilterUI('transf');
});







