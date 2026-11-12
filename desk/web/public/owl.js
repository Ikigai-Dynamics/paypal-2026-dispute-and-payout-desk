/* Parley: a snowy owl companion for the dispute desk.
 * Technique: procedural Canvas 2D. The head is a sphere and the body an egg; every feature
 * (eyes, beak, brows, flecks, waistcoat seams, wings) lives in longitude/latitude on that
 * surface and is projected each frame, so a yaw turns the head into a true 3/4 view: the far
 * eye slides to the silhouette and foreshortens, the beak drifts, crown flecks wrap around.
 * Shading: radial gradients lit from the upper left, inked outlines heavier on the shadow
 * side, a soft-light grain overlay. No library, no assets, no build step.
 *
 * API:  const owl = ParleyOwl.mount(el);           // sizes itself to el (ResizeObserver)
 *       owl.lookAt(clientX, clientY)               // eyes lead, head follows into 3/4 views
 *       owl.play('idle'|'notebook'|'notebookAway'|'arrive')
 *       owl.talk(true|false)
 *       owl.react('surprised'|'approve'|'skeptical'|'poke')
 *       owl.destroy()
 * Honors prefers-reduced-motion: no breathing, head turns, hops or puffs; blinks and fades only.
 */
(function () {
  'use strict';
  var NAVY = '#003087', BLUE = '#009cde', GOLD = '#ffc439', INK = '#1a1d26';
  var W = 170, H = 220;                       // design space; everything scales from here
  var HEAD = { cx: 85, cy: 80, R: 44 };
  var BODY = { cx: 85, cy: 156, rx: 50, ry: 58 };
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var grainTile = null;
  function grain() {
    if (grainTile) return grainTile;
    var c = document.createElement('canvas'); c.width = c.height = 96;
    var g = c.getContext('2d'), img = g.createImageData(96, 96), d = img.data;
    for (var i = 0; i < d.length; i += 4) { var v = 110 + Math.random() * 40 | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    return (grainTile = c);
  }
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var easeOut = function (p) { return 1 - Math.pow(1 - p, 3); };
  var easeIO = function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };

  // Point (lon, lat) on a sphere of radius R turned by yaw (about Y) then pitch (about X).
  function sph(lon, lat, yaw, pitch) {
    var x = Math.sin(lon) * Math.cos(lat), y = Math.sin(lat), z = Math.cos(lon) * Math.cos(lat);
    var x1 = x * Math.cos(yaw) + z * Math.sin(yaw), z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
    var y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch), z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
    return { x: x1, y: -y2, z: z2, sx: Math.cos(lon + yaw), sy: Math.cos(lat + pitch) }; // sx/sy: tangent foreshortening
  }
  // Width of the egg at height y (wider at the bottom).
  function eggW(y) { var t = (y - BODY.cy) / BODY.ry; return BODY.rx * Math.sqrt(Math.max(0, 1 - t * t)) * (1 + 0.12 * t); }

  var CROWN = [[-0.95, 0.55], [-0.5, 0.78], [0.05, 0.88], [0.55, 0.72], [1.0, 0.5], [-1.25, 0.25], [1.3, 0.2], [-0.35, 1.0], [0.8, 0.95], [-1.1, 0.75], [1.15, 0.78]];

  function mount(el, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Parley, the snowy owl assistant');
    el.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    // S = current, T = target; each key eases toward its target at its own rate (per second).
    var S = { yaw: 0, pitch: 0, roll: 0, bodyYaw: 0, eyeX: 0, eyeY: 0, blink: 0, lidL: 0, lidR: 0, browL: 0, browR: 0, puff: 0, beak: 0, pupil: 1, smile: 0, nb: 0, write: 0, wide: 0, alpha: 1, nod: 0, yawX: 0 };
    var T = Object.assign({}, S);
    var RATE = { yaw: 5, pitch: 5, roll: 4, bodyYaw: 3.2, eyeX: 16, eyeY: 16, blink: 26, lidL: 10, lidR: 10, browL: 9, browR: 9, puff: 9, beak: 22, pupil: 10, smile: 6, nb: 2.8, write: 4, wide: 10, alpha: 4, nod: 6, yawX: 6 };

    var mode = 'idle', talking = false, look = { x: 0, y: 0, at: -1e9 }, timers = [], anim = null;
    var last = performance.now(), t0 = last, raf = 0, dead = false;
    var nextBlink = 1500 + Math.random() * 2500, nextTurn = 4000 + Math.random() * 4000, nextSettle = 7000, nextGlance = 2500;
    var size = { w: W, h: H, s: 1, ox: 0, oy: 0 };

    function fit() {
      var r = el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      var w = Math.max(1, r.width), h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var s = Math.min(w / W, h / H);
      size = { w: w, h: h, s: s, ox: (w - W * s) / 2, oy: (h - H * s), dpr: dpr }; // bottom-anchored
    }
    var ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(el); else window.addEventListener('resize', fit);
    fit();

    function after(ms, fn) { var id = setTimeout(fn, ms); timers.push(id); return id; }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }

    // ---- behaviours -------------------------------------------------------------------
    function lookAt(cx, cy) {
      var r = canvas.getBoundingClientRect();
      var hx = r.left + size.ox + (HEAD.cx + 10 * Math.sin(S.bodyYaw)) * size.s, hy = r.top + size.oy + HEAD.cy * size.s;
      var span = Math.max(r.width, 240);
      look = { x: clamp((cx - hx) / span, -1, 1), y: clamp((cy - hy) / (span * 0.9), -1, 1), at: performance.now() };
    }
    function play(state) {
      if (state === 'arrive') { anim = { kind: 'arrive', t0: performance.now(), dur: 650 }; return; }
      mode = state === 'notebook' ? 'notebook' : 'idle';
      if (mode === 'notebook') { T.nb = 1; T.bodyYaw = reduced ? 0.15 : 0.55; T.write = 1; nextGlance = 2200; }
      else { T.nb = 0; T.bodyYaw = 0; T.write = 0; }
    }
    function talk(on) { talking = !!on; if (!on) T.beak = 0; }
    function react(kind) {
      clearTimers();
      T.browL = T.browR = T.roll = T.lidL = T.lidR = T.smile = T.puff = T.wide = T.nod = T.yawX = 0; T.pupil = 1;
      if (kind === 'surprised') {
        T.wide = 1; T.pupil = 0.7; T.browL = T.browR = 1; if (!reduced) { T.puff = 1; T.nod = -0.12; }
        after(1100, function () { T.wide = 0; T.pupil = 1; T.browL = T.browR = 0; T.puff = 0; T.nod = 0; });
      } else if (kind === 'approve') {
        T.smile = 1; T.lidL = T.lidR = 0.25;
        if (!reduced) { T.nod = 0.42; after(450, function () { T.nod = -0.05; }); after(850, function () { T.nod = 0.3; }); after(1250, function () { T.nod = 0; }); }
        after(1900, function () { T.smile = 0; T.lidL = T.lidR = 0; });
      } else if (kind === 'skeptical') {
        T.browL = 0.55; T.browR = -0.7; T.lidR = 0.45; T.lidL = 0.1; if (!reduced) { T.roll = -0.16; T.yawX = 0.14; }
        after(2000, function () { T.browL = T.browR = T.lidL = T.lidR = T.roll = T.yawX = 0; });
      } else if (kind === 'poke') {
        T.wide = 1; T.pupil = 0.65; T.blink = 0; T.browL = T.browR = 0.8;
        if (!reduced) { T.puff = 0.7; anim = { kind: 'flinch', t0: performance.now(), dur: 420 }; T.yawX = -0.35; T.nod = -0.2; T.roll = 0.12; }
        after(380, function () { T.puff = 0.15; T.roll = 0; T.nod = 0; T.yawX = 0; });
        after(900, function () { T.wide = 0; T.pupil = 1; T.browL = T.browR = 0; T.puff = 0; T.lidL = T.lidR = 0.15; }); // regains composure
        after(1900, function () { T.lidL = T.lidR = 0; });
      }
    }

    // ---- per-frame targets --------------------------------------------------------------
    function think(now, dt) {
      var t = (now - t0) / 1000, sinceLook = now - look.at;
      var tracking = sinceLook < 4000;
      var headX = tracking ? look.x : 0, headY = tracking ? look.y : 0;
      T.eyeX = tracking ? look.x : 0; T.eyeY = tracking ? look.y * 0.8 : 0;

      if (mode === 'notebook') {
        var glancing = (now % 4200) < 950;                       // every so often, look up at the user
        if (reduced) glancing = false;
        T.pitch = glancing ? 0.05 : 0.38;
        T.yaw = glancing ? headX * 0.55 : (reduced ? 0 : 0.28);
        T.eyeX = glancing ? headX : -0.15; T.eyeY = glancing ? headY * 0.5 : 0.6;
      } else {
        if (!reduced) { T.yaw = headX * 0.78; T.pitch = headY * 0.42; }
        if (!tracking && !reduced) {
          nextTurn -= dt * 1000;
          if (nextTurn < 0) { T.yaw = (Math.random() - 0.5) * 0.9; T.pitch = (Math.random() - 0.5) * 0.25; after(1500, function () { if (performance.now() - look.at > 4000) { T.yaw = 0; T.pitch = 0; } }); nextTurn = 5000 + Math.random() * 5000; }
        }
      }
      // blink
      nextBlink -= dt * 1000;
      if (nextBlink < 0) { T.blink = 1; after(110, function () { T.blink = 0; }); if (Math.random() < 0.2) after(260, function () { T.blink = 1; after(100, function () { T.blink = 0; }); }); nextBlink = 2400 + Math.random() * 4000; }
      // feather settle
      if (!reduced) { nextSettle -= dt * 1000; if (nextSettle < 0 && T.puff === 0) { T.puff = 0.2; after(350, function () { if (T.puff === 0.2) T.puff = 0; }); nextSettle = 6000 + Math.random() * 8000; } }
      // talking
      if (talking) {
        var o = Math.abs(Math.sin(t * 9.3) * Math.sin(t * 5.1)) * 0.85;
        T.beak = o < 0.12 ? 0 : o;
      }
      for (var k in S) { var a = 1 - Math.exp(-RATE[k] * dt); S[k] += (T[k] - S[k]) * a; }
      S.blink = clamp(S.blink, 0, 1);
    }

    // ---- drawing ----------------------------------------------------------------------
    function ink(w) { ctx.strokeStyle = INK; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; }
    function sphereFill(cx, cy, r, c0, c1, c2) {
      var g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.1, cx, cy, r * 1.08);
      g.addColorStop(0, c0); g.addColorStop(0.55, c1); g.addColorStop(1, c2); return g;
    }
    function shade(cx, cy, r, k) {                               // lower-right terminator shadow
      var g = ctx.createRadialGradient(cx + r * 0.55, cy + r * 0.6, r * 0.2, cx + r * 0.3, cy + r * 0.3, r * 1.15);
      g.addColorStop(0, 'rgba(70,82,110,' + k + ')'); g.addColorStop(1, 'rgba(70,82,110,0)'); return g;
    }
    function leaf(a, b, w1, w2) {                                // tapered wing between two points
      var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, px = -dy / L, py = dx / L;
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(a.x + dx * 0.45 + px * w1, a.y + dy * 0.45 + py * w1, b.x, b.y);
      ctx.quadraticCurveTo(a.x + dx * 0.5 - px * w2, a.y + dy * 0.5 - py * w2, a.x, a.y);
      ctx.closePath();
    }
    function fleck(x, y, w, h, rot, a) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(Math.max(0.05, w), h);
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.restore();
      ctx.fillStyle = 'rgba(58,64,80,' + (a == null ? 0.7 : a) + ')'; ctx.fill();
    }

    function drawBody(breath, bodyX) {
      var cx = BODY.cx + bodyX, cy = BODY.cy, by = S.bodyYaw;
      function P(lon, y) { return { x: cx + eggW(y) * Math.sin(lon + by), y: y, z: Math.cos(lon + by) }; }
      function eggPath() {
        ctx.beginPath();
        for (var i = 0; i <= 48; i++) { var th = i / 48 * Math.PI * 2, y = cy + BODY.ry * breath * Math.sin(th), x = cx + eggW(cy + BODY.ry * Math.sin(th)) * Math.cos(th); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath();
      }
      var shoulderY = 120, holding = S.nb;
      var nbPos = { x: cx - 2, y: 150 };                            // where the notebook is held
      function wing(side, front) {                                  // side -1 left, +1 right
        var sh = P(side * 1.0, shoulderY), tipRest = { x: cx + side * (eggW(186) + 6), y: 188 };
        var tipHold = side < 0 ? { x: nbPos.x - 10, y: nbPos.y + 12 } : { x: nbPos.x + 9 + Math.sin(performance.now() / 70) * 1.3 * S.write, y: nbPos.y - 6 + Math.cos(performance.now() / 95) * 0.9 * S.write };
        var k = easeIO(clamp(holding * 1.25, 0, 1));
        var tip = { x: tipRest.x + (tipHold.x - tipRest.x) * k, y: tipRest.y + (tipHold.y - tipRest.y) * k };
        var w1 = 13 * (1 - k * 0.45) + S.puff * 1.5, w2 = 4;
        leaf(sh, tip, side * w1, side * w2);
        ctx.fillStyle = front ? sphereFill(sh.x - side * 6, 150, 60, '#ffffff', '#f2f4f8', '#d7dde6') : '#dfe4ec'; ctx.fill();
        ink(1.5); ctx.stroke();
        if (front) { for (var i = 1; i <= 4; i++) { var f = i / 5, fx = sh.x + (tip.x - sh.x) * f + side * (w1 * 0.55) * Math.sin(f * Math.PI), fy = sh.y + (tip.y - sh.y) * f; fleck(fx, fy, 3.2, 1.2, side * 0.5, 0.55); } }
      }
      // far wing(s)
      var leftFront = Math.cos(-1.0 + by) > 0.15 || holding > 0.02, rightFront = Math.cos(1.0 + by) > 0.15 || holding > 0.02;
      if (!leftFront) wing(-1, false); if (!rightFront) wing(1, false);
      // egg
      eggPath(); ctx.fillStyle = sphereFill(cx, cy - 10, BODY.ry, '#ffffff', '#f3f5f8', '#cfd6df'); ctx.fill();
      eggPath(); ctx.fillStyle = shade(cx, cy, BODY.ry, 0.22); ctx.fill();
      // waistcoat (projected onto the egg so it turns with the body)
      ctx.save(); eggPath(); ctx.clip();
      var vTop = 124, vBot = 146;
      ctx.beginPath();
      var a = P(-0.95, vTop), b = P(0, vBot), c = P(0.95, vTop);
      ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(P(-0.5, 134).x, 134, b.x, b.y); ctx.quadraticCurveTo(P(0.5, 134).x, 134, c.x, c.y);
      for (var y = vTop; y <= 212; y += 8) { var q = P(1.15, y); ctx.lineTo(q.x, q.y); }
      ctx.lineTo(cx + 60, 230); ctx.lineTo(cx - 60, 230);
      for (y = 212; y >= vTop; y -= 8) { q = P(-1.15, y); ctx.lineTo(q.x, q.y); }
      ctx.closePath();
      var vg = ctx.createLinearGradient(cx - 50, 120, cx + 30, 200); vg.addColorStop(0, '#1a4aa6'); vg.addColorStop(0.45, NAVY); vg.addColorStop(1, '#021a4d');
      ctx.fillStyle = vg; ctx.fill(); ink(1.6); ctx.stroke();
      // lapels
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(P(-0.35, 140).x, 140, b.x, b.y); ctx.lineTo(P(-0.25, 150).x, 150); ctx.quadraticCurveTo(P(-0.75, 134).x, 136, a.x, a.y);
      ctx.moveTo(c.x, c.y); ctx.quadraticCurveTo(P(0.35, 140).x, 140, b.x, b.y); ctx.lineTo(P(0.25, 150).x, 150); ctx.quadraticCurveTo(P(0.75, 134).x, 136, c.x, c.y);
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill(); ink(1.1); ctx.stroke();
      // buttons
      [152, 168, 184].forEach(function (yy) { var p = P(0, yy); if (p.z < 0) return; ctx.beginPath(); ctx.ellipse(p.x, yy, 2.4 * Math.max(0.2, p.z), 2.4, 0, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill(); ink(0.8); ctx.stroke(); });
      // pockets: right one holds the notebook, its gold clip peeks out until it is drawn
      var pl = P(-0.5, 160), pr = P(0.5, 160);
      ink(1.1); ctx.beginPath(); ctx.moveTo(pl.x - 7 * Math.abs(pl.z), 160); ctx.lineTo(pl.x + 7 * Math.abs(pl.z), 160); ctx.moveTo(pr.x - 7 * Math.abs(pr.z), 160); ctx.lineTo(pr.x + 7 * Math.abs(pr.z), 160); ctx.stroke();
      if (holding < 0.1 && pr.z > 0) { ctx.fillStyle = GOLD; ctx.fillRect(pr.x + 1, 155, 2.2 * pr.z + 0.6, 6); ctx.strokeRect(pr.x + 1, 155, 2.2 * pr.z + 0.6, 6); }
      // watch chain: middle button to the left pocket
      var bm = P(0, 168);
      if (bm.z > 0 && pl.z > 0) { ctx.beginPath(); ctx.moveTo(bm.x, 168); ctx.quadraticCurveTo((bm.x + pl.x) / 2, 180, pl.x, 161); ctx.strokeStyle = GOLD; ctx.lineWidth = 1.3; ctx.setLineDash([1.2, 1.4]); ctx.stroke(); ctx.setLineDash([]); }
      ctx.restore();
      eggPath(); ink(1.8); ctx.stroke();
      // chest flecks above the waistcoat
      [[-0.55, 110], [0.5, 112], [-0.1, 104], [0.9, 118]].forEach(function (f) { var p = P(f[0], f[1]); if (p.z > 0) fleck(p.x, f[1], 2.6 * p.z, 1.1, 0, 0.5); });
      // feet
      [-1, 1].forEach(function (sd) {
        var fx = cx + sd * 15 + 6 * Math.sin(by), fy = 209;
        ctx.beginPath(); ctx.ellipse(fx, fy, 11, 5.5, 0, 0, Math.PI * 2); ctx.fillStyle = '#eef1f5'; ctx.fill(); ink(1.3); ctx.stroke();
        for (var i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(fx + i * 5, fy + 4); ctx.lineTo(fx + i * 6, fy + 8); ctx.strokeStyle = '#3a4050'; ctx.lineWidth = 2; ctx.stroke(); }
      });
      // front wing(s) and notebook
      if (leftFront) wing(-1, true);
      if (holding > 0.02) {
        var k = easeIO(clamp((holding - 0.15) / 0.6, 0, 1)), pk = P(0.5, 160);
        var nx = pk.x + (nbPos.x - pk.x) * k, ny = 164 + (nbPos.y - 164) * k, sc = 0.3 + 0.7 * k;
        ctx.save(); ctx.translate(nx, ny); ctx.rotate(-0.18 + 0.1 * (1 - k)); ctx.scale(sc, sc);
        if (k < 1) { ctx.globalAlpha = clamp(k * 2 + 0.25, 0, 1); }
        ctx.beginPath(); ctx.rect(-13, -16, 26, 32); ctx.fillStyle = '#f7f3e8'; ctx.fill(); ink(1.3); ctx.stroke();   // pages
        ctx.beginPath(); ctx.rect(-14, -17, 26, 32); ctx.fillStyle = NAVY; ctx.fill(); ctx.stroke();                  // cover
        ctx.fillStyle = GOLD; ctx.fillRect(-4, -19, 7, 8); ink(0.9); ctx.strokeRect(-4, -19, 7, 8);                 // clip
        ctx.beginPath(); ctx.rect(-14, -17, 26, 32); ctx.clip();                                                      // open page lines
        ctx.fillStyle = '#f7f3e8'; ctx.fillRect(-11, -14, 20, 26);
        ctx.strokeStyle = 'rgba(0,48,135,0.35)'; ctx.lineWidth = 0.8;
        var lines = Math.floor(S.write * ((performance.now() / 900) % 6));
        for (var li = 0; li < 6; li++) { ctx.beginPath(); ctx.moveTo(-8, -9 + li * 4); ctx.lineTo(li < lines ? 6 : -8, -9 + li * 4); ctx.stroke(); }
        ctx.restore();
      }
      if (rightFront) wing(1, true);
      if (holding > 0.4) {                                          // pencil in the right wing tip
        var k2 = easeIO(clamp((holding - 0.4) / 0.5, 0, 1));
        var px = nbPos.x + 9 + Math.sin(performance.now() / 70) * 1.3 * S.write, py = nbPos.y - 6 + Math.cos(performance.now() / 95) * 0.9 * S.write;
        ctx.save(); ctx.translate(px, py); ctx.rotate(-0.9); ctx.globalAlpha = k2;
        ctx.fillStyle = GOLD; ctx.fillRect(-1.6, -3, 3.2, 14); ink(0.9); ctx.strokeRect(-1.6, -3, 3.2, 14);
        ctx.beginPath(); ctx.moveTo(-1.6, -3); ctx.lineTo(0, -7); ctx.lineTo(1.6, -3); ctx.fillStyle = '#e8d9b8'; ctx.fill(); ctx.stroke();
        ctx.fillStyle = INK; ctx.fillRect(-0.6, -7, 1.2, 1.8);
        ctx.restore();
      }
    }

    function drawHead(breath, bodyX) {
      var yaw = S.yaw + S.yawX, pitch = S.pitch + S.nod + (talking && !reduced ? 0.05 * Math.sin(performance.now() / 380) : 0), R = HEAD.R * (1 + 0.05 * S.puff);
      var cx = HEAD.cx + bodyX + 7 * Math.sin(S.bodyYaw) + 4 * Math.sin(yaw), cy = HEAD.cy - 2 * (breath - 1) * 60 + 2 * pitch;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(S.roll);
      function pt(lon, lat) { var p = sph(lon, lat, yaw, pitch); return { x: p.x * R, y: p.y * R, z: p.z, sx: p.sx, sy: p.sy }; }
      // head: puffed outline is a soft ruffle, not spikes
      function headPath(extra) {
        ctx.beginPath();
        for (var i = 0; i <= 60; i++) { var th = i / 60 * Math.PI * 2, r = R + (extra || 0) + S.puff * 2.2 * Math.sin(th * 13 + 1) + 1.2 * Math.sin(th * 7); var x = Math.cos(th) * r, y = Math.sin(th) * r * 0.98; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath();
      }
      headPath(); ctx.fillStyle = sphereFill(0, 0, R, '#ffffff', '#f4f6f9', '#cdd4de'); ctx.fill();
      headPath(); ctx.fillStyle = shade(0, 0, R, 0.2); ctx.fill();
      // back of the head shows on the side turned away
      if (Math.abs(yaw) > 0.02) { ctx.save(); headPath(); ctx.clip(); var sd = -Math.sign(yaw), g = ctx.createLinearGradient(sd * R, 0, sd * R * 0.1, 0); g.addColorStop(0, 'rgba(90,100,125,' + 0.16 * Math.min(1, Math.abs(yaw) * 1.6) + ')'); g.addColorStop(1, 'rgba(90,100,125,0)'); ctx.fillStyle = g; ctx.fillRect(-R - 4, -R - 4, 2 * R + 8, 2 * R + 8); ctx.restore(); }
      // crown flecks wrap around the sphere
      CROWN.forEach(function (f) { var p = pt(f[0], f[1]); if (p.z > 0.08) fleck(p.x, p.y, 3 * Math.abs(p.sx) * Math.sqrt(p.z), 1.25, 0, 0.5 + 0.3 * p.z); });
      // facial disc halves
      var EL = 0.36, LAT = 0.06;
      [-1, 1].forEach(function (sd) {
        var p = pt(sd * EL, LAT), dr = 19.5;
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 1.5, dr * Math.max(0.12, p.sx) * (0.8 + 0.2 * p.z), dr * Math.max(0.3, p.sy), 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,253,248,0.9)'; ctx.fill(); ctx.strokeStyle = 'rgba(70,80,100,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      });
      // eyes
      [-1, 1].forEach(function (sd) {
        var p = pt(sd * EL, LAT), fx = Math.max(0.1, p.sx), fy = Math.max(0.3, p.sy), r = 9.6 * (1 + 0.12 * S.wide);
        var lid = clamp(S.blink + (sd < 0 ? S.lidL : S.lidR), 0, 1);
        ctx.save(); ctx.translate(p.x, p.y); ctx.scale(fx, fy);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#f6f8fb'; ctx.fill();
        var ex = S.eyeX * 2.6 + yaw * 1.5 / fx * 0.3, ey = S.eyeY * 2.2 + pitch * 1.4;             // pupils lead the head
        var ig = ctx.createRadialGradient(ex - 3, ey - 3, 1, ex, ey, r * 0.9); ig.addColorStop(0, '#5fd0ff'); ig.addColorStop(0.6, BLUE); ig.addColorStop(1, '#0062a8');
        ctx.beginPath(); ctx.arc(ex, ey, r * 0.9, 0, Math.PI * 2); ctx.fillStyle = ig; ctx.fill();
        ctx.beginPath(); ctx.arc(ex, ey, r * 0.44 * S.pupil, 0, Math.PI * 2); ctx.fillStyle = '#10131c'; ctx.fill();
        ctx.beginPath(); ctx.arc(ex - 3, ey - 3.2, 1.9, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
        ctx.beginPath(); ctx.arc(ex + 2.2, ey + 2.6, 0.9, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fill();
        // lids: upper comes down with blink/droop, lower rises with the smile
        ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r + 0.5, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#fbfaf6';
        if (lid > 0.01) { ctx.fillRect(-r - 1, -r - 1, 2 * r + 2, 2 * r * lid + 1); ink(1.2); ctx.beginPath(); ctx.moveTo(-r, -r + 2 * r * lid); ctx.lineTo(r, -r + 2 * r * lid); ctx.stroke(); }
        if (S.smile > 0.01) { var sm = 0.38 * S.smile; ctx.beginPath(); ctx.ellipse(0, r + r * 0.6 - 2 * r * sm * 0.5, r * 1.3, r * 0.9, 0, 0, Math.PI * 2); ctx.fill(); ink(1.1); ctx.stroke(); }
        ctx.restore();
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ink(1.7); ctx.stroke();
        ctx.restore();
        // brow ridge
        var b = pt(sd * (EL + 0.02), LAT + 0.36), raise = (sd < 0 ? S.browL : S.browR) * 3.2 + S.wide * 1.5;
        ctx.save(); ctx.translate(b.x, b.y - raise); ctx.scale(Math.max(0.15, b.sx), 1);
        ctx.beginPath(); ctx.moveTo(-10, 3); ctx.quadraticCurveTo(-2, -3 - raise * 0.4, 9, 1 + (sd < 0 ? -S.browL : S.browR) * 0.5);
        ink(2.3); ctx.strokeStyle = 'rgba(30,34,46,0.85)'; ctx.stroke(); ctx.restore();
      });
      // beak
      var bk = pt(0, -0.2), open = S.beak * 4.5, sx = Math.max(0.35, bk.sx);
      ctx.save(); ctx.translate(bk.x, bk.y); ctx.scale(sx, 1);
      ctx.beginPath(); ctx.moveTo(-4.6, -1); ctx.quadraticCurveTo(0, -4, 4.6, -1); ctx.quadraticCurveTo(2, 5, 0, 7.5); ctx.quadraticCurveTo(-2, 5, -4.6, -1); ctx.closePath();
      var bg = ctx.createLinearGradient(-4, -3, 3, 7); bg.addColorStop(0, '#5a5f6e'); bg.addColorStop(1, '#14171f'); ctx.fillStyle = bg; ctx.fill(); ink(1.2); ctx.stroke();
      if (open > 0.3) { ctx.beginPath(); ctx.moveTo(-3.2, 4); ctx.quadraticCurveTo(0, 4 + open * 1.6, 3.2, 4); ctx.lineTo(0, 6 + open); ctx.closePath(); ctx.fillStyle = '#2b1e22'; ctx.fill(); ctx.stroke(); }
      ctx.restore();
      // outline, heavier on the shadow side
      headPath(); ink(1.8); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R + 0.6, 0.15, 1.75); ink(2.8); ctx.strokeStyle = 'rgba(26,29,38,0.55)'; ctx.stroke();
      ctx.restore();
    }

    function draw(now) {
      var t = (now - t0) / 1000, breath = reduced ? 1 : 1 + 0.012 * Math.sin(t * 1.15);
      var offX = 0, offY = 0, alpha = 1;
      if (anim) {
        var p = clamp((now - anim.t0) / anim.dur, 0, 1);
        if (anim.kind === 'arrive') { if (reduced) alpha = p; else { offX = (1 - easeOut(p)) * 46; offY = -Math.sin(p * Math.PI) * 11; } }
        else if (anim.kind === 'flinch') { offX = -Math.sin(p * Math.PI) * 4; offY = -Math.sin(Math.min(1, p * 1.6) * Math.PI) * 4; }
        if (p >= 1) anim = null;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(size.dpr * size.s, 0, 0, size.dpr * size.s, size.dpr * (size.ox + offX * size.s), size.dpr * (size.oy + offY * size.s));
      ctx.globalAlpha = alpha * S.alpha;
      // ground shadow (stays on the ground while the owl hops)
      ctx.save(); ctx.translate(-offX, -offY);
      var gs = ctx.createRadialGradient(85, 215, 2, 85, 215, 42); gs.addColorStop(0, 'rgba(10,20,40,0.22)'); gs.addColorStop(1, 'rgba(10,20,40,0)');
      ctx.fillStyle = gs; ctx.beginPath(); ctx.ellipse(85, 215, 42, 5.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      var bodyX = 0;
      drawBody(breath, bodyX);
      drawHead(breath, bodyX);
      // grain, clipped to the owl
      try {
        var pat = ctx.createPattern(grain(), 'repeat');
        if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(1 / (size.s * size.dpr)));
        ctx.save(); ctx.beginPath(); ctx.ellipse(BODY.cx, BODY.cy + 2, BODY.rx - 4, BODY.ry - 3, 0, 0, Math.PI * 2);
        ctx.arc(HEAD.cx + 7 * Math.sin(S.bodyYaw) + 4 * Math.sin(S.yaw), HEAD.cy, HEAD.R - 3, 0, Math.PI * 2); ctx.clip();
        ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.5 * alpha; ctx.fillStyle = pat; ctx.fillRect(-20, -20, W + 40, H + 40);
        ctx.restore();
      } catch (e) { /* grain is decoration */ }
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      if (dead) return;
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!document.hidden) { think(now, dt); draw(now); }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      lookAt: lookAt, play: play, talk: talk, react: react,
      destroy: function () { dead = true; cancelAnimationFrame(raf); clearTimers(); if (ro) ro.disconnect(); else window.removeEventListener('resize', fit); canvas.remove(); }
    };
  }

  window.ParleyOwl = { mount: mount };
})();
