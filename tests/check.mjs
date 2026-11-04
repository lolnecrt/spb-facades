// Проверка генератора без зависимостей: node tests/check.mjs [--seed N] [--count N]
//
// 1. 200 случайных фасадов в допустимых диапазонах: каждый строится, ничего,
//    кроме аттика, кровли и скульптуры, не выше 23,5 м; оси внутри ширины; проёмы
//    (окна, двери, ворота) не пересекаются и не выходят за фасад; в объёме для
//    3d.html отверстия лежат внутри контура стены и не касаются друг друга.
//    Геометрия проверяется здесь заново, а не через проверки самого генератора.
// 2. Запросы за пределами диапазонов: генератор отказывает, а не строит
//    фасад выше предела.
// 3. Шесть домов альбома: ширина, число осей и отметка карниза совпадают;
//    docs/validation.md не устарел.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validationMarkdown, loadData } from './validation.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const G = require(join(ROOT, 'src/generator.js'));
const DATA = loadData();
const LIMIT = DATA.limit.cornice_max_m;
const EPS = 1e-6;

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const SEED = arg('--seed', 1844);
const COUNT = arg('--count', 200);

// mulberry32 — воспроизводимый генератор случайных чисел
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const uni = (a, b) => a + (b - a) * rand();

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 30) console.log('  ✗ ' + msg); };

// точка строго внутри многоугольника: по лучу внутри и не ближе 1 мм к рёбрам
function inPoly(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    const dx = xj - xi, dy = yj - yi, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - xi) * dx + (p[1] - yi) * dy) / L)) : 0;
    if (Math.hypot(p[0] - xi - t * dx, p[1] - yi - t * dy) < 1e-3) return false;
  }
  return c;
}

// верх элемента по его геометрии
function topOf(e) {
  switch (e.type) {
    case 'parapet': case 'roof': return Math.max(...e.pts.map((p) => p[1]));
    case 'wall': return e.outline ? Math.max(...e.outline.map((p) => p[1])) : e.z1;
    case 'attic': return Math.max(...e.parts.map((p) => p.z1)) + (e.arch ? e.arch.r : 0);
    case 'brow': return e.z0 + e.rise;
    case 'balcony': return e.railTop;
    case 'opening': case 'sandrik': return e.z0 + e.h;
    case 'portal': return e.h + e.lintelH + e.pedH;
    case 'medallion': return e.z + e.d / 2;
    default: return e.z1 !== undefined ? e.z1 : -Infinity;
  }
}

function inspect(req, m, label) {
  const errs = [];
  // предел (общее правило 3): всё, кроме аттика, аттикового этажа, кровли,
  // бровки эркера и скульптуры, — не выше 23,5 м
  const EXEMPT = new Set(['roof', 'sculpture', 'attic', 'attic-floor', 'brow']);
  const walls = m.elements.filter((e) => !EXEMPT.has(e.type));
  const top = Math.max(...walls.map(topOf));
  if (top > LIMIT + EPS) errs.push(`элемент ${walls.find((e) => topOf(e) === top).type} на ${top.toFixed(3)} м выше ${LIMIT}`);
  // первый этаж строго выше остальных (G2)
  const hs = m.section.floors.map((f) => f.h);
  if (!(hs[0] > Math.max(...hs.slice(1)) + EPS)) errs.push(`1-й этаж ${hs[0]} м не выше остальных`);
  if (m.cornice !== null && m.cornice > LIMIT + EPS) errs.push(`карниз ${m.cornice}`);
  if (m.parapetTop !== null && m.parapetTop > LIMIT + EPS) errs.push(`парапет ${m.parapetTop}`);
  // оси влезают в ширину
  const ax = m.axes;
  if (Math.abs(m.W - req.width) > 1e-3) errs.push(`ширина ${m.W} вместо ${req.width}`);
  ax.forEach((a, i) => {
    if (!(a.x > EPS && a.x < m.W - EPS)) errs.push(`ось ${a.n} в точке ${a.x} вне ширины ${m.W}`);
    if (i && a.x <= ax[i - 1].x + EPS) errs.push(`оси ${i} и ${i + 1} не по порядку`);
  });
  const parts = m.parts.reduce((s, p) => s + (p.x1 - p.x0), 0);
  if (Math.abs(parts - m.W) > 1e-3) errs.push(`части фасада ${parts} ≠ ширине ${m.W}`);
  // проёмы не пересекаются и не выходят за фасад
  const ops = m.elements.filter((e) => e.type === 'opening').map((e) => ({ e, x0: e.x - e.w / 2, x1: e.x + e.w / 2, z0: e.z0, z1: e.z0 + e.h }));
  for (const o of ops) if (o.x0 < -EPS || o.x1 > m.W + EPS || o.z0 < -EPS) errs.push(`проём на оси ${o.e.axis} выходит за фасад`);
  for (let i = 0; i < ops.length; i++) for (let j = i + 1; j < ops.length; j++) {
    const a = ops[i], b = ops[j];
    if (a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS) errs.push(`проёмы пересекаются: ось ${a.e.axis}/${b.e.axis}, этаж ${a.e.floor}/${b.e.floor}`);
    else { const g = 0.1 - EPS; if (a.x0 < b.x1 + g && b.x0 < a.x1 + g && a.z0 < b.z1 + g && b.z0 < a.z1 + g) errs.push(`простенок меньше 10 см: ось ${a.e.axis}/${b.e.axis}, этаж ${a.e.floor}/${b.e.floor}`); }
  }
  // решения автора (ответы на вопросы)
  const st = DATA.styles.find((q) => q.id === m.style);
  if (m.style === '04') {
    if (ax.length < 3 || ax.length > 6) errs.push(`у модерна ${ax.length} осей, а можно 3–6`);
    const er = ax.find((a) => a.part === 'erker');
    if (!er || Math.abs(er.x - m.W / 2) < 0.1) errs.push('эркер модерна стоит по центру');
    // под каждой добавленной осью — витрины на 1-м и 2-м этажах
    for (const a of ax.filter((q) => q.part === 'added')) {
      const v = m.elements.filter((e) => e.type === 'opening' && e.kind === 'vitrine' && Math.abs(e.x - a.x) < EPS).map((e) => e.floor).sort();
      if (v.join() !== '1,2') errs.push(`под добавленной осью ${a.n} нет витрин на 1–2-м этажах (${v.join() || 'ничего'})`);
    }
  }
  if (m.style === '01') {
    const p = m.parts.find((q) => q.kind === 'portico');
    const cols = m.elements.filter((e) => e.type === 'column' && e.kind === 'column' && e.x > p.x0 && e.x < p.x1).length;
    if (![4, 6, 8].includes(cols)) errs.push(`в портике ${cols} колонн, а можно 4, 6 или 8`);
    const wl = ax.filter((a) => a.part === 'wing' && a.x < m.W / 2).length;
    const wr = ax.filter((a) => a.part === 'wing' && a.x > m.W / 2).length;
    if (wl !== wr || wl < 3 || wl > 6) errs.push(`в крыльях ${wl} и ${wr} осей, а нужно поровну, от 3 до 6`);
    if (m.parts.map((q) => q.kind).join() !== 'risalit,wing,portico,wing,risalit') errs.push('нет пятичастной схемы');
  }
  if (m.style === '02') {
    const own = st.generator.floor_heights_m;
    m.section.floors.forEach((f) => { if (Math.abs(f.h - own[f.role - 1]) > EPS) errs.push(`02: этаж ${f.n} высотой ${f.h} вместо ${own[f.role - 1]}`); });
  }
  // первый и верхний этажи — как в альбоме, меняются только типовые средние
  const roles = m.section.floors.filter((f) => f.role !== 'attic').map((f) => f.role);
  if (roles[0] !== 1 || roles[roles.length - 1] !== st.section.floors.length) errs.push(`первый или верхний этаж подменён: ${roles.join(',')}`);
  // объём для 3d.html: отверстия строго внутри контура и не касаются друг друга
  const sol = G.solid(m);
  if (!sol.parts.every((q) => JSON.stringify(q).match(/-?\d/) && !/null|NaN/.test(JSON.stringify(q)))) errs.push('в объёме есть null/NaN');
  for (const q of sol.parts.filter((r) => r.kind === 'prism' && r.holes.length)) {
    for (const h of q.holes) if (!h.every((pt) => inPoly(pt, q.pts))) errs.push(`3D: проём вне контура «${q.name}»`);
    const bb = q.holes.map((h) => [Math.min(...h.map((p) => p[0])), Math.max(...h.map((p) => p[0])), Math.min(...h.map((p) => p[1])), Math.max(...h.map((p) => p[1]))]);
    for (let i = 0; i < bb.length; i++) for (let j = i + 1; j < bb.length; j++) {
      const A = bb[i], B = bb[j];
      if (A[0] < B[1] + 1e-3 && B[0] < A[1] + 1e-3 && A[2] < B[3] + 1e-3 && B[2] < A[3] + 1e-3) errs.push(`3D: проёмы касаются в «${q.name}»`);
    }
  }
  // правила автора, которые генератор проверяет сам, тоже должны выполняться
  for (const c of m.checks) if (!c.ok) errs.push(`правило ${c.id}: ${c.detail}`);
  // все элементы — из одного стиля (запрет смешения)
  if (m.elements.some((e) => e.style !== m.style)) errs.push('элементы другого стиля');
  // чертёж собирается
  const svg = G.render(m, DATA);
  if (/NaN|undefined/.test(svg)) errs.push('в SVG есть NaN/undefined');
  if (!svg.includes('class="lim"')) errs.push('в SVG нет линии 23,5 м');
  const nums = (svg.match(/<circle class="dim"/g) || []).length;
  if (nums !== ax.length) errs.push(`на чертеже ${nums} номеров осей вместо ${ax.length}`);
  for (const e of errs) fail(`${label}: ${e}`);
  return { errs, top, ops: ops.length };
}

// ---------------------------------------------------------------- 1
console.log(`1. ${COUNT} случайных фасадов (seed ${SEED})`);
const ranges = {};
for (const st of DATA.styles) ranges[st.id] = G.floorRange(DATA, st.id, {});
const stats = { built: 0, maxTop: 0, ops: 0, byStyle: {} };
for (let k = 0; k < COUNT; k++) {
  const st = pick(DATA.styles);
  const options = {};
  for (const d of G.styleOptions(st)) options[d.key] = d.type === 'bool' ? rand() < 0.5 : Math.round(uni(d.min, d.max) * 100) / 100;
  const fr = G.floorRange(DATA, st.id, options);
  const floors = pick(fr.list.filter((x) => x.ok).map((x) => x.N));
  const wr = G.widthRange(DATA, st.id, floors, options);
  const hi = rand() < 0.5 ? Math.min(G.W_MAX, 2 * st.album.width_m) : G.W_MAX;
  const width = Math.round(uni(wr.min, hi) * 100) / 100;
  const req = { style: st.id, width, floors, options };
  const label = `#${k + 1} ${st.id} W=${width} N=${floors} ${JSON.stringify(options)}`;
  const g = G.generate(DATA, req);
  if (!g.ok) { fail(`${label}: не построен — ${g.error}`); continue; }
  const r = inspect(req, g.model, label);
  stats.built++; stats.ops += r.ops; stats.maxTop = Math.max(stats.maxTop, r.top);
  stats.byStyle[st.id] = (stats.byStyle[st.id] || 0) + 1;
}
console.log(`   построено ${stats.built} из ${COUNT}; по стилям ${JSON.stringify(stats.byStyle)}; проёмов проверено ${stats.ops}; самый высокий элемент стены ${stats.maxTop.toFixed(2)} м`);

// ---------------------------------------------------------------- 2
console.log('2. Запросы вне диапазонов');
let refused = 0, builtOk = 0;
for (let k = 0; k < 100; k++) {
  const st = pick(DATA.styles);
  const req = { style: st.id, width: Math.round(uni(1, 160) * 100) / 100, floors: 1 + Math.floor(rand() * 9), options: {} };
  const g = G.generate(DATA, req);
  if (!g.ok) { refused++; continue; }
  builtOk++;
  inspect(req, g.model, `вне диапазона ${st.id} W=${req.width} N=${req.floors}`);
}
for (const st of DATA.styles) {
  const over = ranges[st.id].max + 1;
  const g = G.generate(DATA, { style: st.id, width: st.album.width_m, floors: over });
  if (g.ok) fail(`${st.id}: при ${over} эт. фасад построен (карниз/парапет ${g.model.limitTop})`);
  else if (!/23,5|допускает|этажность/.test(g.error)) fail(`${st.id}: непонятный отказ «${g.error}»`);
}
console.log(`   100 случайных: отказ ${refused}, построено ${builtOk} (все построенные проверены как в п. 1); этажность сверх максимума — отказ у всех 6 стилей`);

// ---------------------------------------------------------------- 3
console.log('3. Дома альбома');
for (const r of G.validate(DATA)) {
  if (!r.ok) { fail(`${r.id}: не построен — ${r.error}`); continue; }
  const bad = [];
  if (Math.abs(r.width.diff) > 1e-3) bad.push(`ширина ${r.width.gen} ≠ ${r.width.album}`);
  if (r.axes.diff !== 0) bad.push(`осей ${r.axes.gen} ≠ ${r.axes.album}`);
  if (Math.abs(r.cornice.diff) > 1e-3) bad.push(`карниз ${r.cornice.gen} ≠ ${r.cornice.album}`);
  if (!r.checksOk) bad.push('не все проверки правил выполнены');
  if (bad.length) bad.forEach((b) => fail(`${r.id}: ${b}`));
  else console.log(`   ${r.id} ${r.address}: ширина ${r.width.gen}, осей ${r.axes.gen}, ${r.corniceKind} ${r.cornice.gen} — совпадает`);
}
const doc = readFileSync(join(ROOT, 'docs/validation.md'), 'utf8');
if (doc !== validationMarkdown(DATA)) fail('docs/validation.md устарел — запустите node tests/validation.mjs --write');
else console.log('   docs/validation.md актуален');

console.log(failures ? `\nОШИБОК: ${failures}` : '\nВсё в порядке.');
process.exit(failures ? 1 : 0);
