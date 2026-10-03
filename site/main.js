// RecallNest launch page: one particle cloud that morphs between eight shapes as the page scrolls.
// Scroll position decides the state; idle motion is cosmetic and switched off by ?still or reduce-motion.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var still = params.has('still') || reduceQuery.matches;
  var canvas = document.getElementById('field');
  var labelEls = Array.prototype.slice.call(document.querySelectorAll('#labels .client'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  var dots = Array.prototype.slice.call(document.querySelectorAll('.dots a'));
  var BEATS = sections.map(function (s) { return s.id; });

  var api = window.__recallnest = {
    ready: false, gl: false, layout: '', count: 0, frames: [],
    progress: function () { return state.g; },
    view: function (name) { jumpTo(name); }
  };

  // ---------- language ----------
  Array.prototype.forEach.call(document.querySelectorAll('[data-lang-toggle]'), function (b) {
    b.addEventListener('click', function () {
      var next = root.dataset.lang === 'zh' ? 'en' : 'zh';
      root.dataset.lang = next;
      root.lang = next === 'zh' ? 'zh-CN' : 'en';
      try { localStorage.setItem('rn-lang', next); } catch (e) { /* private mode */ }
      requestDraw();
    });
  });

  // ---------- layout and scroll mapping ----------
  function isPortrait() { return window.innerWidth < 760 || window.innerWidth / window.innerHeight < 0.9; }

  var anchors = [];
  function measure() {
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    anchors = sections.map(function (s, i) {
      if (i === 0) return 0;
      var a = s.offsetTop + s.offsetHeight / 2 - window.innerHeight / 2;
      return Math.min(max, Math.max(0, a));
    });
    if (anchors.length) anchors[anchors.length - 1] = max;
  }

  function smooth(e0, e1, x) { var t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

  function progressAt(y) {
    var n = anchors.length;
    if (!n) return { g: 0, raw: 0 };
    if (y <= anchors[0]) return { g: 0, raw: 0 };
    for (var i = 0; i < n - 1; i++) {
      if (y < anchors[i + 1]) {
        var span = anchors[i + 1] - anchors[i];
        var t = span > 0 ? (y - anchors[i]) / span : 1;
        return { g: i + smooth(0.22, 0.78, t), raw: i + t };
      }
    }
    return { g: n - 1, raw: n - 1 };
  }

  function jumpTo(name) {
    var i = BEATS.indexOf(name);
    if (i < 0) return;
    window.scrollTo({ top: anchors[i], behavior: 'instant' });
    requestDraw();
  }

  // ---------- deterministic randomness ----------
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    var u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  // ---------- particles ----------
  var N, rnd, cat, age, flags, client, hitRank, strand, along, meta;
  var STRANDS = 72;
  var strandParams = [];
  var TAU = Math.PI * 2;
  var CAT_PATTERNS = 5;
  var F_PINNED = 1, F_HIT = 2, F_BEAM = 4, F_RECENT = 8;

  function initParticles(count) {
    N = count;
    var rand = mulberry(20261003);
    rnd = new Float32Array(N * 8);
    cat = new Uint8Array(N); age = new Float32Array(N); flags = new Uint8Array(N);
    client = new Uint8Array(N); hitRank = new Uint8Array(N);
    strand = new Uint16Array(N); along = new Float32Array(N);
    meta = new Float32Array(N * 4);
    var H = Math.round(N * 0.012), B = Math.round(N * 0.035);
    var perStrand = Math.ceil(N / STRANDS);
    var sr = mulberry(1003);
    strandParams = [];
    for (var s = 0; s < STRANDS; s++) {
      var kind = s < STRANDS * 0.4 ? 0 : (s < STRANDS * 0.75 ? 1 : 2);
      strandParams.push({
        kind: kind,                       // 0 rim twist, 1 diagonal wall twig, 2 base spiral
        m: 3 + Math.floor(sr() * 4),
        phi0: sr() * TAU,
        psi0: sr() * TAU,
        rr: 0.75 + sr() * 0.5,
        span: 1.2 + sr() * 1.2,
        dir: s % 2 ? 1 : -1,
        b: sr()
      });
    }
    for (var i = 0; i < N; i++) {
      for (var k = 0; k < 8; k++) rnd[i * 8 + k] = rand();
      cat[i] = Math.floor(rand() * 6);
      age[i] = rand();
      client[i] = i % 7;
      strand[i] = i % STRANDS;
      along[i] = (Math.floor(i / STRANDS) + 0.5 + (rand() - 0.5) * 0.3) / perStrand;
      var f = 0;
      if (i < 5 * H) { f |= F_HIT; hitRank[i] = 1 + Math.floor(i / H); }
      else if (i < 5 * H + B) f |= F_BEAM;
      else {
        if (rand() < 0.06) f |= F_PINNED;
        if (rand() < 0.08) f |= F_RECENT;
      }
      flags[i] = f;
      meta[i * 4] = rnd[i * 8];
      // integer part: category; fractional part: brightness of the strand this particle sits on
      meta[i * 4 + 1] = cat[i] + 0.1 + 0.8 * strandParams[strand[i]].b;
      meta[i * 4 + 2] = age[i];
      meta[i * 4 + 3] = f;
    }
  }

  function exempt(i) { return (flags[i] & (F_PINNED | F_RECENT)) !== 0 || cat[i] === CAT_PATTERNS; }

  // nest: twisted strands around the rim, diagonal twigs crossing the bowl wall, a spiral base
  function bowlRadius(y) { var t = (y - 0.15) / 0.95; return 1.45 * Math.sqrt(Math.max(0, 1 - t * t)); }
  function nestPoint(i, out, scale, jr) {
    var p = strandParams[strand[i]], u = along[i], x, y, z, wob = 0.03 * Math.sin(u * 17 + p.phi0 * 3);
    if (p.kind === 0) {
      var phi = TAU * u + p.phi0, psi = TAU * p.m * u + p.psi0;
      var R = 1.5 + wob, r = 0.17 * p.rr;
      x = (R + r * Math.cos(psi)) * Math.cos(phi);
      z = (R + r * Math.cos(psi)) * Math.sin(phi);
      y = 0.17 + r * Math.sin(psi);
    } else if (p.kind === 1) {
      var a = p.phi0 + p.dir * p.span * u;
      y = 0.12 - 0.72 * u;
      var br = bowlRadius(y) + wob;
      x = br * Math.cos(a); z = br * Math.sin(a);
    } else {
      var rad = 0.95 * Math.pow(u, 0.8) + wob, ang = TAU * p.m * 0.7 * u + p.phi0;
      x = rad * Math.cos(ang); z = rad * Math.sin(ang);
      y = -0.64 + 0.2 * Math.pow(rad / 0.95, 2);
    }
    out[0] = (x + gauss(jr) * 0.014) * scale;
    out[1] = (y + gauss(jr) * 0.014) * scale;
    out[2] = (z + gauss(jr) * 0.014) * scale;
  }

  function coilPoint(i, out, jr) {
    var c = cat[i], a = TAU * rnd[i * 8 + 3];
    var R = 0.72 + 0.18 * c, y = -0.62 + 0.21 * c;
    var rr = R + gauss(jr) * 0.03;
    out[0] = rr * Math.cos(a);
    out[1] = y + 0.035 * Math.sin(a * 12 + c * 1.7) + gauss(jr) * 0.025;
    out[2] = rr * Math.sin(a);
  }

  var CLIENTS_LAND = [[-1.3, 1.6, -1.0], [0.1, 2.2, -1.8], [1.6, 1.8, -0.6], [2.5, 0.4, -1.4], [1.7, -1.5, -0.2], [0.1, -1.6, -1.2], [-1.1, -0.6, -0.4]];
  var CLIENTS_PORT = [[-1.3, 1.9, -0.8], [0.4, 2.5, -1.4], [1.5, 1.3, -0.6], [1.2, -0.2, -1.2], [-0.1, 0.6, 0.0], [-1.5, 0.1, -1.0], [0.2, -1.0, -0.6]];
  var homeCenters = [];

  function swirl(i, out, center, radius, tiltX, tiltZ, jr) {
    var rad = radius * (0.3 + 0.7 * Math.sqrt(rnd[i * 8 + 5]));
    var a = TAU * Math.floor(rnd[i * 8 + 4] * 3) / 3 + rad / radius * 4.2 + client[i] * 1.3 + gauss(jr) * 0.18;
    var x = rad * Math.cos(a), y = gauss(jr) * 0.04, z = rad * Math.sin(a);
    var cx = Math.cos(tiltX), sx = Math.sin(tiltX), y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    var cz = Math.cos(tiltZ), sz = Math.sin(tiltZ), x2 = x * cz - y1 * sz, y2 = x * sz + y1 * cz;
    out[0] = center[0] + x2; out[1] = center[1] + y2; out[2] = center[2] + z1;
  }

  var SHAPES = 8, shapes = [], layout = '';

  function buildShapes() {
    layout = isPortrait() ? 'portrait' : 'landscape';
    var port = layout === 'portrait';
    var clients = port ? CLIENTS_PORT : CLIENTS_LAND;
    var ringR = port ? 1.55 : 1.7;
    homeCenters = [];
    for (var c = 0; c < 7; c++) {
      var th = TAU * c / 7 - Math.PI / 2;
      homeCenters.push([ringR * Math.cos(th), 0, ringR * Math.sin(th), th]);
    }
    shapes = [];
    for (var s = 0; s < SHAPES; s++) shapes.push(new Float32Array(N * 3));
    var jr = mulberry(77), o = [0, 0, 0], tmp = [0, 0, 0];
    for (var i = 0; i < N; i++) {
      var j = i * 3, f = flags[i], k = client[i], r = i * 8;

      // 0 hero: the nest
      nestPoint(i, o, 0.8, jr); shapes[0][j] = o[0]; shapes[0][j + 1] = o[1]; shapes[0][j + 2] = o[2];

      // 1 scattered: one swirl per client
      swirl(i, o, clients[k], port ? 0.36 : 0.46, 1.1, k * 0.7, jr);
      shapes[1][j] = o[0]; shapes[1][j + 1] = o[1]; shapes[1][j + 2] = o[2];

      // 2 one store: streams from each client into a dense disc
      var u = Math.pow(rnd[r + 2], 0.75), S = clients[k];
      var er = 0.5 * Math.sqrt(rnd[r + 6]), ea = TAU * rnd[r + 7];
      var E = [er * Math.cos(ea), -0.05 + gauss(jr) * 0.03, er * Math.sin(ea)];
      var Q = [(S[0] + E[0]) / 2 - S[2] * 0.35, (S[1] + E[1]) / 2 + 0.6, (S[2] + E[2]) / 2 + S[0] * 0.35];
      var w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u, js = 0.06 * (1 - u);
      shapes[2][j] = w0 * S[0] + w1 * Q[0] + w2 * E[0] + gauss(jr) * js;
      shapes[2][j + 1] = w0 * S[1] + w1 * Q[1] + w2 * E[1] + gauss(jr) * js;
      shapes[2][j + 2] = w0 * S[2] + w1 * Q[2] + w2 * E[2] + gauss(jr) * js;

      // 3 woven: six coils, one per category
      coilPoint(i, tmp, jr);
      shapes[3][j] = tmp[0]; shapes[3][j + 1] = tmp[1]; shapes[3][j + 2] = tmp[2];

      // 4 recall: coils sink back, a beam drops in, five knots rise as the ranked hits
      if (f & F_HIT) {
        var h = hitRank[i] - 1, spread = h === 0 ? 0.085 : 0.065;
        var kc = port ? [-1.08 + h * 0.54, 1.45, 0.5] : [1.5, 0.9 - h * 0.4, 0.7];
        shapes[4][j] = kc[0] + gauss(jr) * spread; shapes[4][j + 1] = kc[1] + gauss(jr) * spread; shapes[4][j + 2] = kc[2] + gauss(jr) * spread;
      } else if (f & F_BEAM) {
        var bu = rnd[r + 1];
        shapes[4][j] = gauss(jr) * 0.018; shapes[4][j + 1] = (port ? 2.4 : 2.7) * bu - 0.05; shapes[4][j + 2] = gauss(jr) * 0.018;
      } else {
        shapes[4][j] = tmp[0] * 0.82; shapes[4][j + 1] = tmp[1] * 0.82 - 0.35; shapes[4][j + 2] = tmp[2] * 0.82 - 0.2;
      }

      // 5 decay: what is not exempt sags and spreads as it fades (brightness is done in the shader)
      var fall = exempt(i) ? 0 : 1 - Math.exp(-Math.pow(age[i] / 0.55, 1.6));
      var spreadR = 1 + 0.18 * fall;
      shapes[5][j] = tmp[0] * spreadR; shapes[5][j + 1] = tmp[1] - 0.45 * fall * fall; shapes[5][j + 2] = tmp[2] * spreadR;

      // 6 home: a small nest, every client on a ring, streams between them
      var hc = homeCenters[k], part = rnd[r + 6];
      if (part < 0.5 || (f & (F_HIT | F_BEAM))) {
        shapes[6][j] = tmp[0] * 0.55; shapes[6][j + 1] = tmp[1] * 0.55; shapes[6][j + 2] = tmp[2] * 0.55;
      } else if (part < 0.72) {
        swirl(i, o, hc, port ? 0.2 : 0.26, 0, 0, jr);
        shapes[6][j] = o[0]; shapes[6][j + 1] = o[1]; shapes[6][j + 2] = o[2];
      } else {
        var su = rnd[r + 7], sx0 = 0.62 * Math.cos(hc[3]), sz0 = 0.62 * Math.sin(hc[3]);
        shapes[6][j] = sx0 + (hc[0] - sx0) * su + gauss(jr) * 0.02;
        shapes[6][j + 1] = gauss(jr) * 0.02;
        shapes[6][j + 2] = sz0 + (hc[2] - sz0) * su + gauss(jr) * 0.02;
      }

      // 7 install: the nest again, a little smaller
      shapes[7][j] = shapes[0][j]; shapes[7][j + 1] = shapes[0][j + 1]; shapes[7][j + 2] = shapes[0][j + 2];
    }
    api.layout = layout;
  }

  // ---------- camera ----------
  var CAM = {
    rx: [0.36, 0.12, 0.30, 0.52, 0.30, 0.55, 1.05, 0.36],
    ry: [0.00, 0.00, 0.25, 0.55, 0.15, 0.60, 0.00, 0.35],
    dist: [6.0, 7.6, 6.9, 6.0, 6.6, 6.0, 7.4, 7.0]
  };

  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function viewMatrix(rx, ry, dist) {
    var cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    // translate(0,0,-dist) * rotX(rx) * rotY(ry), column-major
    return [cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, 0, 0, -dist, 1];
  }
  function project(m, p, off) {
    var x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    var y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    var w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w + off[0], y / w + off[1], w];
  }

  // ---------- WebGL ----------
  var gl, prog, loc = {}, shapeBufs = [], metaBuf, boundA = -1, boundB = -1;
  var VS = [
    'attribute vec3 aA; attribute vec3 aB; attribute vec4 aM;',
    'uniform mat4 uMVP; uniform float uMix, uTime, uWobble, uSize, uDPR, uPointerOn, uHit, uBeam, uDecay, uTint, uDim, uFade;',
    'uniform vec2 uOffset, uPointer;',
    'varying vec3 vColor; varying float vAlpha;',
    'float flag(float f, float b) { return mod(floor(f / b), 2.0); }',
    'void main() {',
    '  float seed = aM.x;',
    '  float m = clamp((uMix - seed * 0.35) / 0.65, 0.0, 1.0); m = m * m * (3.0 - 2.0 * m);',
    '  vec3 p = mix(aA, aB, m);',
    '  p += uWobble * 0.035 * vec3(sin(uTime * 0.9 + seed * 40.0), sin(uTime * 0.7 + seed * 23.0), cos(uTime * 0.8 + seed * 31.0));',
    '  vec4 clip = uMVP * vec4(p, 1.0);',
    '  clip.xy += uOffset * clip.w;',
    '  vec2 ndc = clip.xy / clip.w;',
    '  float near = uPointerOn * smoothstep(0.16, 0.0, distance(ndc, uPointer));',
    '  clip.xy += normalize(ndc - uPointer + 1e-4) * near * 0.03 * clip.w;',
    '  gl_Position = clip;',
    '  float pinned = flag(aM.w, 1.0), hit = flag(aM.w, 2.0), beam = flag(aM.w, 4.0), recent = flag(aM.w, 8.0);',
    '  float cat = floor(aM.y), sb = fract(aM.y);',
    '  vec3 ivory = vec3(0.945, 0.91, 0.855);',
    '  vec3 amber = vec3(1.0, 0.678, 0.353);',
    '  vec3 tint = mix(vec3(0.97, 0.87, 0.72), vec3(1.0, 0.62, 0.32), cat / 5.0);',
    '  vec3 col = mix(ivory, tint, 0.25 + 0.75 * uTint);',
    '  float alpha = (0.38 + 0.5 * sb) * (0.85 + 0.3 * fract(seed * 7.13));',
    '  col = mix(col, amber * 1.1, hit * uHit);',
    '  alpha = mix(alpha, alpha * 0.32, (1.0 - hit) * (1.0 - beam) * uHit);',
    '  alpha = mix(alpha, 0.95, hit * uHit);',
    '  col = mix(col, vec3(0.56, 0.83, 0.91), beam);',
    '  alpha *= mix(1.0, uBeam, beam);',
    '  float ex = max(max(pinned, recent), step(4.5, cat));',
    '  float keep = mix(0.1 + 0.9 * exp(-pow(aM.z / 0.55, 1.6)), 1.0, ex);',
    '  alpha *= mix(1.0, keep, uDecay);',
    '  col = mix(col, amber, pinned * uDecay * 0.7);',
    '  alpha *= uFade * (1.0 - 0.5 * uDim);',
    '  alpha = min(1.0, alpha + near * 0.3);',
    '  float size = uSize * (0.75 + 0.6 * fract(seed * 13.7)) * (1.0 + hit * uHit * 0.9 + pinned * uDecay * 0.7);',
    '  gl_PointSize = max(1.0, size * uDPR * (6.0 / clip.w));',
    '  vColor = col; vAlpha = alpha;',
    '}'
  ].join('\n');
  var FS = [
    'precision mediump float;',
    'varying vec3 vColor; varying float vAlpha;',
    'void main() {',
    '  float r = length(gl_PointCoord - 0.5);',
    '  float a = smoothstep(0.5, 0.1, r); a *= a;',
    '  gl_FragColor = vec4(vColor * vAlpha * a, vAlpha * a);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function initGL() {
    if (params.has('nogl')) return false;
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    ['aA', 'aB', 'aM'].forEach(function (n) { loc[n] = gl.getAttribLocation(prog, n); gl.enableVertexAttribArray(loc[n]); });
    ['uMVP', 'uMix', 'uTime', 'uWobble', 'uSize', 'uDPR', 'uOffset', 'uPointer', 'uPointerOn', 'uHit', 'uBeam', 'uDecay', 'uTint', 'uDim', 'uFade']
      .forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });
    metaBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, metaBuf);
    gl.bufferData(gl.ARRAY_BUFFER, meta, gl.STATIC_DRAW);
    gl.vertexAttribPointer(loc.aM, 4, gl.FLOAT, false, 0, 0);
    uploadShapes();
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(11 / 255, 9 / 255, 7 / 255, 1);
    return true;
  }

  function uploadShapes() {
    shapeBufs.forEach(function (b) { gl.deleteBuffer(b); });
    shapeBufs = shapes.map(function (arr) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      return b;
    });
    boundA = boundB = -1;
  }

  function bindPair(a, b) {
    if (a === boundA && b === boundB) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeBufs[a]); gl.vertexAttribPointer(loc.aA, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeBufs[b]); gl.vertexAttribPointer(loc.aB, 3, gl.FLOAT, false, 0, 0);
    boundA = a; boundB = b;
  }

  // ---------- frame ----------
  var state = { g: 0, raw: 0 }, dpr = 1, W = 0, H = 0, start = 0, last = 0, dirty = true, readyFrames = 0;
  var pointer = { x: 0, y: 0, sx: 0, sy: 0, on: 0 };

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var was = layout;
    measure();
    if (api.gl && was && was !== (isPortrait() ? 'portrait' : 'landscape')) { buildShapes(); uploadShapes(); }
    requestDraw();
  }

  function weight(b) { return Math.max(0, 1 - Math.abs(state.g - b)); }

  function draw(now) {
    var p = progressAt(window.scrollY || window.pageYOffset || 0);
    state.g = p.g; state.raw = p.raw;
    var a = Math.min(SHAPES - 1, Math.floor(state.g)), b = Math.min(SHAPES - 1, a + 1), mix = state.g - a;
    var e = smooth(0, 1, mix);
    var port = layout === 'portrait';
    var t = (now - start) / 1000;
    var moving = !still;
    pointer.sx += (pointer.x - pointer.sx) * 0.08; pointer.sy += (pointer.y - pointer.sy) * 0.08;
    var rx = CAM.rx[a] + (CAM.rx[b] - CAM.rx[a]) * e;
    var ry = CAM.ry[a] + (CAM.ry[b] - CAM.ry[a]) * e;
    var dist = (CAM.dist[a] + (CAM.dist[b] - CAM.dist[a]) * e) * (port ? 1.85 : 1);
    if (moving) {
      ry += 0.06 * Math.sin(t * 0.13) + (port ? 0 : pointer.sx * 0.08);
      rx += 0.02 * Math.sin(t * 0.11) - (port ? 0 : pointer.sy * 0.05);
    }
    var off = port ? [0, 0.27] : [0.34, 0.02];
    var mvp = mul(perspective(40 * Math.PI / 180, W / H, 0.1, 60), viewMatrix(rx, ry, dist));

    if (api.gl) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      bindPair(a, b);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniform1f(loc.uMix, mix);
      gl.uniform1f(loc.uTime, moving ? t : 0);
      gl.uniform1f(loc.uWobble, moving ? 1 : 0);
      gl.uniform1f(loc.uSize, port ? 3.3 : 2.8);
      gl.uniform1f(loc.uDPR, dpr);
      gl.uniform2f(loc.uOffset, off[0], off[1]);
      gl.uniform2f(loc.uPointer, pointer.sx, pointer.sy);
      gl.uniform1f(loc.uPointerOn, moving && !port ? pointer.on : 0);
      gl.uniform1f(loc.uHit, weight(4));
      gl.uniform1f(loc.uBeam, weight(4));
      gl.uniform1f(loc.uDecay, weight(5));
      gl.uniform1f(loc.uTint, Math.max(weight(3), weight(4), weight(5)));
      gl.uniform1f(loc.uDim, weight(7));
      gl.uniform1f(loc.uFade, still ? 1 : smooth(0, 0.9, t));
      gl.drawArrays(gl.POINTS, 0, N);
    }

    // client labels: in "scattered" and "home"
    var w1 = weight(1), w6 = weight(6), lw = Math.max(w1, w6);
    var clients = port ? CLIENTS_PORT : CLIENTS_LAND;
    for (var c = 0; c < labelEls.length; c++) {
      var el = labelEls[c];
      if (lw <= 0.01 || !api.gl) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
      var anchor = w1 >= w6
        ? [clients[c][0], clients[c][1] - (port ? 0.5 : 0.62), clients[c][2]]
        : [homeCenters[c][0], 0, homeCenters[c][2] + (port ? 0.3 : 0.36)];
      var q = project(mvp, anchor, off);
      var x = (q[0] + 1) / 2 * W, y = (1 - q[1]) / 2 * H;
      var edge = Math.min(1, Math.max(0, Math.min(x - 8, W - x - 8, y - 70, H - y - 8) / 40));
      el.style.opacity = String(Math.round(lw * edge * 100) / 100);
      el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px) translate(-50%, -50%)';
    }

    var on = Math.round(state.raw);
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d === on);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!start) start = now;
    if (last) { api.frames.push(now - last); if (api.frames.length > 1200) api.frames.shift(); }
    last = now;
    if (still && !dirty && api.ready) return;
    dirty = false;
    draw(now);
    if (!api.ready) { readyFrames++; if (readyFrames >= 2) api.ready = true; }
  }
  function requestDraw() { dirty = true; }

  // ---------- events ----------
  window.addEventListener('scroll', requestDraw, { passive: true });
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 120); });
  window.addEventListener('pointermove', function (ev) {
    if (ev.pointerType !== 'mouse') return;
    pointer.x = ev.clientX / window.innerWidth * 2 - 1;
    pointer.y = 1 - ev.clientY / window.innerHeight * 2;
    pointer.on = 1;
    requestDraw();
  }, { passive: true });
  document.addEventListener('pointerleave', function () { pointer.on = 0; requestDraw(); });
  reduceQuery.addEventListener && reduceQuery.addEventListener('change', function (ev) { still = ev.matches || params.has('still'); requestDraw(); });
  canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); api.gl = false; });
  canvas.addEventListener('webglcontextrestored', function () { api.gl = initGL(); requestDraw(); });

  // ---------- start ----------
  initParticles(isPortrait() ? 11000 : 24000);
  api.count = N;
  buildShapes();
  try { api.gl = initGL(); } catch (err) { api.gl = false; if (window.console) console.warn(err); }
  if (!api.gl) root.classList.add('no-gl');
  resize();
  var v = params.get('view');
  if (v) { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; jumpTo(v); }
  requestAnimationFrame(loop);
})();
