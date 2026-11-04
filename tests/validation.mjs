// Таблица «альбом / генератор / расхождение» для шести домов альбома.
// node tests/validation.mjs          — напечатать markdown
// node tests/validation.mjs --write  — записать docs/validation.md
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const G = require(join(ROOT, 'src/generator.js'));

export function loadData() {
  return JSON.parse(readFileSync(join(ROOT, 'data/styles.json'), 'utf8'));
}

const f = (v, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',');
const df = (v, d = 2) => (Math.abs(v) < 1e-9 ? (d ? '0,' + '0'.repeat(d) : '0') : (v > 0 ? '+' : '') + f(v, d));

export function validationMarkdown(data = loadData()) {
  const rows = G.validate(data);
  const L = [];
  L.push('# Проверка: генератор воспроизводит дома альбома');
  L.push('');
  L.push('Файл собирается командой `node tests/validation.mjs --write`; `node tests/check.mjs` падает, если он устарел. Та же таблица считается на странице `index.html`.');
  L.push('');
  L.push('Для каждого дома генератор получает тип, ширину фасада и этажность из альбома (`data/styles.json`, блок `album`) и варианты по умолчанию. Сравниваются ширина, число осей и отметка карниза. Сравнение точное, без допуска ±0,5 м, с которым сделан сам альбом.');
  L.push('');
  L.push('| Тип · дом | Ширина: альбом | генератор | расхождение | Осей: альбом | генератор | расхождение | Карниз: альбом | генератор | расхождение |');
  L.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of rows) {
    if (!r.ok) { L.push(`| ${r.id} · ${r.address} | не построен: ${r.error} |||||||||`); continue; }
    const kind = r.corniceKind === 'карниз' ? '' : ' ¹';
    L.push(`| ${r.id} ${r.name} · ${r.address} | ${f(r.width.album)} | ${f(r.width.gen)} | ${df(r.width.diff)} | ${r.axes.album} | ${r.axes.gen} | ${df(r.axes.diff, 0)} | ${f(r.cornice.album)}${kind} | ${f(r.cornice.gen)}${kind} | ${df(r.cornice.diff)} |`);
  }
  L.push('');
  L.push('¹ У дома 04 (модерн) карниза нет — сравнивается верх волнистого парапета, к которому тоже относится предел 23,5 м (общее правило 3).');
  L.push('');
  L.push('## Дополнительно');
  L.push('');
  L.push('Не входит в задание, но показывает, насколько точно повторена сама раскладка, а не только итоговые числа.');
  L.push('');
  L.push('| Тип | Положение осей: макс. сдвиг, м | Отметки этажей: макс. расхождение, м | Самый высокий карниз или парапет: альбом / генератор, м | Все проверки правил |');
  L.push('|---|--:|--:|--:|---|');
  for (const r of rows) {
    if (!r.ok) continue;
    L.push(`| ${r.id} | ${f(r.axisShift, 3)} | ${r.levelShift === null ? '—' : f(r.levelShift)} | ${f(r.limitTop.album)} / ${f(r.limitTop.gen)} | ${r.checksOk ? 'да' : 'нет'} |`);
  }
  L.push('');
  L.push('Откуда ненулевые значения:');
  L.push('');
  for (const r of rows) {
    if (!r.ok) continue;
    if (r.axisShift > 1e-9) L.push(`- **${r.id}**: оси до ${f(r.axisShift, 3)} м от осей чертежа.` + (r.id === '05' ? ' Генератор берёт подписанный шаг цепочки (3370 мм) и поля центра 2,175 м из ширины центра 21 200 мм; на чертеже оси стоят с шагом ≈3,367 м. Первая цепочка чертежа в сумме даёт 34 210 мм вместо 34 200 — расхождение самого альбома.' : ''));
    if (r.levelShift > 1e-9) L.push(`- **${r.id}**: отметки этажей до ${f(r.levelShift)} м. ${r.notes.filter((n) => /^Высоты этажей/.test(n)).join(' ')}`);
  }
  L.push('- **Самый высокий карниз или парапет** — то, к чему относится предел 23,5 м (общее правило 3). У 05 это карнизы ризалитов +21,5 (карниз центра +20,3). Аттик, аттиковый этаж, кровля и скульптура в предел не входят.');
  L.push('');
  L.push('## Что эта проверка не доказывает');
  L.push('');
  L.push('Совпадение ожидаемо: генератор параметризован размерами тех же домов. Проверка ловит ошибки раскладки (подбор числа осей и шага под ширину, сборку этажей и венчания), но не подтверждает сами размеры альбома — они остаются реконструкцией по фото с точностью ±0,5 м.');
  L.push('');
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const md = validationMarkdown();
  if (process.argv.includes('--write')) {
    writeFileSync(join(ROOT, 'docs/validation.md'), md);
    console.log('docs/validation.md записан');
  } else process.stdout.write(md);
}
