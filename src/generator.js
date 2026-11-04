/*
 * Генератор обмерных фасадов петербургских доходных домов (Адмиралтейский район).
 *
 * Размеры — из data/styles.json (альбом facades.html: реконструкция по фото и
 * контурам OSM с помощью ИИ, не натурный обмер, высоты ±0,5 м).
 * Логика — по правилам автора (my_rules.md); соответствие правил коду —
 * docs/implementation.md. Идентификаторы правил (R01.1, G1, F2, T1…) общие
 * для кода, страницы и документации.
 *
 * Без зависимостей и без сборки: подключается в браузере обычным <script>
 * (глобальный объект FacadeGenerator) и в Node через require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FacadeGenerator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;
  const W_MAX = 150; // технический предел поля ввода, м

  // ------------------------------------------------------------------ утилиты
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const fmt = (v, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',');
  const fmtMark = (z) => (Math.abs(z) < 0.0005 ? '±' : z > 0 ? '+' : '−') + Math.abs(z).toFixed(3).replace('.', ',');
  const mmStr = (v) => String(Math.round(v * 1000));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function getStyle(data, id) {
    const st = data.styles.find((s) => s.id === id || s.key === id);
    if (!st) throw new Error('Нет стиля ' + id);
    return st;
  }

  // ------------------------------------------------------------- этажность
  // Решение автора (вопрос 13): при другой этажности повторяются или убираются
  // типовые средние этажи, первый и верхний не трогаются. Какие этажи типовые —
  // техническое уточнение: средние этажи, не входящие в обязательную базу
  // (у 04 2-й этаж — часть гранитного цоколя, у 06 — рустованного).
  // Убирается и повторяется типовой этаж, ближайший к верхнему.
  // nMin — из обязательных элементов (вопрос 14); у 05 этажность фиксирована:
  // 2 этажа гранитной базы + 3 этажа ордера (+ аттиковый).
  const FLOOR_PLAN = {
    '01': { nMin: 2, typical: [2] },
    '02': { nMin: 3, typical: [2, 3] },
    '03': { nMin: 3, typical: [2, 3] },
    '04': { nMin: 3, typical: [3, 4, 5] },
    '05': { nMin: 5, nMax: 6, typical: [] },
    '06': { nMin: 3, typical: [3, 4] }
  };

  // Варианты, которые правила разрешают менять («Можно менять»), и только те,
  // для которых в альбоме есть размеры.
  function styleOptions(st) {
    switch (st.id) {
      case '02':
        return [{ key: 'step', type: 'number', label: 'Шаг осей, м', def: st.plan.axis_step_m, min: 1.2, max: 5, step: 0.01, rule: 'R02.2', hint: 'одинаковый по всему фасаду' }];
      case '03':
        return [
          { key: 'attic', type: 'bool', label: 'Аттик над центром', def: true, rule: 'R03.2' },
          { key: 'freeSymmetry', type: 'bool', label: 'Отступить от строгой симметрии (нечётное число рядовых осей)', def: false, rule: 'R03.2' }
        ];
      case '04':
        return [{ key: 'erker', type: 'bool', label: 'Эркер', def: true, rule: 'R04.2' }];
      case '06':
        return [
          { key: 'step', type: 'number', label: 'Шаг осей, м', def: st.plan.axis_step_m, min: 2, max: 5, step: 0.01, rule: 'R06.2' },
          { key: 'center', type: 'bool', label: 'Выделить центр эркером (и ордером)', def: true, rule: 'R06.2' },
          { key: 'order', type: 'bool', label: 'Колоссальный ордер', def: true, rule: 'R06.2' }
        ];
      default:
        return [];
    }
  }

  function fillOptions(st, opts) {
    const o = {};
    for (const d of styleOptions(st)) {
      const v = opts && opts[d.key];
      o[d.key] = v === undefined || v === null || v === '' ? d.def : d.type === 'number' ? Number(v) : !!v;
    }
    return o;
  }

  // ---------------------------------------------------------- высоты этажей
  // G2: «Первый этаж — самый высокий» (строго выше остальных — ответ автора на
  // вопрос 1). Высоты — из альбома; где альбом правилу не отвечает (только 02),
  // высоты задал автор: блок generator.floor_heights_m в data/styles.json.
  function floorHeights(st) {
    const album = st.section.floors.map((f) => f.height_m);
    const own = st.generator && st.generator.floor_heights_m;
    if (own) return { hs: own.slice(), source: 'author', album };
    return { hs: album, source: 'album', album };
  }

  function floorRoles(st, N) {
    const plan = FLOOR_PLAN[st.id];
    const M = st.section.floors.length;
    if (st.id === '05') {
      const roles = [1, 2, 3, 4, 5];
      if (N === 6) roles.push('attic');
      return roles;
    }
    const roles = [];
    for (let i = 1; i <= M; i++) roles.push(i);
    const typ = plan.typical;
    while (roles.length > N) {
      const r = typ.slice().reverse().find((t) => roles.includes(t));
      if (r === undefined) return null;
      roles.splice(roles.lastIndexOf(r), 1);
    }
    while (roles.length < N) {
      const r = typ[typ.length - 1];
      roles.splice(roles.lastIndexOf(r) + 1, 0, r);
    }
    return roles;
  }

  // Вертикальная схема: цоколь, этажи, промежуточные зоны, венчание.
  function buildSection(st, N) {
    const plan = FLOOR_PLAN[st.id];
    if (N < plan.nMin) return { error: `Меньше ${plan.nMin} этажей стиль не допускает: обязательные элементы требуют ${plan.nMin} этажа(ей).` };
    if (plan.nMax && N > plan.nMax) return { error: `Для стиля ${st.id} этажность ${plan.nMin}–${plan.nMax}: двухэтажная база + ордер на три этажа (+ аттиковый этаж).` };
    const roles = floorRoles(st, N);
    if (!roles) return { error: 'Нельзя подобрать этажи.' };
    const fh = floorHeights(st);
    const sec = st.section;
    let z = sec.plinth_m || 0;
    const floors = [];
    const zones = [];
    roles.forEach((role, i) => {
      let h, finish, src;
      if (role === 'attic') {
        h = null; // аттиковый этаж 05 стоит над антаблементом, добавляется ниже
        return;
      }
      src = sec.floors[role - 1];
      h = fh.hs[role - 1];
      finish = src.finish;
      floors.push({ n: i + 1, role, z0: r3(z), h, z1: r3(z + h), finish });
      z += h;
      const btw = (sec.between || []).find((b) => b.after_floor === role && i === roles.indexOf(role));
      if (btw) {
        zones.push({ name: btw.name, z0: r3(z), z1: r3(z + btw.height_m), h: btw.height_m, belt: btw.belt_m });
        z += btw.height_m;
      }
    });
    const crown = [];
    for (const c of sec.crown || []) {
      crown.push({ name: c.part, z0: r3(z), z1: r3(z + c.height_m), h: c.height_m });
      z += c.height_m;
    }
    const lastTop = floors[floors.length - 1].z1;
    const cornice = crown.length ? r3(z) : null;
    let attic = null;
    if (roles.includes('attic')) {
      const af = sec.attic_floor;
      attic = { n: N, role: 'attic', z0: r3(z), h: af.height_m, z1: r3(z + af.height_m), finish: af.finish };
      floors.push(attic);
    }
    return { roles, floors, zones, crown, cornice, lastTop, plinth: sec.plinth_m || 0, heights: fh };
  }

  // -------------------------------------------- горизонталь: раскладка осей
  function axis(x, part, kind) { return { x, part, kind: kind || part }; }

  // R01.1: пятичастная композиция; в крыле от 3 до 6 осей (решение автора,
  // 4 ноября 2026: чтобы фасад помещался на участки уже альбомных 95 м).
  // R01.2 + решение автора: портик не убирается, у него 4 / 6 / 8 колонн.
  // Перебираются все сочетания «оси крыла × колонны портика»; берётся то, где
  // шаг портика ближе всего к альбомным 3,15 м, при равенстве — больше осей в
  // крыле (ближе к альбому). Шаг крыла 3,5 м и ризалиты — как в альбоме.
  function plan01(st, W) {
    const [ris, wing, por] = st.plan.parts;
    const g = st.generator;
    const c2e = por.column_to_edge_m;
    const sMin = st.windows.portico['1'].w_m; // T2: арки аркады не пересекаются
    const cols = g.portico_columns;
    const wingW = (w) => 2 * wing.margin_m + (w - 1) * wing.axis_step_m;
    let best = null;
    for (let w = g.wing_axes_max; w >= g.wing_axes_min; w--) {
      const P = W - 2 * ris.width_m - 2 * wingW(w);
      for (const c of cols) {
        const n = c - 1;
        const s = (P - 2 * c2e) / n;
        if (s < sMin - EPS) continue;
        const d = Math.abs(s - por.axis_step_m);
        if (!best || d < best.d - EPS) best = { n, s, d, w, P };
      }
    }
    if (!best) {
      const minW = 2 * ris.width_m + 2 * wingW(g.wing_axes_min) + 2 * c2e + (Math.min(...cols) - 1) * sMin;
      return { error: `Ширина мала для пятичастной композиции: при ${g.wing_axes_min} осях в крыле и портике с ${Math.min(...cols)} колоннами фасад не уже ${fmt(minW, 2)} м.` };
    }
    const axes = [];
    const parts = [];
    let x = 0;
    const pushPart = (kind, name, width) => { parts.push({ kind, name, x0: r3(x), x1: r3(x + width) }); x += width; };
    const WW = wingW(best.w);
    // левый ризалит
    for (let i = 0; i < ris.axes; i++) axes.push(axis(x + ris.margin_outer_m + i * ris.axis_step_m, 'risalit'));
    pushPart('risalit', ris.name, ris.width_m);
    for (let i = 0; i < best.w; i++) axes.push(axis(x + wing.margin_m + i * wing.axis_step_m, 'wing'));
    pushPart('wing', wing.name, WW);
    const pm = c2e + best.s / 2;
    for (let i = 0; i < best.n; i++) axes.push(axis(x + pm + i * best.s, 'portico'));
    const portico = { x0: r3(x), x1: r3(x + best.P), spans: best.n, step: r3(best.s), columns: best.n + 1, c2e };
    pushPart('portico', por.name, best.P);
    for (let i = 0; i < best.w; i++) axes.push(axis(x + wing.margin_m + i * wing.axis_step_m, 'wing'));
    pushPart('wing', wing.name, WW);
    for (let i = 0; i < ris.axes; i++) axes.push(axis(x + ris.margin_inner_m + i * ris.axis_step_m, 'risalit'));
    pushPart('risalit', ris.name, ris.width_m);
    return { axes, parts, portico, wingAxes: best.w, stepInfo: `осей в крыле: ${best.w}, шаг ${fmt(wing.axis_step_m)} · ризалиты ${fmt(ris.axis_step_m)} · портик ${fmt(best.s, 3)} м, колонн: ${best.n + 1}` };
  }

  // Рядовой фасад с одинаковым шагом (02, 06): число осей подбирается так,
  // чтобы шаг был ближе всего к заданному (R02.2, R06.2), поля у краёв — из альбома.
  function planRow(st, W, target, constraint) {
    const e = st.plan.edge_margin_m;
    const span = W - 2 * e;
    if (span <= 0) return { error: `Ширина меньше двух полей у краёв (${fmt(2 * e)} м).` };
    const cands = [];
    const n0 = Math.round(span / target) + 1;
    // перебираются все числа осей; первым идёт шаг, ближайший к заданному,
    // дальше — следующие по близости, пока проёмы не поместятся (T2)
    for (let n = 2; n <= n0 + 4; n++) {
      if (!constraint(n)) continue;
      const s = span / (n - 1);
      cands.push({ n, s, d: Math.abs(s - target) });
    }
    cands.sort((a, b) => a.d - b.d);
    return { e, cands };
  }

  function rowAxes(W, e, n) {
    const s = (W - 2 * e) / (n - 1);
    const axes = [];
    for (let i = 0; i < n; i++) axes.push(axis(e + i * s, 'row'));
    return { axes, step: s };
  }

  // 03: узкий центральный ризалит фиксированной ширины (R03.1), рядовые оси
  // с шагом альбома; остаток ширины уходит в крайние поля (T5).
  function plan03(st, W, o) {
    const side = st.plan.side;
    const c = st.plan.center;
    const fixedSide = side.margin_outer_m + side.margin_inner_m;
    const free = W - c.width_m - 2 * fixedSide;
    if (free < -EPS) return { error: `Ширина мала: нужно не меньше ${fmt(c.width_m + 2 * fixedSide)} м (ризалит и по одной рядовой оси).` };
    let nl, nr, rem;
    if (!o.freeSymmetry) {
      const per = Math.floor(free / 2 / side.axis_step_m + EPS);
      nl = nr = per + 1;
      rem = free - 2 * per * side.axis_step_m;
    } else {
      const M = Math.floor(free / side.axis_step_m + EPS);
      nl = Math.floor(M / 2) + 1;
      nr = M - Math.floor(M / 2) + 1;
      rem = free - M * side.axis_step_m;
    }
    const outer = side.margin_outer_m + rem / 2;
    const axes = [];
    const parts = [];
    let x = 0;
    const wl = outer + (nl - 1) * side.axis_step_m + side.margin_inner_m;
    for (let i = 0; i < nl; i++) axes.push(axis(outer + i * side.axis_step_m, 'side'));
    parts.push({ kind: 'side', name: 'рядовые оси', x0: 0, x1: r3(wl) });
    x = wl;
    const cx = x + c.width_m / 2;
    axes.push(axis(cx, 'center'));
    parts.push({ kind: 'center', name: 'ризалит', x0: r3(x), x1: r3(x + c.width_m) });
    x += c.width_m;
    for (let i = 0; i < nr; i++) axes.push(axis(x + side.margin_inner_m + i * side.axis_step_m, 'side'));
    parts.push({ kind: 'side', name: 'рядовые оси', x0: r3(x), x1: r3(W) });
    return { axes, parts, center: { x0: r3(wl), x1: r3(wl + c.width_m), cx: r3(cx) }, nl, nr, stepInfo: `рядовые ${fmt(side.axis_step_m)} м, ризалит ${fmt(c.width_m)} м` };
  }

  // 04: оси разной ширины (R04.1). Решение автора (вопрос 10): фасад растёт
  // осями средней ширины (окно 1,6 м) с той стороны, где эркер дальше от края,
  // чтобы эркер оставался не по центру; осей 3–6. Технические уточнения:
  // добавленные оси ставятся у этого края с шагом 3,95 м (расстояние от эркера
  // до средней оси альбома); для 3 осей убирается средняя ось с ближней к
  // эркеру стороны вместе с её входом; затем все расстояния масштабируются
  // под заданную ширину (k), ширины окон не меняются.
  function plan04(st, W, n) {
    const Wa = st.album.width_m;
    const gen = st.generator;
    const er = st.plan.axes.find((a) => a.erker);
    const hw = st.erker.w_m / 2;
    const farLeft = er.x_m > Wa - er.x_m;
    const medAlbum = st.plan.axes.find((a) => a.kind === gen.add_axis_kind);
    const p = gen.add_axis_pitch_m;
    let axes = st.plan.axes.map((a) => ({ x: a.x_m, src: a }));
    const owner = (x) => st.plan.axes.reduce((b, a) => (Math.abs(a.x_m - x) < Math.abs(b.x_m - x) ? a : b));
    let ground = st.ground_floor.map((g) => ({ g, x: g.x_m, owner: owner(g.x_m) }));
    let Wb = Wa, shift = 0, added = 0, removed = 0;
    if (n > axes.length) {
      added = n - axes.length;
      const addSrc = { axis: 'add', kind: gen.add_axis_kind, window_w_m: gen.add_axis_window_w_m, windowsKey: 'axis' + medAlbum.axis, added: true };
      const extra = [];
      if (farLeft) {
        shift = added * p;
        for (let i = 0; i < added; i++) extra.push({ x: axes[0].x + i * p, src: addSrc });
        axes = extra.concat(axes.map((a) => ({ x: a.x + shift, src: a.src })));
        ground = ground.map((q) => Object.assign({}, q, { x: q.x + shift }));
      } else {
        const last = axes[axes.length - 1].x;
        for (let i = 0; i < added; i++) extra.push({ x: last + (i + 1) * p, src: addSrc });
        axes = axes.concat(extra);
      }
      Wb = Wa + added * p;
    } else if (n < axes.length) {
      removed = axes.length - n;
      const near = farLeft ? axes.slice().reverse() : axes.slice();
      for (let r = 0; r < removed; r++) {
        const outer = near[r];
        if (outer.src.kind !== gen.add_axis_kind) return { error: 'Меньше осей нельзя: убрать можно только среднюю ось у края.' };
        const inner = near[r + 1];
        const d = Math.abs(outer.x - inner.x);
        axes = axes.filter((a) => a !== outer);
        ground = ground.filter((q) => q.owner !== outer.src);
        if (!farLeft) { axes = axes.map((a) => ({ x: a.x - d, src: a.src })); ground = ground.map((q) => Object.assign({}, q, { x: q.x - d })); }
        Wb -= d;
      }
    }
    const k = W / Wb;
    const exB = axes.find((a) => a.src.erker).x;
    // профиль парапета: левая часть до эркера, эркер и правая часть — по своим якорям
    const A = [0, er.x_m - hw, er.x_m + hw, Wa];
    const B = [0, exB - hw, exB + hw, Wb];
    const mapX = (x) => {
      for (let i = 0; i < 3; i++) if (x <= A[i + 1] + EPS || i === 2) return (B[i] + (x - A[i]) * (B[i + 1] - B[i]) / (A[i + 1] - A[i])) * k;
      return x * k;
    };
    const out = axes.map((a) => ({ x: r3(a.x * k), part: a.src.erker ? 'erker' : a.src.added ? 'added' : 'axis' + a.src.axis, kind: a.src.kind, src: a.src }));
    const info = (added ? `добавлено средних осей: ${added}` : removed ? `убрано средних осей: ${removed}` : 'оси альбома') + `, всего осей: ${out.length}; расстояния ×${fmt(k, 3)}`;
    return {
      axes: out, parts: [{ kind: 'all', name: 'фасад', x0: 0, x1: W }], k, added, removed,
      ground: ground.map((q) => Object.assign({}, q.g, { x: r3(q.x * k) })),
      parapet: st.parapet.profile_m.map(([x, dz]) => [r3(mapX(x)), dz]),
      stepInfo: 'оси разной ширины; ' + info
    };
  }

  function plans04(st, W) {
    const g = st.generator;
    const list = [];
    for (let n = g.axes_min; n <= g.axes_max; n++) {
      const pl = plan04(st, W, n);
      if (!pl.error) list.push(pl);
    }
    return list.sort((a, b) => Math.abs(Math.log(a.k)) - Math.abs(Math.log(b.k)));
  }

  // 05: два боковых ризалита фиксированной ширины (R05.1), в центре оси
  // с шагом альбома; остаток — в поля центра (T5).
  function plan05(st, W) {
    const R = st.plan.risalit.width_m;
    const C = st.plan.center;
    const free = W - 2 * R - 2 * C.margin_m;
    if (free < -EPS) return { error: `Ширина мала: нужно не меньше ${fmt(2 * R + 2 * C.margin_m)} м (два ризалита и одна ось центра).` };
    const nc = Math.floor(free / C.axis_step_m + EPS) + 1;
    const rem = free - (nc - 1) * C.axis_step_m;
    const m = C.margin_m + rem / 2;
    const axes = [axis(R / 2, 'risalit')];
    for (let i = 0; i < nc; i++) axes.push(axis(R + m + i * C.axis_step_m, 'center'));
    axes.push(axis(W - R / 2, 'risalit'));
    const parts = [
      { kind: 'risalit', name: 'ризалит', x0: 0, x1: R },
      { kind: 'center', name: 'центр', x0: R, x1: r3(W - R) },
      { kind: 'risalit', name: 'ризалит', x0: r3(W - R), x1: r3(W) }
    ];
    return { axes, parts, nc, step: C.axis_step_m, stepInfo: `центр ${fmt(C.axis_step_m)} м (${nc} осей), ризалиты ${fmt(R)} м` };
  }

  // ------------------------------------------------------------ элементы
  function mkCtx(st, W, sec) {
    const E = [];
    const add = (el) => { el.style = st.id; E.push(el); return el; };
    const fl = (role) => sec.floors.find((f) => f.role === role);
    const fls = (role) => sec.floors.filter((f) => f.role === role);
    return { E, add, fl, fls, W, st, sec };
  }

  function opening(ctx, spec, floor, x, extra) {
    if (!spec) return null;
    const o = Object.assign({
      type: 'opening', kind: 'window', x: r3(x), w: spec.w_m, h: spec.h_m,
      z0: r3(floor.z0 + spec.sill_above_floor_m), shape: spec.shape, floor: floor.n,
      mullions: spec.mullions || 1, frame: 'plain'
    }, extra || {});
    return ctx.add(o);
  }

  function sandrik(ctx, win, kind, w, h, gap) {
    if (!kind) return;
    ctx.add({ type: 'sandrik', shape: kind, x: win.x, w: w || win.w + 0.4, h: h || 0.3, z0: r3(win.z0 + win.h + (gap === undefined ? 0.13 : gap)) });
  }

  function belts(ctx, list, x0, x1) {
    for (const b of list || []) {
      let z;
      if (b.at === 'z') z = b.z_m;
      else {
        const f = ctx.sec.floors.find((q) => q.role === b.floor);
        if (!f) continue;
        // пояс «между этажами» имеет смысл, только если над этим этажом есть следующий
        if (f === ctx.sec.floors[ctx.sec.floors.length - 1]) continue;
        z = f.z1 + b.z_offset_m;
      }
      ctx.add({ type: 'belt', x0, x1, z0: r3(z), z1: b.height_m ? r3(z + b.height_m) : r3(z), weight: b.weight, name: b.name });
    }
  }

  // Вынос карниза на чертеже условный (в альбоме дан только у 06: ≈1 м);
  // inner — венчание между ризалитами, без выноса в стороны.
  function crownEls(ctx, x0, x1, kindHint, inner) {
    ctx.sec.crown.forEach((c, i) => {
      const last = i === ctx.sec.crown.length - 1;
      const proj = inner ? 0 : last ? 0.6 : i === 0 ? 0 : 0.15;
      ctx.add({ type: 'crown', x0, x1, z0: c.z0, z1: c.z1, name: c.name, projection: proj, kindHint, last, limited: true });
    });
  }

  function roofEl(ctx, spec, x0, x1, zBase) {
    if (!spec) return;
    ctx.add({ type: 'roof', pts: [[x0 + spec.bottom_inset_m, zBase], [x1 - spec.bottom_inset_m, zBase], [x1 - spec.top_inset_m, zBase + spec.height_m], [x0 + spec.top_inset_m, zBase + spec.height_m]].map((p) => [r3(p[0]), r3(p[1])]), name: spec.kind });
  }

  function balconyEl(ctx, b, x, floor) {
    const z0 = floor.z0 + (b.slab_z_above_floor_m || 0);
    const slabTop = z0 + (b.slab_h_m || 0);
    ctx.add({ type: 'balcony', x0: r3(x - b.w_m / 2), x1: r3(x + b.w_m / 2), z0: r3(z0), z1: r3(slabTop), railTop: r3(slabTop + b.rail_h_m), rail: b.rail, floor: floor.n });
  }

  // ---------------------------------------------------------------- стиль 01
  function build01(st, W, N, sec, plan) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    const cornice = sec.cornice;
    const por = plan.portico;
    add({ type: 'wall', x0: 0, x1: W, z0: 0, z1: cornice, limited: true });
    add({ type: 'plinth', x0: 0, x1: W, z0: 0, z1: sec.plinth, name: st.section.plinth_finish });
    const f1 = ctx.fl(1);
    add({ type: 'rust', pattern: 'band', x0: 0, x1: W, z0: f1.z0, z1: f1.z1, course: st.section.floors[0].rust_course_m, floor: 1 });
    // портик: выступающий объём первого этажа с аркадой, подиум
    add({ type: 'block', x0: por.x0, x1: por.x1, z0: 0, z1: f1.z1, name: 'портик над аркадой' });
    for (const p of plan.parts.filter((q) => q.kind === 'risalit')) add({ type: 'block', x0: p.x0, x1: p.x1, z0: 0, z1: cornice, name: 'угловой ризалит' });
    add({ type: 'plinth', x0: por.x0, x1: por.x1, z0: 0, z1: st.portico_podium_m, name: 'подиум портика' });
    // пояс и стилобат
    const zn = sec.zones[0];
    add({ type: 'belt', x0: 0, x1: W, z0: zn.z0, z1: r3(zn.z0 + zn.belt), weight: 'strong', name: 'мощный пояс' });
    add({ type: 'belt', x0: 0, x1: W, z0: r3(zn.z0 + zn.belt), z1: zn.z1, weight: 'stylobate', name: 'стилобат с балюстрадами' });
    // окна
    const win = st.windows.row;
    for (const [i, a] of plan.axes.entries()) {
      for (const f of sec.floors) {
        const spec = win[String(f.role)];
        if (f.role === 1 && a.part === 'portico') {
          opening(ctx, st.windows.portico['1'], f, a.x, { axis: i + 1, kind: 'arcade', frame: 'arcade' });
          continue;
        }
        const w = opening(ctx, spec, f, a.x, { axis: i + 1, frame: f.role === 1 ? 'fan' : 'plain' });
        if (spec.sandrik) sandrik(ctx, w, spec.sandrik, spec.sandrik_w_m, spec.sandrik_h_m, spec.sandrik_gap_m);
      }
    }
    // R01.1: ордер стоит на рустованном первом этаже; колонны портика и in antis в ризалитах
    const oz0 = sec.floors[1].z0;
    const oz1 = sec.lastTop;
    const capH = Math.min(1.0, (oz1 - oz0) * 0.11);
    for (let k = 0; k <= por.spans; k++) {
      add({ type: 'column', kind: 'column', x: r3(por.x0 + por.c2e + k * por.step), w: st.order.portico.diameter_m, z0: oz0, z1: oz1, capH, order: st.order.type });
    }
    const ra = plan.axes.filter((a) => a.part === 'risalit');
    const rr = st.order.risalit;
    const risL = plan.parts[0], risR = plan.parts[4];
    for (const [a, b] of [[ra[0], ra[1]], [ra[1], ra[2]], [ra[3], ra[4]], [ra[4], ra[5]]]) {
      add({ type: 'column', kind: 'column', x: r3((a.x + b.x) / 2), w: rr.diameter_m, z0: oz0, z1: oz1, capH, order: st.order.type });
    }
    for (const x of [risL.x0 + rr.pylon_pilaster_x_m, risL.x0 + rr.inner_pilaster_x_m, risR.x1 - rr.inner_pilaster_x_m, risR.x1 - rr.pylon_pilaster_x_m]) {
      add({ type: 'column', kind: 'pilaster', x: r3(x), w: rr.pilaster_w_m, z0: oz0, z1: oz1, capH, order: st.order.type });
    }
    crownEls(ctx, 0, W);
    roofEl(ctx, st.section.roof, 0, W, cornice);
    // аттик и скульптура над портиком
    const at = st.attic;
    const cx = (por.x0 + por.x1) / 2;
    const atTop = cornice + at.height_m;
    // технически: аттик не шире колоннады портика — при узком портике ширины
    // аттика и скульптуры уменьшаются пропорционально (высоты как в альбоме)
    const f = Math.min(1, ((por.x1 - por.x0) / 2 - por.c2e) / at.half_width_m);
    add({ type: 'attic', parts: [{ x0: r3(cx - f * at.half_width_m), x1: r3(cx + f * at.half_width_m), z0: cornice, z1: r3(atTop - 0.18) }, { x0: r3(cx - f * at.cap_half_width_m), x1: r3(cx + f * at.cap_half_width_m), z0: r3(atTop - 0.18), z1: r3(atTop) }], name: 'аттик над портиком' });
    const sculTop = cornice + (at.sculpture_top_m - st.album.cornice_m);
    add({ type: 'sculpture', x0: r3(cx - f * at.sculpture_half_width_m), x1: r3(cx + f * at.sculpture_half_width_m), z0: r3(atTop), z1: r3(sculTop), name: 'скульптурная группа' });
    return ctx.E;
  }

  // ---------------------------------------------------------------- стиль 02
  function build02(st, W, N, sec, plan) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    add({ type: 'wall', x0: 0, x1: W, z0: 0, z1: sec.cornice, limited: true });
    add({ type: 'plinth', x0: 0, x1: W, z0: 0, z1: sec.plinth, name: st.section.plinth_finish });
    const f1 = ctx.fl(1);
    // R02.1: руст только на первом этаже
    add({ type: 'rust', pattern: 'band', x0: 0, x1: W, z0: f1.z0, z1: r3(f1.z1 - 0.15), course: st.section.floors[0].rust_course_m, floor: 1 });
    belts(ctx, st.belts, 0, W);
    const n = plan.axes.length;
    const gate = st.gate;
    let gateAxes;
    if (n % 2 === 0) gateAxes = [n / 2 - 1, n / 2];
    else gateAxes = [(n - 1) / 2];
    const gx = gateAxes.length === 2 ? (plan.axes[gateAxes[0]].x + plan.axes[gateAxes[1]].x) / 2 : plan.axes[gateAxes[0]].x;
    for (const [i, a] of plan.axes.entries()) {
      for (const f of sec.floors) {
        const spec = st.windows.row[String(f.role)];
        if (f.role === 1 && i === 0) {
          const d = st.doors[0];
          add({ type: 'opening', kind: 'door', x: a.x, w: d.w_m, z0: d.z0_m, h: r3(d.top_m - d.z0_m), shape: d.shape, floor: 1, axis: 1 });
          continue;
        }
        if (f.role === 1 && gateAxes.includes(i)) continue;
        // R02.3: «высокий нарядный третий этаж» не берётся: окна 3-го этажа без сандриков и филёнок
        opening(ctx, spec, f, a.x, { axis: i + 1, frame: f.role === 1 ? 'arch' : f.role === 2 ? 'sill-brackets' : 'plain' });
      }
    }
    add({ type: 'opening', kind: 'gate', x: r3(gx), w: gate.w_m, z0: 0, h: gate.h_m, shape: gate.shape, floor: 1, axis: null });
    crownEls(ctx, 0, W, 'dentils');
    roofEl(ctx, st.section.roof, 0, W, sec.cornice);
    return ctx.E;
  }

  // ---------------------------------------------------------------- стиль 03
  function build03(st, W, N, sec, plan, o) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    const cen = plan.center;
    const C = st.plan.center;
    add({ type: 'wall', x0: 0, x1: W, z0: 0, z1: sec.cornice, limited: true });
    add({ type: 'plinth', x0: 0, x1: W, z0: 0, z1: sec.plinth, name: st.section.plinth_finish });
    add({ type: 'block', x0: cen.x0, x1: cen.x1, z0: sec.plinth, z1: sec.cornice, name: 'центральный ризалит' });
    belts(ctx, st.belts, 0, W);
    // G6: рустованы лопатки центрального ризалита
    const fTop = sec.floors[sec.floors.length - 1];
    const z0l = sec.floors[1].z0;
    for (const [x0, x1] of [[cen.x0, cen.x0 + C.lopatka_w_m], [cen.x1 - C.lopatka_w_m, cen.x1]]) {
      add({ type: 'lopatka', x0: r3(x0), x1: r3(x1), z0: z0l, z1: fTop.z1, rust: true, course: C.rust_course_m });
    }
    const ci = plan.axes.findIndex((a) => a.part === 'center');
    const firstExtreme = 0, lastExtreme = plan.axes.length - 1;
    const doorAxis = ci - 1; // R03: вход — по оси слева от ризалита (как в альбоме)
    const ex = st.extreme_axes;
    // фронтоны крайних осей — на предпоследнем этаже, как в альбоме (3-й из 4)
    const pedFloor = sec.floors[sec.floors.length - 2];
    for (const [i, a] of plan.axes.entries()) {
      for (const f of sec.floors) {
        if (a.part === 'center') {
          const spec = st.windows.center[String(f.role)];
          if (!spec) continue;
          for (const s of [-1, 1]) opening(ctx, spec, f, a.x + s * C.paired_offset_m, { axis: i + 1, frame: 'plain', paired: true, kind: f.role === 4 ? 'door' : 'window' });
          continue;
        }
        const spec = st.windows.row[String(f.role)];
        if (f.role === 1 && i === doorAxis) {
          const d = st.doors[0];
          add({ type: 'opening', kind: 'door', x: a.x, w: d.w_m, z0: r3(d.z0_m), h: r3(d.top_m - d.z0_m), shape: d.shape, floor: 1, axis: i + 1 });
          continue;
        }
        // R03.3: одно обрамление окон на всех этажах (без поэтажных сандриков, архивольтов)
        const w = opening(ctx, spec, f, a.x, { axis: i + 1, frame: 'plain' });
        // R03.1: крайние оси отмечены лучковыми фронтонами
        if (f === pedFloor && (i === firstExtreme || i === lastExtreme)) {
          add({ type: 'sandrik', shape: 'segment', x: a.x, w: ex.pediment_w_m, h: ex.pediment_h_m, z0: r3(w.z0 + w.h + ex.gap_above_window_m), consoles: true, name: 'лучковый фронтон' });
        }
      }
    }
    const g = st.gate;
    add({ type: 'opening', kind: 'gate', x: cen.cx, w: g.w_m, z0: 0, h: g.h_m, shape: g.shape, floor: 1, axis: ci + 1, frameW: g.frame_w_m });
    // R03.1: балкон с кованой решёткой в центре (этаж альбома — 4-й, верхний)
    const bf = ctx.fl(st.balconies[0].floor) || fTop;
    balconyEl(ctx, st.balconies[0], cen.cx, bf);
    crownEls(ctx, 0, W, 'brackets');
    roofEl(ctx, st.section.roof, 0, W, sec.cornice);
    if (o.attic) {
      const at = st.attic;
      const z = sec.cornice;
      const z1 = z + at.base_h_m, z2 = z1 + at.cornice_h_m, z3 = z2 + at.step_h_m;
      add({ type: 'attic', name: 'ступенчатый аттик с полуциркульным фронтоном', parts: [
        { x0: r3(cen.cx - at.base_w_m / 2), x1: r3(cen.cx + at.base_w_m / 2), z0: z, z1: r3(z1) },
        { x0: r3(cen.cx - at.cornice_w_m / 2), x1: r3(cen.cx + at.cornice_w_m / 2), z0: r3(z1), z1: r3(z2) },
        { x0: r3(cen.cx - at.step_w_m / 2), x1: r3(cen.cx + at.step_w_m / 2), z0: r3(z2), z1: r3(z3) }
      ], arch: { x: cen.cx, r: at.pediment_r_m, z0: r3(z3) } });
    }
    return ctx.E;
  }

  // ---------------------------------------------------------------- стиль 04
  function build04(st, W, N, sec, plan, o) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    const top = sec.lastTop;
    // волнистый парапет вместо карниза (R04.1); профиль привязан к эркеру и краям
    const prof = plan.parapet.map(([x, dz]) => [x, r3(top + dz)]);
    add({ type: 'wall', x0: 0, x1: W, z0: 0, z1: top, outline: [[0, 0]].concat(prof).concat([[W, 0]]) });
    add({ type: 'parapet', pts: prof, limited: true, name: st.parapet.kind + ' парапет' });
    // R04.1: два нижних этажа — единый цоколь из рваного гранита
    const gTop = st.section.granite_top_m;
    add({ type: 'rust', pattern: 'rough', x0: 0, x1: W, z0: 0, z1: gTop, course: st.section.floors[0].rust_course_m, floor: '1–2' });
    belts(ctx, st.belts, 0, W);
    // 1-й этаж и люнет альбома идут вместе со своими осями (вход один — у
    // средней оси альбома); под добавленными осями — витрины, см. ниже
    for (const g of plan.ground) {
      if (g.kind === 'lunette') {
        add({ type: 'opening', kind: 'window', x: g.x, w: g.w_m, z0: g.z0_m, h: g.h_m, shape: 'lunette', floor: 2 });
        continue;
      }
      add({ type: 'opening', kind: g.kind, x: g.x, w: g.w_m, z0: g.z0_m, h: g.h_m, shape: g.shape, floor: 1 });
    }
    const erkerOn = o.erker;
    for (const [i, a] of plan.axes.entries()) {
      const key = a.src.erker ? 'erker' : a.src.windowsKey || 'axis' + a.src.axis;
      const specs = st.windows[key];
      for (const f of sec.floors) {
        if (f.role === 1) continue;
        const spec = specs[String(f.role)];
        if (!spec) continue;
        if (a.src.erker) {
          opening(ctx, spec, f, a.x, { axis: i + 1, onErker: erkerOn });
          if (erkerOn && spec.side_w_m) {
            for (const s of [-1, 1]) opening(ctx, { shape: 'rect', w_m: spec.side_w_m, h_m: spec.h_m, sill_above_floor_m: spec.sill_above_floor_m }, f, a.x + s * spec.side_offset_m, { axis: i + 1, onErker: true, side: true });
          }
          continue;
        }
        opening(ctx, spec, f, a.x, { axis: i + 1, mullions: spec.mullions || 1 });
      }
      // решение автора: под добавленными осями на 1–2-м этажах — витрины в
      // гранитном цоколе, а не глухая стена
      if (a.src.added) {
        for (const f of sec.floors.filter((q) => q.role === 1 || q.role === 2)) {
          const v = st.generator.added_axis_base[String(f.role)];
          opening(ctx, v, f, a.x, { axis: i + 1, kind: 'vitrine', frame: 'none', mullions: 2 });
        }
      }
    }
    if (erkerOn) {
      const er = st.erker;
      const ax = plan.axes.find((a) => a.src.erker);
      const f3 = sec.floors.find((f) => f.role >= er.from_floor);
      const z1 = r3(top + er.top_above_last_floor_m);
      add({ type: 'erker', shape: 'round', x0: r3(ax.x - er.w_m / 2), x1: r3(ax.x + er.w_m / 2), z0: f3.z0, z1, limited: true, bands: sec.floors.filter((f) => f.z0 > f3.z0 + EPS).map((f) => f.z0) });
      add({ type: 'console', x0: r3(ax.x - er.w_m / 2), x1: r3(ax.x + er.w_m / 2), z0: r3(f3.z0 - er.console_h_m), z1: f3.z0 });
      add({ type: 'brow', x0: r3(ax.x - er.brow.w_m / 2), x1: r3(ax.x + er.brow.w_m / 2), z0: z1, rise: er.brow.rise_m, name: 'бровка над эркером (кровля)' });
    }
    const fb = st.balconies[0];
    const ax2 = plan.axes.find((a) => a.src.axis === 2);
    const bfl = ctx.fl(fb.floor);
    if (bfl) balconyEl(ctx, fb, ax2.x, bfl);
    return ctx.E;
  }

  // ---------------------------------------------------------------- стиль 05
  function build05(st, W, N, sec, plan) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    const R = st.plan.risalit.width_m;
    const rc = st.section.risalit_crown;
    const f5 = ctx.fl(5);
    const rTop = r3(f5.z1 + rc.top_above_m);
    add({ type: 'wall', x0: R, x1: r3(W - R), z0: 0, z1: sec.cornice, limited: true });
    for (const [x0, x1] of [[0, R], [W - R, W]]) add({ type: 'wall', x0: r3(x0), x1: r3(x1), z0: 0, z1: rTop, limited: true, name: 'ризалит' });
    const attic = ctx.fl('attic');
    if (attic) add({ type: 'attic-floor', x0: R, x1: r3(W - R), z0: attic.z0, z1: attic.z1, name: 'аттиковый этаж' });
    // R05.1: двухэтажная база из рваного гранита
    add({ type: 'rust', pattern: 'rough', x0: 0, x1: W, z0: 0, z1: st.section.granite_top_m, course: st.section.floors[0].rust_course_m, floor: '1–2' });
    belts(ctx, st.belts, 0, W);
    // R05.1: колоссальный ордер на три этажа (пилястры центра)
    const oz0 = ctx.fl(3).z0, oz1 = f5.z1;
    const ca = plan.axes.filter((a) => a.part === 'center');
    const s = plan.step;
    const pil = [];
    for (let i = 0; i < ca.length; i++) pil.push(ca[i].x - s / 2);
    pil.push(ca[ca.length - 1].x + s / 2);
    for (const x of pil) add({ type: 'column', kind: 'pilaster', x: r3(x), w: st.order.pilaster_w_m, z0: oz0, z1: oz1, capH: st.order.capital_h_m, order: st.order.type });
    // лопатки ризалитов
    const lw = st.plan.risalit.lopatka_w_m;
    for (const [x0, x1] of [[0, lw], [R - lw, R], [W - R, W - R + lw], [W - lw, W]]) add({ type: 'lopatka', x0: r3(x0), x1: r3(x1), z0: oz0, z1: r3(f5.z1 + rc.lopatka_top_above_m), rust: false });
    // антаблемент центра и венчание ризалитов
    crownEls(ctx, R, r3(W - R), 'dentils', true);
    for (const [x0, x1] of [[0, R], [W - R, W]]) {
      add({ type: 'crown', x0: r3(x0), x1: r3(x1), z0: r3(f5.z1 + rc.frieze_m[0]), z1: r3(f5.z1 + rc.frieze_m[1]), name: 'фриз ризалита с картушем', projection: 0, limited: true });
      add({ type: 'crown', x0: r3(x0), x1: r3(x1), z0: r3(f5.z1 + rc.cornice_m[0]), z1: r3(f5.z1 + rc.cornice_m[1]), name: 'карниз ризалита на кронштейнах', projection: rc.cornice_projection_m, limited: true });
    }
    // окна центра; R05: проезд под 3-й осью центра
    const passIdx = Math.min(3, ca.length) - 1;
    for (const [j, a] of ca.entries()) {
      const i = plan.axes.indexOf(a);
      for (const f of sec.floors) {
        if (f.role === 1 && j === passIdx) continue;
        opening(ctx, st.windows.center[String(f.role)], f, a.x, { axis: i + 1, frame: 'none' });
      }
    }
    const gate = st.gate;
    add({ type: 'opening', kind: 'gate', x: ca[passIdx].x, w: gate.w_m, z0: 0, h: gate.h_m, shape: gate.shape, floor: 1, axis: plan.axes.indexOf(ca[passIdx]) + 1, name: 'проезд' });
    // ризалиты: порталы с фронтонами (R05.1), тройные окна, балконы
    const P = st.portal;
    for (const a of [plan.axes[0], plan.axes[plan.axes.length - 1]]) {
      const i = plan.axes.indexOf(a);
      add({ type: 'portal', x: a.x, w: P.w_m, pilW: P.pilaster_w_m, pilOff: P.pilaster_offset_m, h: P.h_m, lintelH: P.lintel_h_m, pedW: P.pediment_w_m, pedH: P.pediment_h_m });
      add({ type: 'opening', kind: 'door', x: a.x, w: P.door_w_m, z0: P.door_z0_m, h: P.door_h_m, shape: 'rect', floor: 1, axis: i + 1 });
      for (const f of sec.floors) {
        if (f.role === 1 || f.role === 'attic') continue;
        const spec = st.windows.risalit[String(f.role)];
        const w = opening(ctx, spec, f, a.x, { axis: i + 1 });
        if (spec.sandrik) sandrik(ctx, w, spec.sandrik, spec.sandrik_w_m, spec.sandrik_h_m, spec.sandrik_gap_m);
      }
      for (const b of st.balconies) balconyEl(ctx, b, a.x, ctx.fl(b.floor));
    }
    // кровля
    const rs = st.section.roof;
    roofEl(ctx, rs, R, r3(W - R), attic ? attic.z1 : sec.cornice);
    roofEl(ctx, rs.risalit, 0, R, rTop);
    roofEl(ctx, rs.risalit, r3(W - R), W, rTop);
    return ctx.E;
  }

  // ---------------------------------------------------------------- стиль 06
  function build06(st, W, N, sec, plan, o) {
    const ctx = mkCtx(st, W, sec);
    const { add } = ctx;
    add({ type: 'wall', x0: 0, x1: W, z0: 0, z1: sec.cornice, limited: true });
    add({ type: 'plinth', x0: 0, x1: W, z0: 0, z1: sec.plinth, name: st.section.plinth_finish });
    const f2 = ctx.fl(2);
    // R06.1: руст на первых двух этажах как цоколь
    add({ type: 'rust', pattern: 'band', x0: 0, x1: W, z0: sec.plinth, z1: f2.z1, course: st.section.floors[0].rust_course_m, floor: '1–2' });
    belts(ctx, st.belts, 0, W);
    const n = plan.axes.length;
    const c = o.center ? (n - 1) / 2 : -1;
    const fTop = sec.floors[sec.floors.length - 1];
    for (const [i, a] of plan.axes.entries()) {
      for (const f of sec.floors) {
        const role = String(f.role);
        if (f.role === 1 && i === 0) continue; // ворота на 1-й оси
        if (f.role === 1 && i === (o.center ? c : Math.floor(n / 2))) continue; // вход по центральной оси
        if (o.center && i === c && f.role >= st.erker.from_floor) {
          const spec = st.windows.erker[role] || st.windows.erker['5'];
          opening(ctx, spec, f, a.x, { axis: i + 1, onErker: true });
          for (const s of [-1, 1]) opening(ctx, { shape: 'rect', w_m: spec.side_w_m, h_m: spec.h_m, sill_above_floor_m: spec.sill_above_floor_m }, f, a.x + s * spec.side_offset_m, { axis: i + 1, onErker: true, side: true });
          continue;
        }
        if (o.center && (i === c - 1 || i === c + 1) && f.role >= 3) {
          let spec = st.windows.center_side[role];
          // R06.3: балконы с балюстрадой не берутся — дверь на балкончик 4-го этажа
          // заменяется окном: ширина как у соседних окон этой оси, высота и подоконник — как у окон 4-го этажа
          if (f.role === 4) spec = { shape: 'rect', w_m: spec.w_m, h_m: st.windows.row['4'].h_m, sill_above_floor_m: st.windows.row['4'].sill_above_floor_m };
          const w = opening(ctx, spec, f, a.x, { axis: i + 1 });
          if (f.role === fTop.role && st.windows.center_side['5'].medallion_d_m) {
            const m = st.windows.center_side['5'];
            add({ type: 'medallion', x: a.x, z: r3(w.z0 + w.h + m.medallion_gap_m + m.medallion_d_m / 2), d: m.medallion_d_m });
          }
          continue;
        }
        opening(ctx, st.windows.row[role], f, a.x, { axis: i + 1, frame: f.role === 1 ? 'fan' : f.role === 3 ? 'eared' : 'plain' });
      }
    }
    const g = st.gate;
    add({ type: 'opening', kind: 'gate', x: plan.axes[0].x, w: g.w_m, z0: 0, h: g.h_m, shape: g.shape, floor: 1, axis: 1 });
    const d = st.doors[0];
    const di = o.center ? c : Math.floor(n / 2);
    add({ type: 'opening', kind: 'door', x: plan.axes[di].x, w: d.w_m, z0: d.z0_m, h: r3(d.top_m - d.z0_m), shape: d.shape, floor: 1, axis: di + 1 });
    const capTop = sec.crown[0].z1; // верх зоны капителей
    const oz0 = r3(f2.z1 + st.belts[0].height_m);
    if (o.order) {
      const O = st.order;
      for (const x of [O.corner_pilaster_inset_m + O.corner_pilaster_w_m / 2, W - O.corner_pilaster_inset_m - O.corner_pilaster_w_m / 2]) {
        add({ type: 'column', kind: 'pilaster', x: r3(x), w: O.corner_pilaster_w_m, z0: oz0, z1: capTop, capH: O.capital_h_m, order: O.type });
      }
      if (o.center) {
        for (const j of [c - 2, c - 1, c, c + 1]) {
          const x = (plan.axes[j].x + plan.axes[j + 1].x) / 2;
          add({ type: 'column', kind: 'half-column', x: r3(x), w: O.half_column_w_m, z0: oz0, z1: capTop, capH: O.capital_h_m, order: O.type });
        }
      }
    }
    if (o.center) {
      const er = st.erker;
      const a = plan.axes[c];
      add({ type: 'erker', shape: 'three-sided', x0: r3(a.x - er.w_m / 2), x1: r3(a.x + er.w_m / 2), front: er.front_w_m, z0: oz0, z1: r3(fTop.z1 + er.top_above_last_floor_m), limited: true, bands: [] });
    }
    crownEls(ctx, 0, W, 'modillions');
    roofEl(ctx, st.section.roof, 0, W, sec.cornice);
    return ctx.E;
  }

  // ---------------------------------------------------------------- генерация
  function layoutFor(st, W, o) {
    switch (st.id) {
      case '01': return plan01(st, W);
      case '03': return plan03(st, W, o);
      case '05': return plan05(st, W);
      default: return null;
    }
  }

  const BUILD = { '01': build01, '02': build02, '03': build03, '04': build04, '05': build05, '06': build06 };

  function assemble(data, st, W, N, o, sec, plan) {
    const elements = BUILD[st.id](st, W, N, sec, plan, o);
    const topOf = (e) => {
      if (e.type === 'parapet' || e.type === 'roof') return Math.max(...e.pts.map((p) => p[1]));
      if (e.type === 'attic') return Math.max(...e.parts.map((p) => p.z1)) + (e.arch ? e.arch.r : 0);
      if (e.type === 'brow') return e.z0 + e.rise; // rise — подъём вершины кривой
      return e.z1;
    };
    const maxTop = (list) => (list.length ? r3(Math.max(...list.map(topOf))) : null);
    // G3 + ответ автора (вопрос 11): предел — для карниза и парапета (у 05 — и
    // карнизов ризалитов; эркер 04 и 06 считается стеной). Аттик, аттиковый
    // этаж, кровля, бровка эркера и скульптура могут быть выше.
    const limitTop = maxTop(elements.filter((e) => e.limited));
    const atticTop = maxTop(elements.filter((e) => e.type === 'attic' || e.type === 'attic-floor'));
    const roofTop = maxTop(elements.filter((e) => e.type === 'roof' || e.type === 'sculpture'));
    const wallTop = Math.max(limitTop, atticTop || 0, maxTop(elements.filter((e) => e.type === 'brow')) || 0);
    const parapet = elements.find((e) => e.type === 'parapet');
    const model = {
      style: st.id, styleKey: st.key, styleName: st.name, house: st.house,
      W: r3(W), N, options: o,
      axes: plan.axes.map((a, i) => ({ n: i + 1, x: a.x, part: a.part, kind: a.kind })),
      parts: plan.parts,
      stepInfo: plan.stepInfo,
      section: sec,
      cornice: sec.cornice,
      parapetTop: parapet ? r3(Math.max(...parapet.pts.map((p) => p[1]))) : null,
      parapetMin: parapet ? r3(Math.min(...parapet.pts.map((p) => p[1]))) : null,
      limitTop, atticTop, wallTop, roofTop,
      limit: data.limit.cornice_max_m,
      elements,
      plan
    };
    model.checks = checkModel(data, model);
    return model;
  }

  function generate(data, req) {
    const st = getStyle(data, req.style);
    const W = Number(req.width);
    const N = Math.round(Number(req.floors));
    const o = fillOptions(st, req.options);
    const fail = (msg, extra) => Object.assign({ ok: false, error: msg, style: st.id, W, N, options: o }, extra || {});
    if (!(W > 0) || W > W_MAX) return fail(`Ширина должна быть от 0 до ${W_MAX} м.`);
    const sec = buildSection(st, N);
    if (sec.error) return fail(sec.error);
    // G1: карниз (или парапет) не выше 23,5 м — проверяется по готовой модели ниже
    const limit = data.limit.cornice_max_m;
    let model;
    // варианты раскладки по порядку предпочтения; берётся первый, где проёмы
    // помещаются (T1–T3)
    let cands = null;
    if (st.id === '02' || st.id === '06') {
      const target = o.step;
      const constraint = st.id === '06' && o.center ? (n) => n % 2 === 1 && n >= 5 : (n) => n >= 3;
      const pr = planRow(st, W, target, constraint);
      if (pr.error) return fail(pr.error);
      cands = pr.cands.map((cnd) => {
        const ra = rowAxes(W, pr.e, cnd.n);
        return { axes: ra.axes, parts: [{ kind: 'row', name: 'фасад', x0: 0, x1: W }], step: ra.step, stepInfo: `шаг ${fmt(ra.step, 3)} м (задан ${fmt(target, 2)})` };
      });
    } else if (st.id === '04') {
      cands = plans04(st, W);
    }
    if (cands) {
      let lastErr = 'Нет подходящего числа осей.';
      for (const plan of cands) {
        const m = assemble(data, st, W, N, o, sec, plan);
        const bad = m.checks.filter((c) => !c.ok && c.id.startsWith('T'));
        if (!bad.length) { model = m; break; }
        lastErr = bad.map((c) => c.detail).join('; ');
      }
      if (!model) return fail(`При ширине ${fmt(W)} м окна не помещаются: ${lastErr}`);
    } else {
      const plan = layoutFor(st, W, o);
      if (plan.error) return fail(plan.error);
      model = assemble(data, st, W, N, o, sec, plan);
    }
    if (model.limitTop > limit + EPS) {
      return fail(`Карниз/парапет был бы на ${fmt(model.limitTop, 2)} м — выше предела ${fmt(limit, 1)} м.`, { limitTop: model.limitTop });
    }
    const hard = model.checks.filter((c) => !c.ok && c.hard);
    if (hard.length) return fail(hard.map((c) => `${c.id}: ${c.detail}`).join('; '), { model });
    model.notes = notesFor(st, model);
    return { ok: true, model };
  }

  function notesFor(st, m) {
    const out = [];
    const h = m.section.heights;
    if (h.source === 'author') out.push(`Высоты этажей ${h.hs.map((v) => fmt(v)).join(' / ')} м заданы автором (в альбоме ${h.album.map((v) => fmt(v)).join(' / ')} м): 1-й этаж выше остальных, сумма и отметка карниза как в альбоме.`);
    if (st.id === '04' && Math.abs(m.plan.k - 1) > 0.25) out.push(`Расстояния между осями модерна ×${fmt(m.plan.k, 2)} к альбому: даже ${st.generator.axes_max} оси не заполняют ширину без растяжения.`);
    if (st.id === '01') {
      const s0 = st.plan.parts[2].axis_step_m, s1 = m.plan.portico.step;
      if (Math.abs(s1 / s0 - 1) > 0.25) out.push(`Шаг портика ${fmt(s1)} м против ${fmt(s0)} м в альбоме: число колонн ограничено 4 / 6 / 8, остальное уходит в шаг.`);
    }
    return out;
  }

  // --------------------------------------------------------------- проверки
  function rectOf(e) { return { x0: e.x - e.w / 2, x1: e.x + e.w / 2, z0: e.z0, z1: e.z0 + e.h }; }
  function overlap(a, b) { return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS; }

  function checkModel(data, m) {
    const st = getStyle(data, m.style);
    const C = [];
    const push = (id, ok, detail, hard, warn) => C.push({ id, title: RULE_TITLES[id] || id, ok: !!ok, detail, hard: !!hard, warn: !!warn });
    const E = m.elements;
    const ops = E.filter((e) => e.type === 'opening');
    // G1: предел 23,5 м — жёсткое ограничение; G3: относится к карнизу и парапету,
    // аттик, кровля и скульптура могут быть выше
    push('G1', m.limitTop <= m.limit + EPS, `верх карниза/парапета ${fmt(m.limitTop, 2)} м ≤ ${fmt(m.limit, 1)} м (запас ${fmt(m.limit - m.limitTop, 2)} м)`, true);
    const above = [];
    if (m.atticTop) above.push(`${m.style === '05' ? 'аттиковый этаж' : 'аттик'} до ${fmt(m.atticTop, 2)} м`);
    if (m.roofTop) above.push(`${m.style === '01' ? 'скульптура' : 'кровля'} до ${fmt(m.roofTop, 2)} м`);
    if (above.length) push('G3', true, above.join(', ') + ' — в предел не входят' + (Math.max(m.atticTop || 0, m.roofTop || 0) > m.limit ? '; выше 23,5 м это допустимо' : ''), false);
    // T1: оси влезают в ширину
    const ax = m.axes;
    const inside = ax.every((a) => a.x > EPS && a.x < m.W - EPS);
    const sumParts = m.parts.reduce((s, p) => s + (p.x1 - p.x0), 0);
    push('T1', inside && Math.abs(sumParts - m.W) < 1e-3, inside ? `${ax.length} осей внутри ширины ${fmt(m.W)} м; части в сумме ${fmt(sumParts, 3)} м` : 'ось вне фасада', true);
    // T2: проёмы не пересекаются
    let clash = null;
    for (let i = 0; i < ops.length && !clash; i++) for (let j = i + 1; j < ops.length; j++) if (overlap(rectOf(ops[i]), rectOf(ops[j]))) { clash = [ops[i], ops[j]]; break; }
    push('T2', !clash, clash ? `пересекаются проёмы на осях ${clash[0].axis || '—'} и ${clash[1].axis || '—'} (этаж ${clash[0].floor})` : `${ops.length} проёмов, пересечений нет`, true);
    // T3: проёмы в пределах фасада
    const out = ops.find((e) => { const r = rectOf(e); return r.x0 < -EPS || r.x1 > m.W + EPS || r.z0 < -EPS || r.z1 > m.wallTop + EPS; });
    const erOut = E.find((e) => e.type === 'erker' && (e.x0 < -EPS || e.x1 > m.W + EPS));
    push('T3', !out && !erOut, out ? `проём на оси ${out.axis} выходит за фасад` : erOut ? 'эркер выходит за край фасада' : 'все проёмы и эркер в пределах фасада', true);
    // G2: первый этаж — самый высокий, строго выше остальных (ответ автора)
    const hs = m.section.floors.map((f) => f.h);
    const hMax = Math.max(...hs.slice(1).concat([0]));
    push('G2', hs[0] > hMax + EPS, `1-й этаж ${fmt(hs[0], 2)} м, остальные до ${fmt(hMax, 2)} м`, true);
    // G5: симметрия (кроме модерна); ворота и проезды могут стоять не по оси
    const sym = ax.every((a, i) => Math.abs(a.x + ax[ax.length - 1 - i].x - m.W) < 1e-3);
    if (m.style === '04') { const ea = ax.find((a) => a.part === 'erker'); push('G5', !sym && Math.abs(ea.x - m.W / 2) > 0.1, sym ? 'оси симметричны — в модерне асимметрия обязательна' : `асимметрия: эркерная ось смещена от середины на ${fmt(ea.x - m.W / 2, 2)} м`, true); }
    else if (m.style === '03' && m.options.freeSymmetry) push('G5', true, sym ? 'оси симметричны' : 'отступление от строгой симметрии разрешено для эклектики (R03.2)', false);
    else push('G5', sym, sym ? 'оси симметричны относительно середины' : 'оси несимметричны', true);
    // F1: ордер только на каменном или рустованном основании
    const cols = E.filter((e) => e.type === 'column');
    if (cols.length) {
      const base = Math.min(...cols.map((c) => c.z0));
      const below = m.section.floors.filter((f) => f.z1 <= base + 0.5);
      const okF1 = below.length > 0 && below.every((f) => f.finish === 'rust' || f.finish === 'granite');
      push('F1', okF1, `под ордером этажи ${below.map((f) => f.n).join(', ')}: ${[...new Set(below.map((f) => f.finish === 'granite' ? 'рваный гранит' : f.finish === 'rust' ? 'руст' : 'гладкая стена'))].join(', ')}`, true);
    } else push('F1', true, 'ордера нет', false);
    // F2: одинаковый шаг осей в рядовом доме
    if (m.style === '02') {
      const steps = ax.slice(1).map((a, i) => a.x - ax[i].x);
      const dev = Math.max(...steps) - Math.min(...steps);
      push('F2', dev < 1e-3, `шаг ${fmt(steps[0], 3)} м, разброс ${fmt(dev, 3)} м`, true);
    }
    // F3: элементы только одного стиля
    const foreign = E.filter((e) => e.style !== m.style);
    push('F3', !foreign.length, foreign.length ? `${foreign.length} элементов другого стиля` : `все ${E.length} элементов — стиль ${m.style}`, true);
    // правила стиля
    const R = (id, ok, detail) => push(id, ok, detail, true);
    const fin = (f) => f && f.finish;
    switch (m.style) {
      case '01': {
        const kinds = m.parts.map((p) => p.kind).join(',');
        const wa = m.axes.filter((a) => a.part === 'wing');
        const half = m.W / 2;
        const wl = wa.filter((a) => a.x < half).length, wr = wa.length - wl;
        const f1 = m.section.floors[0];
        R('R01.1', kinds === 'risalit,wing,portico,wing,risalit' && wl === wr && wl >= st.generator.wing_axes_min && wl <= st.generator.wing_axes_max && fin(f1) === 'rust' && f1.h >= Math.max(...hs) - EPS && cols.length > 0,
          `части: ризалит–крыло–портик–крыло–ризалит; в крыльях по ${wl} оси (можно ${st.generator.wing_axes_min}–${st.generator.wing_axes_max}); 1-й этаж рустован, ${fmt(f1.h)} м — самый высокий; ордер на нём`);
        const pc = m.plan.portico.columns;
        R('R01.2', st.generator.portico_columns.includes(pc), `портик: ${pc} колонн, ${m.plan.portico.spans} пролётов, шаг ${fmt(m.plan.portico.step)} м`);
        break;
      }
      case '02': {
        const rust = E.filter((e) => e.type === 'rust');
        const strong = E.find((e) => e.type === 'belt' && e.weight === 'strong');
        const f2 = m.section.floors.find((f) => f.role === 2);
        R('R02.1', rust.length === 1 && rust[0].floor === 1 && strong && f2 && Math.abs(strong.z0 - f2.z1) < 1e-6,
          `руст только на 1-м этаже; сильный пояс на отметке ${strong ? fmtMark(strong.z0) : '—'} (верх 2-го этажа)`);
        const top3 = m.section.floors.filter((f) => f.role === 3);
        const ornate = E.some((e) => e.type === 'sandrik');
        R('R02.3', !ornate && top3.every((f) => f.h < hs[0] - EPS), `3-й этаж ${top3.length ? fmt(top3[0].h) : '—'} м — ниже 1-го (${fmt(hs[0])} м); без сандриков и филёнок`);
        break;
      }
      case '03': {
        const ctr = m.parts.find((p) => p.kind === 'center');
        const paired = ops.filter((e) => e.paired).length;
        const bal = E.find((e) => e.type === 'balcony');
        const peds = E.filter((e) => e.type === 'sandrik' && e.shape === 'segment');
        const ext = [ax[0].x, ax[ax.length - 1].x];
        R('R03.1', ctr && Math.abs(ctr.x1 - ctr.x0 - st.plan.center.width_m) < 1e-6 && paired >= 2 && bal && bal.rail === 'кованая решётка' && peds.length === 2 && peds.every((p) => ext.some((x) => Math.abs(x - p.x) < 1e-6)),
          `ризалит ${ctr ? fmt(ctr.x1 - ctr.x0) : '—'} м, парных окон ${paired}, балкон: ${bal ? bal.rail : 'нет'}; лучковые фронтоны на осях 1 и ${ax.length}`);
        const frames = new Set(ops.filter((e) => e.kind === 'window').map((e) => e.frame));
        R('R03.3', frames.size === 1 && !E.some((e) => e.type === 'sandrik' && e.shape !== 'segment'), `обрамление окон одно на всех этажах: ${[...frames].join(', ')}`);
        const lop = E.filter((e) => e.type === 'lopatka' && e.rust);
        R('G6', lop.length === 2, `рустованные лопатки ризалита: ${lop.length}`);
        break;
      }
      case '04': {
        const fl4 = m.section.floors.find((f) => f.role === 4) || m.section.floors[2];
        const widths = new Set(ops.filter((e) => e.floor === fl4.n && !e.side).map((e) => e.w));
        const base = m.section.floors.slice(0, 2).every((f) => f.finish === 'granite');
        const rust = E.find((e) => e.type === 'rust' && e.pattern === 'rough');
        const par = E.find((e) => e.type === 'parapet');
        const crown = E.some((e) => e.type === 'crown');
        const g4 = st.generator;
        R('R04.1', !sym && widths.size >= 2 && base && rust && par && !crown && ax.length >= g4.axes_min && ax.length <= g4.axes_max, `асимметрия; ${ax.length} осей (можно ${g4.axes_min}–${g4.axes_max}), ширины окон ${[...widths].sort((p, q) => p - q).map((w) => fmt(w, 1)).join(' / ')} м; 1–2-й этажи — рваный гранит до ${fmtMark(rust ? rust.z1 : 0)}; парапет вместо карниза`);
        break;
      }
      case '05': {
        const ris = m.parts.filter((p) => p.kind === 'risalit').length;
        const o3 = cols.length && m.section.floors.filter((f) => f.z0 >= cols[0].z0 - EPS && f.z1 <= cols[0].z1 + EPS && f.role !== 'attic').length;
        const base = m.section.floors.slice(0, 2).every((f) => f.finish === 'granite');
        const portals = E.filter((e) => e.type === 'portal').length;
        R('R05.1', sym && ris === 2 && o3 === 3 && base && portals === 2, `симметрия, ризалитов ${ris}; ордер на ${o3} этажа; база 1–2 этажи из рваного гранита; порталов с фронтонами ${portals}`);
        break;
      }
      case '06': {
        const rust = E.find((e) => e.type === 'rust');
        R('R06.1', rust && rust.floor === '1–2', 'руст на 1–2-м этажах как цоколь');
        const bal = E.filter((e) => e.type === 'balcony');
        // ответ автора: «не тянуть карниз к пределу» — отметка карниза только из высот
        // этажей и венчания альбома, без подгонки к 23,5 м
        const sec = m.section;
        const own = sec.floors.reduce((a, f) => a + st.section.floors[f.role - 1].height_m, sec.plinth) + st.section.crown.reduce((a, c) => a + c.height_m, 0);
        R('R06.3', bal.length === 0 && Math.abs(own - m.cornice) < 1e-6, `балконов с балюстрадой нет; карниз ${fmt(m.cornice, 2)} м = цоколь + этажи + венчание по альбому (к пределу не подгоняется)`);
        break;
      }
    }
    return C;
  }

  // Краткие подписи правил для страницы; дословные тексты — docs/implementation.md
  const RULE_TITLES = {
    G1: 'Карниз (парапет) не выше 23,5 м',
    G2: 'Первый этаж — самый высокий',
    G3: 'Аттик, кровля и скульптура могут быть выше предела',
    G5: 'Симметрия (в модерне — асимметрия)',
    G6: 'Рустованы лопатки центрального ризалита',
    F1: 'Нет ордера без каменного или рустованного основания',
    F2: 'Одинаковый шаг осей в рядовом доме',
    F3: 'Нет смешения элементов разных стилей',
    T1: 'Оси влезают в ширину',
    T2: 'Проёмы не пересекаются',
    T3: 'Проёмы в пределах фасада',
    'R01.1': 'Пятичастная композиция, 3–6 осей в крыле, ордер на рустованном 1-м этаже',
    'R01.2': 'Портик не убирается, меняется число колонн (4 / 6 / 8)',
    'R02.1': 'Руст только на 1-м этаже, сильный пояс между 2-м и 3-м',
    'R02.3': 'Не берём высокий нарядный 3-й этаж',
    'R03.1': 'Узкий ризалит с парными окнами и балконом, лучковые фронтоны на крайних осях',
    'R03.3': 'Не берём отдельное обрамление окон для каждого этажа',
    'R04.1': 'Асимметрия, оси разной ширины (3–6), гранитный цоколь на 2 этажа, волнистый парапет',
    'R05.1': 'Симметрия, 2 ризалита, ордер на 3 этажа, гранитная база, порталы с фронтонами',
    'R06.1': 'Руст на 1–2-м этажах как цоколь',
    'R06.3': 'Не берём карниз вплотную к пределу и балконы с балюстрадой'
  };

  // ------------------------------------------------------- диапазоны ввода
  function floorRange(data, styleId, opts) {
    const st = getStyle(data, styleId);
    const list = [];
    for (let N = 1; N <= 9; N++) {
      const sec = buildSection(st, N);
      if (sec.error) { list.push({ N, ok: false, reason: sec.error }); continue; }
      // верх стены по этой схеме (без раскладки): берём модель на альбомной ширине
      const g = generate(data, { style: st.id, width: st.album.width_m, floors: N, options: opts });
      if (g.ok) list.push({ N, ok: true, limitTop: g.model.limitTop, cornice: g.model.cornice });
      else list.push({ N, ok: false, reason: g.error, limitTop: g.limitTop });
    }
    const okN = list.filter((x) => x.ok).map((x) => x.N);
    return { list, min: Math.min(...okN), max: Math.max(...okN) };
  }

  // Минимальная ширина, при которой генератор строит фасад (поиск по сетке 0,01 м).
  function widthRange(data, styleId, N, opts) {
    const st = getStyle(data, styleId);
    const ok = (W) => generate(data, { style: st.id, width: W, floors: N, options: opts }).ok;
    let lo = 1, hi = st.album.width_m;
    if (!ok(hi)) {
      hi = W_MAX;
      if (!ok(hi)) return { min: null, max: null };
    }
    while (hi - lo > 0.01) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
    const fl = Math.floor(hi * 100) / 100;
    return { min: ok(fl) ? fl : Math.ceil(hi * 100) / 100, max: W_MAX };
  }

  function albumRequest(st) {
    const o = {};
    for (const d of styleOptions(st)) o[d.key] = d.def;
    return { style: st.id, width: st.album.width_m, floors: st.album.floors, options: o };
  }

  // ------------------------------------------------- сверка с альбомом (п. 4)
  function validate(data) {
    return data.styles.map((st) => {
      const g = generate(data, albumRequest(st));
      const A = st.album;
      const row = { id: st.id, name: st.name, address: st.house.address, link: st.house.link, ok: g.ok, error: g.error };
      if (!g.ok) return row;
      const m = g.model;
      const albumCornice = A.cornice_m !== null ? A.cornice_m : A.parapet_top_m;
      const genCornice = m.cornice !== null ? m.cornice : m.parapetTop;
      row.corniceKind = A.cornice_m !== null ? 'карниз' : 'верх парапета (карниза нет)';
      row.width = { album: A.width_m, gen: m.W, diff: r3(m.W - A.width_m) };
      row.axes = { album: A.axes, gen: m.axes.length, diff: m.axes.length - A.axes };
      row.cornice = { album: albumCornice, gen: genCornice, diff: r3(genCornice - albumCornice) };
      const dx = m.axes.length === A.axis_positions_m.length ? Math.max(...m.axes.map((a, i) => Math.abs(a.x - A.axis_positions_m[i]))) : null;
      row.axisShift = dx === null ? null : r3(dx);
      const lv = m.section.floors.map((f) => f.z0);
      const al = A.floor_levels_m;
      row.levelShift = lv.length === al.length ? r3(Math.max(...lv.map((z, i) => Math.abs(z - al[i])))) : null;
      const albLim = Math.max(...[A.cornice_m, A.risalit_cornice_m, A.parapet_top_m].filter((v) => typeof v === 'number'));
      row.limitTop = { album: albLim, gen: m.limitTop, diff: r3(m.limitTop - albLim) };
      row.notes = (m.notes || []).slice();
      row.checksOk = m.checks.every((c) => c.ok);
      return row;
    });
  }

  // ================================================================ рендер SVG
  const SCALES = [200, 400, 500, 1000];

  function render(model, data, opt) {
    opt = opt || {};
    const m = model;
    const W = m.W;
    const S = opt.scale || SCALES.find((s) => (W * 1000) / s + 70 <= 400) || 1000;
    const a = S / 1000; // метров на 1 мм листа
    const K = 10; // единиц SVG на метр
    const fs = 2.3 * a, fsS = 2.0 * a;
    const topAll = Math.max(m.limit, m.wallTop, m.roofTop || 0);
    const ML = 30 * a, MR = Math.max(30 * a, 130 * a - W); // лист не уже 160 мм, чтобы влез штамп
    const ZT = topAll + 9 * a;
    const ZB = -62 * a;
    const X = (x) => r3((x + ML) * K);
    const Y = (z) => r3((ZT - z) * K);
    const vbW = X(W + MR), vbH = Y(ZB);
    const o = [];
    const P = (pts) => pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ');
    const line = (x1, z1, x2, z2, cls) => o.push(`<line class="${cls}" x1="${X(x1)}" y1="${Y(z1)}" x2="${X(x2)}" y2="${Y(z2)}"/>`);
    const rect = (x0, z0, x1, z1, cls, fill) => o.push(`<rect class="${cls}" x="${X(Math.min(x0, x1))}" y="${Y(Math.max(z0, z1))}" width="${r3(Math.abs(x1 - x0) * K)}" height="${r3(Math.abs(z1 - z0) * K)}" fill="${fill || 'none'}"/>`);
    const poly = (pts, cls, fill) => o.push(`<polygon class="${cls}" points="${P(pts)}" fill="${fill || 'none'}"/>`);
    const pline = (pts, cls) => o.push(`<polyline class="${cls}" points="${P(pts)}" fill="none"/>`);
    const path = (d, cls, fill) => o.push(`<path class="${cls}" d="${d}" fill="${fill || 'none'}"/>`);
    const text = (x, z, s, size, anchor, extra, cls) => o.push(`<text class="${cls || 'tx'}" x="${X(x)}" y="${Y(z)}" font-size="${r3(size * K)}" text-anchor="${anchor || 'middle'}"${extra || ''}>${esc(s)}</text>`);
    const textV = (x, z, s, size) => o.push(`<text class="tx" x="${X(x)}" y="${Y(z)}" font-size="${r3(size * K)}" text-anchor="middle" transform="rotate(-90 ${X(x)} ${Y(z)})">${esc(s)}</text>`);
    const R = (v) => r3(v * K);
    const archPath = (x0, x1, zb, zs, r) => `M ${X(x0)} ${Y(zb)} L ${X(x0)} ${Y(zs)} A ${R(r)} ${R(r)} 0 0 1 ${X(x1)} ${Y(zs)} L ${X(x1)} ${Y(zb)} Z`;
    const segPath = (x0, x1, z, rise) => { const w = x1 - x0; const rr = (w * w / 4 + rise * rise) / (2 * rise); return `M ${X(x0)} ${Y(z)} A ${R(rr)} ${R(rr)} 0 0 1 ${X(x1)} ${Y(z)} Z`; };

    o.push(`<svg xmlns="http://www.w3.org/2000/svg" class="dwg" viewBox="0 0 ${r3(vbW)} ${r3(vbH)}" width="${r3((vbW / K) * (1000 / S))}mm" height="${r3((vbH / K) * (1000 / S))}mm" role="img" aria-label="${esc('Обмерный чертёж: ' + m.styleName + ', ' + fmt(W) + ' м, ' + m.N + ' эт.')}" data-style="${m.style}" data-scale="1:${S}">`);
    o.push(`<style>
.dwg *{vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.dwg .g{stroke:#111;stroke-width:2.4}.dwg .o{stroke:#1a1a1a;stroke-width:1.35}.dwg .m{stroke:#222;stroke-width:0.95}
.dwg .t{stroke:#2a2a2a;stroke-width:0.6}.dwg .h{stroke:#6b6b6b;stroke-width:0.35}.dwg .n{stroke:none}
.dwg .dim{stroke:#333;stroke-width:0.5}.dwg .ax{stroke:#777;stroke-width:0.5;stroke-dasharray:14 3 2 3}
.dwg .lim{stroke:#b8382c;stroke-width:1.2;stroke-dasharray:10 4 2 4}
.dwg .tx{font-family:'PT Sans Narrow','Arial Narrow','Roboto Condensed','DejaVu Sans Condensed',sans-serif;fill:#222}
.dwg .txl{fill:#b8382c}
</style>`);
    o.push(`<rect class="n" x="0" y="0" width="${r3(vbW)}" height="${r3(vbH)}" fill="#ffffff"/>`);

    const E = m.elements;
    const by = (t) => E.filter((e) => e.type === t);
    // 1. стены
    for (const e of by('wall').concat(by('attic-floor'))) {
      if (e.outline) { poly(e.outline, 'n', '#ffffff'); }
      else rect(e.x0, e.z0, e.x1, e.z1, 'n', '#ffffff');
    }
    for (const e of by('roof')) poly(e.pts, 'o', '#d9d9d9');
    for (const e of by('sculpture')) {
      const cx = (e.x0 + e.x1) / 2, w = e.x1 - e.x0, h = e.z1 - e.z0;
      path(`M ${X(e.x0)} ${Y(e.z0)} Q ${X(e.x0 + w * 0.1)} ${Y(e.z0 + h * 0.7)} ${X(cx - w * 0.18)} ${Y(e.z0 + h * 0.9)} Q ${X(cx)} ${Y(e.z1 + h * 0.12)} ${X(cx + w * 0.18)} ${Y(e.z0 + h * 0.9)} Q ${X(e.x1 - w * 0.1)} ${Y(e.z0 + h * 0.7)} ${X(e.x1)} ${Y(e.z0)} Z`, 't', '#e6e6e6');
    }
    // 2. цоколь, руст, блоки
    for (const e of by('plinth')) rect(e.x0, e.z0, e.x1, e.z1, 'n', '#ececec');
    for (const e of by('rust')) {
      const c = e.course || 0.5;
      for (let z = e.z0 + c; z < e.z1 - 0.05; z += c) line(e.x0, z, e.x1, z, 'h');
      if (e.pattern === 'rough') {
        let row = 0;
        for (let z = e.z0; z < e.z1 - 0.05; z += c, row++) {
          const step = 2 * c * 1.6;
          for (let x = e.x0 + (row % 2 ? step / 2 : 0) + step / 2; x < e.x1 - 0.1; x += step) line(x, z, x, Math.min(z + c, e.z1), 'h');
        }
      }
    }
    for (const e of by('block')) rect(e.x0, e.z0, e.x1, e.z1, 'o');
    for (const e of by('lopatka')) {
      rect(e.x0, e.z0, e.x1, e.z1, 't', '#ffffff');
      if (e.rust) for (let z = e.z0 + (e.course || 0.5); z < e.z1 - 0.05; z += e.course || 0.5) line(e.x0, z, e.x1, z, 'h');
    }
    // 3. пояса
    for (const e of by('belt')) {
      if (e.z1 - e.z0 < 1e-6) { line(e.x0, e.z0, e.x1, e.z0, 't'); continue; }
      const ext = e.weight === 'strong' ? 0.12 : e.weight === 'stylobate' ? 0 : 0.06;
      rect(e.x0 - ext, e.z0, e.x1 + ext, e.z1, e.weight === 'strong' ? 'm' : 't', '#ffffff');
    }
    // 4. эркеры и консоли (под окнами)
    for (const e of by('console')) poly([[e.x0, e.z1], [e.x1, e.z1], [e.x1 - (e.x1 - e.x0) * 0.25, e.z0], [e.x0 + (e.x1 - e.x0) * 0.25, e.z0]], 'm', '#5a5a5a');
    for (const e of by('erker')) {
      rect(e.x0, e.z0, e.x1, e.z1, 'm', '#ffffff');
      if (e.shape === 'round') { const d = (e.x1 - e.x0) * 0.12; line(e.x0 + d, e.z0, e.x0 + d, e.z1, 'h'); line(e.x1 - d, e.z0, e.x1 - d, e.z1, 'h'); }
      if (e.shape === 'three-sided') { const d = (e.x1 - e.x0 - e.front) / 2; line(e.x0 + d, e.z0, e.x0 + d, e.z1, 't'); line(e.x1 - d, e.z0, e.x1 - d, e.z1, 't'); }
      for (const z of e.bands || []) rect(e.x0, z - 0.12, e.x1, z + 0.12, 't', '#ffffff');
    }
    // 5. порталы
    for (const e of by('portal')) {
      for (const s of [-1, 1]) rect(e.x + s * e.pilOff - e.pilW / 2, 0, e.x + s * e.pilOff + e.pilW / 2, e.h, 't', '#f2f2f2');
      rect(e.x - e.w / 2, e.h, e.x + e.w / 2, e.h + e.lintelH, 't', '#f2f2f2');
      poly([[e.x - e.pedW / 2, e.h + e.lintelH], [e.x + e.pedW / 2, e.h + e.lintelH], [e.x, e.h + e.lintelH + e.pedH]], 't', '#f2f2f2');
    }
    // 6. проёмы
    for (const e of by('opening')) {
      const x0 = e.x - e.w / 2, x1 = e.x + e.w / 2, z0 = e.z0, z1 = e.z0 + e.h;
      const fillC = e.kind === 'gate' ? '#5a5a5a' : e.kind === 'door' ? '#a8a8a8' : '#efefef';
      const fr = e.kind === 'window' && !e.side && e.frame !== 'none' ? 0.12 : e.kind === 'gate' && e.frameW ? (e.frameW - e.w) / 2 : 0;
      if (e.shape === 'arch' && e.w / 2 <= e.h) {
        const r = e.w / 2;
        if (fr) path(archPath(x0 - fr, x1 + fr, z0, z1 - r, r + fr), 't', '#ffffff');
        path(archPath(x0, x1, z0, z1 - r, r), 't', fillC);
        if (e.frame === 'fan' || e.frame === 'arcade') {
          for (let k = 1; k < 6; k++) { const ang = Math.PI * k / 6; line(e.x - Math.cos(ang) * r, z1 - r + Math.sin(ang) * r, e.x - Math.cos(ang) * (r + 0.45), z1 - r + Math.sin(ang) * (r + 0.45), 'h'); }
        }
      } else if (e.shape === 'lunette') {
        path(segPath(x0, x1, z0, e.h), 't', fillC);
      } else {
        if (fr) rect(x0 - fr, z0, x1 + fr, z1 + fr, 't', '#ffffff');
        rect(x0, z0, x1, z1, 't', fillC);
        if (e.frame === 'eared') { rect(x0 - fr - 0.12, z1 - 0.1, x0 - fr, z1 + fr, 't', '#ffffff'); rect(x1 + fr, z1 - 0.1, x1 + fr + 0.12, z1 + fr, 't', '#ffffff'); }
      }
      if (e.kind === 'window') {
        if (e.w > 0.5) {
          const zt = e.shape === 'arch' ? z1 - e.w / 2 : z1;
          if (e.mullions > 1) for (let k = 1; k < e.mullions + 1; k++) line(x0 + (e.w * k) / (e.mullions + 1), z0, x0 + (e.w * k) / (e.mullions + 1), zt, 'h');
          else line(e.x, z0, e.x, zt, 'h');
          if (e.h > 1.2 && e.shape !== 'lunette') line(x0, zt - Math.min(0.6, e.h * 0.28), x1, zt - Math.min(0.6, e.h * 0.28), 'h');
        }
        if (!e.side && e.shape !== 'lunette') rect(x0 - 0.2, z0 - 0.1, x1 + 0.2, z0, 't', '#ffffff');
        if (e.frame === 'sill-brackets') { rect(x0 + 0.05, z0 - 0.3, x0 + 0.15, z0 - 0.1, 'h', '#ffffff'); rect(x1 - 0.15, z0 - 0.3, x1 - 0.05, z0 - 0.1, 'h', '#ffffff'); }
      }
      if (e.kind === 'vitrine' && e.mullions > 1) for (let k = 1; k < e.mullions; k++) line(x0 + (e.w * k) / e.mullions, z0, x0 + (e.w * k) / e.mullions, z1, 'h');
    }
    // 7. сандрики и фронтоны
    for (const e of by('sandrik')) {
      const x0 = e.x - e.w / 2, x1 = e.x + e.w / 2;
      if (e.shape === 'triangle') poly([[x0, e.z0], [x1, e.z0], [e.x, e.z0 + e.h]], 't', '#ffffff');
      else if (e.shape === 'segment') path(segPath(x0, x1, e.z0, e.h), 't', '#ffffff');
      else rect(x0, e.z0, x1, e.z0 + e.h, 't', '#ffffff');
      if (e.consoles) for (const xx of [x0 + 0.1, x1 - 0.17]) rect(xx, e.z0 - 0.6, xx + 0.07, e.z0, 'h', '#ffffff');
    }
    // 9. балконы
    for (const e of by('balcony')) {
      if (e.z1 > e.z0) rect(e.x0, e.z0, e.x1, e.z1, 't', '#ffffff');
      line(e.x0, e.railTop, e.x1, e.railTop, 'm');
      line(e.x0, e.z1 + 0.08, e.x1, e.z1 + 0.08, 't');
      for (let x = e.x0; x <= e.x1 + 1e-6; x += 0.14) line(x, e.z1 + 0.08, x, e.railTop, 'h');
    }
    // 10. венчание (до колонн: капители 06 заходят в зону венчания)
    for (const e of by('crown')) {
      if (/капител/.test(e.name)) continue; // зона капителей — та же стена
      rect(e.x0 - e.projection, e.z0, e.x1 + e.projection, e.z1, e.last ? 'm' : 't', '#ffffff');
      if (e.kindHint === 'dentils' && e.last) for (let x = e.x0 + 0.1; x < e.x1 - 0.1; x += 0.3) rect(x, e.z0, x + 0.15, e.z0 + Math.min(0.2, (e.z1 - e.z0) * 0.3), 'h', '#ffffff');
      if (e.kindHint === 'modillions' && e.last) for (let x = e.x0 + 0.3; x < e.x1 - 0.2; x += 0.9) rect(x, e.z0, x + 0.25, e.z0 + (e.z1 - e.z0) * 0.4, 'h', '#ffffff');
      if (e.kindHint === 'brackets' && !e.last) for (const ax of m.axes) for (const s of [-0.75, 0.75]) rect(ax.x + s - 0.06, e.z0 + 0.05, ax.x + s + 0.06, e.z1 - 0.05, 'h', '#ffffff');
    }
    // 11. колонны и пилястры
    for (const e of by('column')) {
      const x0 = e.x - e.w / 2, x1 = e.x + e.w / 2;
      const baseH = Math.min(0.5, (e.z1 - e.z0) * 0.06);
      rect(x0 - 0.12, e.z0, x1 + 0.12, e.z0 + baseH, 't', '#ffffff');
      if (e.kind === 'column') poly([[x0, e.z0 + baseH], [x1, e.z0 + baseH], [x1 - 0.06, e.z1 - e.capH], [x0 + 0.06, e.z1 - e.capH]], 'm', '#ffffff');
      else rect(x0, e.z0 + baseH, x1, e.z1 - e.capH, e.kind === 'half-column' ? 'm' : 't', '#ffffff');
      if (/ионич/.test(e.order)) {
        rect(x0 - 0.1, e.z1 - e.capH, x1 + 0.1, e.z1, 't', '#ffffff');
        for (const xx of [x0 - 0.05, x1 + 0.05]) o.push(`<circle class="h" cx="${X(xx)}" cy="${Y(e.z1 - e.capH / 2)}" r="${R(Math.min(0.15, e.capH / 3))}" fill="none"/>`);
      } else poly([[x0 + 0.04, e.z1 - e.capH], [x1 - 0.04, e.z1 - e.capH], [x1 + 0.18, e.z1], [x0 - 0.18, e.z1]], 't', '#ffffff');
    }
    for (const e of by('medallion')) o.push(`<circle class="h" cx="${X(e.x)}" cy="${Y(e.z)}" r="${R(e.d / 2)}" fill="none"/>`);
    for (const e of by('attic')) {
      for (const p of e.parts) rect(p.x0, p.z0, p.x1, p.z1, 'o', '#ffffff');
      if (e.arch) path(archPath(e.arch.x - e.arch.r, e.arch.x + e.arch.r, e.arch.z0, e.arch.z0, e.arch.r), 'o', '#ffffff');
    }
    for (const e of by('parapet')) pline(e.pts, 'o');
    // квадратичная кривая: контрольная точка на 2·rise даёт вершину на rise
    for (const e of by('brow')) path(`M ${X(e.x0)} ${Y(e.z0)} Q ${X((e.x0 + e.x1) / 2)} ${Y(e.z0 + 2 * e.rise)} ${X(e.x1)} ${Y(e.z0)} L ${X(e.x1 - 0.15)} ${Y(e.z0 - 0.15)} Q ${X((e.x0 + e.x1) / 2)} ${Y(e.z0 + 2 * e.rise - 0.6)} ${X(e.x0 + 0.15)} ${Y(e.z0 - 0.15)} Z`, 'm', '#5a5a5a');
    // 12. контур стены и земля
    for (const e of by('wall').concat(by('attic-floor'))) {
      if (e.outline) pline(e.outline, 'o');
      else pline([[e.x0, e.z0], [e.x0, e.z1], [e.x1, e.z1], [e.x1, e.z0]], 'o');
    }
    line(-4 * a, 0, W + 4 * a, 0, 'g');

    // ---- аннотации
    // оси с номерами
    const zb = -7 * a, rb = 2.4 * a;
    for (const ax of m.axes) {
      line(ax.x, -0.6 * a, ax.x, zb + rb, 'ax');
      o.push(`<circle class="dim" cx="${X(ax.x)}" cy="${Y(zb)}" r="${R(rb)}" fill="#ffffff"/>`);
      text(ax.x, zb - fsS * 0.36, String(ax.n), fsS);
    }
    // размерные цепочки
    const tick = (x, z) => line(x - 0.9 * a, z - 0.9 * a, x + 0.9 * a, z + 0.9 * a, 'dim');
    const chain = (xs, z, labels) => {
      line(xs[0] - 1.5 * a, z, xs[xs.length - 1] + 1.5 * a, z, 'dim');
      xs.forEach((x) => { tick(x, z); line(x, z - 1 * a, x, z + 1.6 * a, 'dim'); });
      for (let i = 0; i < xs.length - 1; i++) {
        const len = xs[i + 1] - xs[i];
        const lab = labels ? labels[i] : mmStr(len);
        const fits = len / a >= lab.length * 0.95 + 0.6;
        if (fits) text((xs[i] + xs[i + 1]) / 2, z + 0.8 * a, lab, fsS);
        else if (i === 0) text(xs[0] - 1.8 * a, z + 0.8 * a, lab, fsS, 'end');
        else if (i === xs.length - 2) text(xs[i + 1] + 1.8 * a, z + 0.8 * a, lab, fsS, 'start');
      }
    };
    const xs1 = [0].concat(m.axes.map((q) => q.x)).concat([W]);
    chain(xs1, -14 * a);
    let zc = -20 * a;
    if (m.parts.length > 1) {
      const xs2 = [0].concat(m.parts.map((p) => p.x1));
      chain(xs2, zc);
      zc -= 6 * a;
    }
    chain([0, W], zc);
    // вертикальная цепочка
    const sec = m.section;
    const vz = [0];
    if (sec.plinth > 0) vz.push(sec.plinth);
    for (const f of sec.floors) { if (f.role === 'attic') continue; vz.push(f.z1); const zn = sec.zones.find((q) => Math.abs(q.z0 - f.z1) < 1e-6); if (zn) vz.push(zn.z1); }
    if (sec.cornice !== null) { for (const c of sec.crown) vz.push(c.z1); }
    const af = sec.floors.find((f) => f.role === 'attic');
    if (af) vz.push(af.z1);
    if (m.parapetTop !== null) vz.push(m.parapetTop);
    if (E.some((e) => e.type === 'attic' && e.arch)) vz.push(m.atticTop);
    const uniq = [...new Set(vz.map(r3))].sort((p, q) => p - q);
    const xv = -9 * a;
    line(xv, uniq[0] - 1.5 * a, xv, uniq[uniq.length - 1] + 1.5 * a, 'dim');
    for (const z of uniq) { line(xv - 0.9 * a, z - 0.9 * a, xv + 0.9 * a, z + 0.9 * a, 'dim'); line(xv - 1 * a, z, -0.8 * a, z, 'dim'); }
    let lastOut = null;
    for (let i = 0; i < uniq.length - 1; i++) {
      const len = uniq[i + 1] - uniq[i];
      const lab = mmStr(len);
      if (len / a >= lab.length * 0.95 + 0.6) textV(xv - 0.9 * a, (uniq[i] + uniq[i + 1]) / 2, lab, fsS);
      else {
        const zm = (uniq[i] + uniq[i + 1]) / 2;
        let zl = zm;
        if (lastOut !== null && zl - lastOut < 3.0 * a) zl = lastOut + 3.0 * a;
        lastOut = zl;
        pline([[xv - 1 * a, zm], [xv - 2.6 * a, zl], [xv - 3.2 * a, zl]], 'dim');
        text(xv - 3.6 * a, zl - fsS * 0.35, lab, fsS * 0.9, 'end');
      }
    }
    // общий размер до карниза/парапета
    const xv2 = -17 * a;
    const zTopDim = m.cornice !== null ? m.cornice : m.parapetTop;
    line(xv2, -1.5 * a, xv2, zTopDim + 1.5 * a, 'dim');
    for (const z of [0, zTopDim]) { line(xv2 - 0.9 * a, z - 0.9 * a, xv2 + 0.9 * a, z + 0.9 * a, 'dim'); line(xv2 - 1 * a, z, xv - 1 * a, z, 'dim'); }
    textV(xv2 - 0.9 * a, zTopDim / 2, mmStr(zTopDim) + (m.cornice !== null ? ' до карниза' : ' до парапета'), fsS);
    // отметки
    const marks = [{ z: 0, t: '±0,000' }];
    for (const f of sec.floors) if (f.n > 1) marks.push({ z: f.z0 });
    if (m.cornice !== null && sec.crown.length > 1) marks.push({ z: sec.lastTop });
    if (m.cornice !== null) marks.push({ z: m.cornice, bold: true, label: 'карниз' });
    if (m.parapetTop !== null) { marks.push({ z: m.parapetMin, label: 'парапет' }); marks.push({ z: m.parapetTop, bold: true, label: 'верх парапета' }); }
    if (m.atticTop) marks.push({ z: m.atticTop, label: m.style === '05' ? 'аттик. этаж' : 'аттик' });
    if (m.style === '05') marks.push({ z: E.find((e) => e.name === 'ризалит').z1, label: 'ризалиты' });
    if (m.roofTop) marks.push({ z: m.roofTop, label: m.style === '01' ? 'скульптура' : 'кровля' });
    marks.sort((p, q) => p.z - q.z || (q.label ? 1 : 0) - (p.label ? 1 : 0));
    for (let i = marks.length - 1; i > 0; i--) if (Math.abs(marks[i].z - marks[i - 1].z) < 1e-3) { const keep = marks[i].label ? marks[i] : marks[i - 1]; marks.splice(i - 1, 2, keep); }
    const used = [];
    const xm = W + 3 * a;
    for (const mk of marks) {
      let col = 0;
      while (used.some((u) => u.col === col && Math.abs(u.z - mk.z) < 5.4 * a)) col++;
      used.push({ z: mk.z, col });
      const x = xm + col * 13 * a;
      line(W + 0.6 * a, mk.z, x + 1.8 * a, mk.z, 'dim');
      poly([[x + 1.2 * a, mk.z], [x, mk.z + 1.3 * a], [x + 2.4 * a, mk.z + 1.3 * a]], 'dim', '#ffffff');
      line(x + 1.2 * a, mk.z + 1.3 * a, x + 1.2 * a, mk.z + 2.6 * a, 'dim');
      line(x + 1.2 * a, mk.z + 2.6 * a, x + 11 * a, mk.z + 2.6 * a, 'dim');
      text(x + 1.6 * a, mk.z + 3.1 * a, (mk.t || fmtMark(mk.z)), fsS, 'start', mk.bold ? ' font-weight="bold"' : '');
      if (mk.label) text(x + 1.6 * a, mk.z + 0.4 * a, mk.label, fsS * 0.8, 'start', ' fill="#666"');
    }
    // предел 23,5 м
    const L = m.limit;
    line(-ML + 3 * a, L, W + MR - 3 * a, L, 'lim');
    text(-ML + 3 * a, L + 1.2 * a, data.limit.text, fsS, 'start', '', 'tx txl');
    text(W + MR - 3 * a, L + 1.2 * a, fmtMark(L), fsS, 'end', ' font-weight="bold"', 'tx txl');
    // штамп
    const zt = zc - 8 * a;
    text(0, zt, `${m.style} · ${m.styleName.toUpperCase()} — ФАСАД ${fmt(W, 2)} м, ${m.N} ЭТ. · М 1:${S}`, fs, 'start', ' font-weight="bold"');
    text(0, zt - 4 * a, `Генератор фасадов · тип по дому: ${m.house.address} (${m.house.years})`, fsS, 'start');
    text(0, zt - 7.5 * a, m.stepInfo, fsS, 'start');
    // масштабная линейка
    const zs = zt - 12 * a;
    const unit = S <= 200 ? 1 : S <= 500 ? 2 : 5;
    for (let i = 0; i < 5; i++) rect(i * unit, zs, (i + 1) * unit, zs + 0.8 * a, 'dim', i % 2 ? '#ffffff' : '#333333');
    for (let i = 0; i <= 5; i += 1) text(i * unit, zs - 2.4 * a, String(i * unit), fsS * 0.9);
    text(5 * unit + 1.5 * a, zs - 2.4 * a, 'м', fsS * 0.9, 'start');
    text(0, zs - 6.5 * a, 'Размеры — альбом facades.html: реконструкция по фото и контурам OSM с помощью ИИ,', fsS * 0.9, 'start', ' fill="#555"');
    text(0, zs - 9.5 * a, 'не натурный обмер, высоты ±0,5 м. Правила генератора — автора проекта (my_rules.md).', fsS * 0.9, 'start', ' fill="#555"');
    o.push('</svg>');
    return o.join('\n');
  }

  return {
    version: '1.0',
    EPS,
    W_MAX,
    RULE_TITLES,
    FLOOR_PLAN,
    getStyle,
    styleOptions,
    fillOptions,
    buildSection,
    generate,
    checkModel,
    floorRange,
    widthRange,
    albumRequest,
    validate,
    render,
    fmt,
    fmtMark
  };
});
