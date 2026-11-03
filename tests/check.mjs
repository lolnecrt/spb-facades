// Проверка генератора без зависимостей: node tests/check.mjs [--seed N] [--count N]
//
// 1. 200 случайных фасадов в допустимых диапазонах: каждый строится, ничего,
//    кроме кровли и скульптуры, не выше 23,5 м; оси внутри ширины; проёмы
//    (окна, двери, ворота) не пересекаются и не выходят за фасад.
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
  // предел: всё, кроме кровли и скульптуры (общее правило 3)
  const walls = m.elements.filter((e) => e.type !== 'roof' && e.type !== 'sculpture');
  const top = Math.max(...walls.map(topOf));
  if (top > LIMIT + EPS) errs.push(`элемент на ${top.toFixed(3)} м выше ${LIMIT}`);
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
  if (g.ok) fail(`${st.id}: при ${over} эт. фасад построен (верх ${g.model.wallTop})`);
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
