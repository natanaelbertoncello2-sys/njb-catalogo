// Une varias fotos superpuestas en una sola (panorámica / mosaico de detalle) con OpenCV.js.
// Pipeline: puntos ORB → emparejar cada foto con la anterior → homografía (RANSAC) → todas
// referidas a la foto del medio → deformar y fundir los bordes, igualando la exposición.
// Script clásico: lo usa el worker (importScripts) y también se puede probar con Node (require).

/* global self, module */
(function (root) {
  const REG_SIDE = 900;      // resolución para buscar coincidencias (rápido y suficiente)
  const MIN_INLIERS = 15;
  const MAX_AREA = 16000000; // límite de canvas en iPhone

  const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const mul = (a, b) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return r;
  };
  const inv = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) throw new Error('Alineación inválida');
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  };
  const apply = (m, x, y) => {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w, w];
  };

  // Puntos característicos de una foto (en escala reducida).
  function features(cv, rgba, orb) {
    const s = Math.min(1, REG_SIDE / Math.max(rgba.cols, rgba.rows));
    const small = new cv.Mat();
    cv.resize(rgba, small, new cv.Size(Math.round(rgba.cols * s), Math.round(rgba.rows * s)), 0, 0, cv.INTER_AREA);
    const gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    small.delete();
    const kp = new cv.KeyPointVector();
    const desc = new cv.Mat();
    const none = new cv.Mat();
    orb.detectAndCompute(gray, none, kp, desc);
    gray.delete(); none.delete();
    return { kp, desc, s };
  }

  // Homografía que lleva puntos de la foto B a la foto A (en coordenadas de trabajo).
  function pairHomography(cv, fa, fb, matcher) {
    if (fa.desc.rows < 8 || fb.desc.rows < 8) return null;
    const knn = new cv.DMatchVectorVector();
    matcher.knnMatch(fb.desc, fa.desc, knn, 2);
    const src = [], dst = [];
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i);
      if (m.size() < 2) continue;
      const a = m.get(0), b = m.get(1);
      if (a.distance < 0.75 * b.distance) {
        const pb = fb.kp.get(a.queryIdx).pt, pa = fa.kp.get(a.trainIdx).pt;
        src.push(pb.x / fb.s, pb.y / fb.s);
        dst.push(pa.x / fa.s, pa.y / fa.s);
      }
    }
    knn.delete();
    if (src.length / 2 < MIN_INLIERS) return null;
    const sm = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src);
    const dm = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
    const mask = new cv.Mat();
    const H = cv.findHomography(sm, dm, cv.RANSAC, 4 / Math.min(fa.s, fb.s), mask);
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) inliers += mask.data[i] ? 1 : 0;
    const h = H.rows === 3 ? Array.from(H.data64F) : null;
    sm.delete(); dm.delete(); mask.delete(); H.delete();
    if (!h || inliers < MIN_INLIERS) return null;
    return h;
  }

  // Peso para fundir: 255 en el centro, baja hacia los bordes de la foto.
  function edgeWeight(cv, w, h) {
    const ones = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(255));
    cv.rectangle(ones, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(0), 1);
    const dist = new cv.Mat();
    cv.distanceTransform(ones, dist, cv.DIST_L2, 3);
    ones.delete();
    const feather = Math.max(8, Math.min(w, h) * 0.18);
    const out = new cv.Mat();
    dist.convertTo(out, cv.CV_8U, 255 / feather, 0); // satura en 255
    dist.delete();
    return out;
  }

  // frames: cv.Mat RGBA (mismo orden en que se sacaron). Devuelve {data, width, height} RGBA.
  function stitch(cv, frames, onStep) {
    const n = frames.length;
    if (n < 2) throw new Error('Se necesitan al menos 2 fotos');
    const step = (t) => onStep && onStep(t);

    step('Buscando coincidencias…');
    const orb = new cv.ORB(3000);
    const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const feats = frames.map((f) => features(cv, f, orb));
    const Hs = []; // Hs[i]: foto i+1 → foto i
    try {
      for (let i = 0; i < n - 1; i++) {
        const H = pairHomography(cv, feats[i], feats[i + 1], matcher);
        if (!H) throw new Error(`Las fotos ${i + 1} y ${i + 2} no tienen suficiente en común. Superponé cada foto un 30-50% con la anterior.`);
        Hs.push(H);
      }
    } finally {
      feats.forEach((f) => { f.kp.delete(); f.desc.delete(); });
      orb.delete(); matcher.delete();
    }

    // Todas referidas a la foto del medio (menos deformación en los extremos).
    const ref = Math.floor((n - 1) / 2);
    const T = new Array(n);
    T[ref] = I3();
    for (let j = ref + 1; j < n; j++) T[j] = mul(T[j - 1], Hs[j - 1]);
    for (let j = ref - 1; j >= 0; j--) T[j] = mul(T[j + 1], inv(Hs[j]));

    // Límites del resultado.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumArea = 0;
    for (let i = 0; i < n; i++) {
      const w = frames[i].cols, h = frames[i].rows;
      sumArea += w * h;
      for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        const p = apply(T[i], x, y);
        if (p[2] <= 0) throw new Error('No pude alinear las fotos (perspectiva extrema). Probá moviendo el celu en paralelo al producto.');
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
    }
    const rawW = maxX - minX, rawH = maxY - minY;
    if (!isFinite(rawW) || rawW * rawH > sumArea * 4) {
      throw new Error('No pude alinear las fotos. Probá con más superposición y sin mover el producto.');
    }
    const sc = Math.min(1, Math.sqrt(MAX_AREA / (rawW * rawH)));
    const W = Math.max(1, Math.round(rawW * sc)), H = Math.max(1, Math.round(rawH * sc));
    const place = [sc, 0, -minX * sc, 0, sc, -minY * sc, 0, 0, 1];

    // Fundido: cada foto se pinta «encima» con un alfa que se desvanece hacia sus bordes.
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < n; i++) {
      step(`Uniendo ${i + 1}/${n}…`);
      const f = frames[i];
      const M = mul(place, T[i]);
      // Caja de esta foto en el resultado: deformamos solo esa zona.
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const [x, y] of [[0, 0], [f.cols, 0], [0, f.rows], [f.cols, f.rows]]) {
        const p = apply(M, x, y);
        bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]);
        by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]);
      }
      bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0));
      bx1 = Math.min(W, Math.ceil(bx1)); by1 = Math.min(H, Math.ceil(by1));
      const bw = bx1 - bx0, bh = by1 - by0;
      if (bw <= 0 || bh <= 0) continue;

      const wgt = edgeWeight(cv, f.cols, f.rows);
      const chans = new cv.MatVector();
      cv.split(f, chans);
      chans.set(3, wgt);
      const src = new cv.Mat();
      cv.merge(chans, src);
      chans.delete(); wgt.delete();

      const Mloc = mul([1, 0, -bx0, 0, 1, -by0, 0, 0, 1], M);
      const Mm = cv.matFromArray(3, 3, cv.CV_64F, Mloc);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, Mm, new cv.Size(bw, bh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      src.delete(); Mm.delete();
      const wd = warped.data;

      // Igualar exposición con lo ya pintado (en la zona superpuesta).
      let so = 0, ss = 0;
      for (let y = 0; y < bh; y += 2) {
        let o = ((by0 + y) * W + bx0) * 4, s = y * bw * 4;
        for (let x = 0; x < bw; x += 2, o += 8, s += 8) {
          if (out[o + 3] > 200 && wd[s + 3] > 200) {
            so += out[o] + out[o + 1] + out[o + 2];
            ss += wd[s] + wd[s + 1] + wd[s + 2];
          }
        }
      }
      const gain = ss > 0 ? Math.min(1.3, Math.max(0.77, so / ss)) : 1;

      for (let y = 0; y < bh; y++) {
        let o = ((by0 + y) * W + bx0) * 4, s = y * bw * 4;
        for (let x = 0; x < bw; x++, o += 4, s += 4) {
          const a = wd[s + 3];
          if (!a) continue;
          const oa = out[o + 3];
          if (!oa || a === 255) { // zona nueva o centro de la foto: se pinta completa
            out[o] = wd[s] * gain; out[o + 1] = wd[s + 1] * gain; out[o + 2] = wd[s + 2] * gain;
            out[o + 3] = 255;
            continue;
          }
          const k = a / 255;
          out[o] += (wd[s] * gain - out[o]) * k;
          out[o + 1] += (wd[s + 1] * gain - out[o + 1]) * k;
          out[o + 2] += (wd[s + 2] * gain - out[o + 2]) * k;
        }
      }
      warped.delete();
    }

    // Lo que no cubre ninguna foto queda blanco (fondo de catálogo).
    for (let o = 0; o < out.length; o += 4) {
      if (!out[o + 3]) { out[o] = out[o + 1] = out[o + 2] = 255; }
      out[o + 3] = 255;
    }
    return { data: out, width: W, height: H };
  }

  const api = { stitch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PanoCore = api;
})(typeof self !== 'undefined' ? self : this);
