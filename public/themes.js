'use strict';

(function initG0DThemes() {
  const THEMES = [
    {
      id: 'obsidian',
      name: 'Obsidian',
      short: 'Obsidian',
      emoji: '',
      base: 'dark',
      animated: false,
      badge: 'Default',
      desc: 'Classic G0DM0D3 dark obsidian, violet & sage.'
    },
    {
      id: 'minimal',
      name: 'Minimal',
      short: 'Minimal',
      emoji: '',
      base: 'dark',
      animated: false,
      badge: 'Calm',
      desc: 'Ultra-clean matte monochrome dark studio UI.'
    },
    {
      id: 'light',
      name: 'Alabaster',
      short: 'Alabaster',
      emoji: '',
      base: 'light',
      animated: false,
      badge: 'Daylight',
      desc: 'Crisp warm paper & ink daylight workspace.'
    },
    {
      id: 'dragons',
      name: 'Dragons',
      short: 'Dragons',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Animated winged dragons soaring through molten embers.'
    },
    {
      id: 'psychedelic',
      name: 'Psychedelic',
      short: 'Psychedelic',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Domain-warped liquid oil projector, chromatic melt droplets & sacred geometry.'
    },
    {
      id: 'hacker',
      name: 'Hacker',
      short: 'Hacker',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Matrix katakana/hex rain, monospace & CRT scanlines.'
    },
    {
      id: 'synthwave',
      name: 'Synthwave',
      short: 'Synthwave',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Scrolling 3D Outrun neon laser grid & retrowave sunset.'
    },
    {
      id: 'volcano',
      name: 'Vesuvian',
      short: 'Vesuvian',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Mount Vesuvius caldera, flowing magma fissures & Plinian sparks.'
    },
    {
      id: 'ancient',
      name: 'Ancient',
      short: 'Ancient',
      emoji: '',
      base: 'light',
      animated: true,
      badge: 'Live',
      desc: 'Carrara marble colonnade, gold leaf, Pompeian crimson & oculus sunbeams.'
    },
    {
      id: 'celestial',
      name: 'Celestial',
      short: 'Celestial',
      emoji: '',
      base: 'dark',
      animated: true,
      badge: 'Live',
      desc: 'Deep-space nebula, twinkling constellations, golden astrolabe rings & meteors.'
    }
  ];

  const byId = new Map(THEMES.map(t => [t.id, t]));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let motionPaused = (() => {
    try { return JSON.parse(localStorage.getItem('g0dc0d3.qol.v1') || '{}')?.pauseBackdrop === true; } catch { return false; }
  })();
  let activeId = 'obsidian';
  let rafId = null;
  let canvas = null;
  let ctx = null;
  let engine = null;
  let width = 0;
  let height = 0;
  let dpr = 1;

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.getElementById('theme-canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'theme-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        document.body.prepend(canvas);
      }
      ctx = canvas.getContext('2d', { alpha: false });
    }
    if (!document.getElementById('theme-overlay')) {
      const ov = document.createElement('div');
      ov.id = 'theme-overlay';
      ov.setAttribute('aria-hidden', 'true');
      canvas.after(ov);
    }
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(320, window.innerWidth);
    height = Math.max(240, window.innerHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (engine?.resize) engine.resize(width, height);
    if (engine && rafId === null) engine.step(0.05, 1.2);
  }

  /* ── 1. Dragon Realm Engine: articulated winged dragons + fire breath + embers ── */
  function createDragonsEngine() {
    const dragons = [];
    const embers = [];
    const flames = [];

    function spawnDragon(initial = false) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const scale = 0.52 + Math.random() * 0.72;
      const speed = (48 + Math.random() * 58) * scale;
      return {
        x: initial ? Math.random() * width : (dir === 1 ? -180 * scale : width + 180 * scale),
        y: 70 + Math.random() * Math.max(120, height - 180),
        baseY: 0,
        dir,
        scale,
        speed,
        phase: Math.random() * Math.PI * 2,
        wingSpeed: 4.8 + Math.random() * 2.4,
        amp: 16 + Math.random() * 28,
        hue: Math.random() < 0.35 ? 12 : (Math.random() < 0.5 ? 28 : 352),
        breathCooldown: 2.5 + Math.random() * 5,
        breathTimer: 0
      };
    }

    function init() {
      dragons.length = 0;
      embers.length = 0;
      flames.length = 0;
      for (let i = 0; i < 6; i++) {
        const d = spawnDragon(true);
        d.baseY = d.y;
        dragons.push(d);
      }
      for (let i = 0; i < 65; i++) {
        embers.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 18,
          vy: -(16 + Math.random() * 38),
          r: 1 + Math.random() * 2.4,
          life: Math.random()
        });
      }
    }
    init();

    function drawDragon(d, t) {
      const s = d.scale;
      const wingCycle = Math.sin(t * d.wingSpeed + d.phase);
      const bob = Math.sin(t * 1.4 + d.phase) * d.amp;
      const headX = d.x;
      const headY = d.baseY + bob;

      ctx.save();
      // Undulating spine from head backward
      const segs = 13;
      const pts = [];
      for (let i = 0; i < segs; i++) {
        const lag = i * 0.38;
        const sx = headX - d.dir * i * 11.5 * s;
        const sy = headY + Math.sin(t * 3.1 + d.phase - lag) * (5 + i * 0.8) * s + (i > 2 ? Math.sin(t * d.wingSpeed + d.phase - 0.4) * 3 * s : 0);
        pts.push({ x: sx, y: sy });
      }

      // Back wing (far side, darker)
      const shoulder = pts[2];
      const flapBack = wingCycle * 36 * s;
      ctx.fillStyle = `hsla(${d.hue}, 70%, 16%, 0.72)`;
      ctx.strokeStyle = `hsla(${d.hue + 18}, 90%, 56%, 0.45)`;
      ctx.lineWidth = 1.4 * s;
      ctx.beginPath();
      ctx.moveTo(shoulder.x, shoulder.y);
      ctx.quadraticCurveTo(shoulder.x - d.dir * 18 * s, shoulder.y - 46 * s + flapBack * 0.8, shoulder.x - d.dir * 54 * s, shoulder.y - 26 * s + flapBack);
      ctx.quadraticCurveTo(shoulder.x - d.dir * 32 * s, shoulder.y - 6 * s + flapBack * 0.35, pts[5].x, pts[5].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Serpentine torso & tail
      for (let i = segs - 1; i >= 1; i--) {
        const p0 = pts[i];
        const p1 = pts[i - 1];
        const thickness = (i < 4 ? (8 + i * 1.6) : Math.max(2, 13 - i * 0.92)) * s;
        ctx.strokeStyle = `hsla(${d.hue}, 62%, ${14 + (segs - i) * 0.8}%, 0.92)`;
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();

        // Dorsal glowing scale ridge
        if (i % 2 === 1 && i < 10) {
          ctx.fillStyle = `hsla(${d.hue + 22}, 95%, 60%, 0.72)`;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y - thickness * 0.45);
          ctx.lineTo(p1.x - d.dir * 5 * s, p1.y - thickness * 0.95);
          ctx.lineTo(p0.x, p0.y - thickness * 0.4);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Tail spade
      const tail = pts[segs - 1];
      ctx.fillStyle = `hsla(${d.hue + 16}, 88%, 52%, 0.85)`;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(tail.x - d.dir * 14 * s, tail.y - 7 * s);
      ctx.lineTo(tail.x - d.dir * 9 * s, tail.y);
      ctx.lineTo(tail.x - d.dir * 14 * s, tail.y + 7 * s);
      ctx.closePath();
      ctx.fill();

      // Front wing (articulated multi-rib bat-wing with scalloped membrane)
      const flapFront = wingCycle * 52 * s;
      const shoulderX = shoulder.x;
      const shoulderY = shoulder.y;
      const wristX = shoulderX - d.dir * 26 * s;
      const wristY = shoulderY - 56 * s + flapFront * 0.72;
      const tip1X = shoulderX - d.dir * 78 * s;
      const tip1Y = shoulderY - 38 * s + flapFront;
      const tip2X = shoulderX - d.dir * 60 * s;
      const tip2Y = shoulderY - 8 * s + flapFront * 0.65;
      const tip3X = shoulderX - d.dir * 38 * s;
      const tip3Y = shoulderY + 12 * s + flapFront * 0.35;
      const wingGrad = ctx.createLinearGradient(shoulderX, shoulderY, tip1X, tip1Y);
      wingGrad.addColorStop(0, `hsla(${d.hue}, 78%, 18%, 0.94)`);
      wingGrad.addColorStop(0.6, `hsla(${d.hue + 14}, 88%, 34%, 0.82)`);
      wingGrad.addColorStop(1, `hsla(${d.hue + 24}, 96%, 54%, 0.65)`);
      ctx.fillStyle = wingGrad;
      ctx.strokeStyle = `hsla(${d.hue + 26}, 98%, 66%, 0.85)`;
      ctx.lineWidth = 1.7 * s;
      ctx.beginPath();
      ctx.moveTo(shoulderX, shoulderY);
      ctx.quadraticCurveTo(shoulderX - d.dir * 10 * s, shoulderY - 34 * s + flapFront * 0.4, wristX, wristY);
      ctx.lineTo(tip1X, tip1Y);
      ctx.quadraticCurveTo(shoulderX - d.dir * 64 * s, shoulderY - 22 * s + flapFront * 0.8, tip2X, tip2Y);
      ctx.quadraticCurveTo(shoulderX - d.dir * 46 * s, shoulderY - 2 * s + flapFront * 0.45, tip3X, tip3Y);
      ctx.quadraticCurveTo(shoulderX - d.dir * 20 * s, shoulderY + 4 * s, pts[5].x, pts[5].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Articulated finger ribs inside the wing membrane
      ctx.strokeStyle = `hsla(${d.hue + 24}, 95%, 62%, 0.52)`;
      ctx.lineWidth = 1.1 * s;
      ctx.beginPath();
      ctx.moveTo(wristX, wristY); ctx.lineTo(tip2X, tip2Y);
      ctx.moveTo(wristX, wristY); ctx.lineTo(tip3X, tip3Y);
      ctx.stroke();

      // Head, snout, horns & molten eye
      ctx.fillStyle = `hsla(${d.hue}, 66%, 18%, 0.96)`;
      ctx.strokeStyle = `hsla(${d.hue + 22}, 94%, 58%, 0.78)`;
      ctx.lineWidth = 1.4 * s;
      ctx.beginPath();
      ctx.moveTo(headX + d.dir * 22 * s, headY + 1 * s);
      ctx.lineTo(headX + d.dir * 6 * s, headY - 9 * s);
      ctx.lineTo(headX - d.dir * 12 * s, headY - 14 * s); // horn
      ctx.lineTo(headX - d.dir * 4 * s, headY - 5 * s);
      ctx.lineTo(headX - d.dir * 10 * s, headY + 6 * s);
      ctx.lineTo(headX + d.dir * 16 * s, headY + 7 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Glowing eye
      ctx.fillStyle = '#fde047';
      ctx.shadowColor = '#f97316';
      ctx.shadowBlur = 10 * s;
      ctx.beginPath();
      ctx.arc(headX + d.dir * 8 * s, headY - 2 * s, 2.3 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return { mouthX: headX + d.dir * 22 * s, mouthY: headY + 2 * s };
    }

    return {
      resize() {},
      step(dt, t) {
        const bg = ctx.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, '#0a0507');
        bg.addColorStop(0.65, '#17090d');
        bg.addColorStop(1, '#2b0d10');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        // Blood-gold eclipsed moon & volcanic horizon glow
        const moonX = width * 0.80;
        const moonY = height * 0.22;
        const moonR = Math.min(width, height) * 0.095;
        const glow = ctx.createRadialGradient(moonX, moonY, moonR * 0.3, moonX, moonY, Math.max(width, height) * 0.42);
        glow.addColorStop(0, 'rgba(251, 146, 60, 0.32)');
        glow.addColorStop(0.35, 'rgba(185, 28, 28, 0.14)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);

        ctx.save();
        const moonGrad = ctx.createRadialGradient(moonX - moonR * 0.25, moonY - moonR * 0.2, 4, moonX, moonY, moonR);
        moonGrad.addColorStop(0, 'rgba(254, 215, 170, 0.55)');
        moonGrad.addColorStop(0.6, 'rgba(234, 88, 12, 0.32)');
        moonGrad.addColorStop(1, 'rgba(153, 27, 27, 0.08)');
        ctx.fillStyle = moonGrad;
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Distant jagged obsidian dragon-crag peaks along lower horizon
        ctx.save();
        ctx.fillStyle = '#0e0507';
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.26)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, height);
        const crags = [[0, 0.88], [0.12, 0.78], [0.22, 0.85], [0.34, 0.72], [0.46, 0.84], [0.62, 0.76], [0.76, 0.67], [0.87, 0.79], [0.95, 0.73], [1, 0.83]];
        for (const [px, py] of crags) ctx.lineTo(width * px, height * py);
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Rising embers
        for (const e of embers) {
          e.x += (e.vx + Math.sin(t * 1.5 + e.life * 10) * 10) * dt;
          e.y += e.vy * dt;
          e.life += dt * 0.25;
          if (e.y < -12) { e.y = height + 10; e.x = Math.random() * width; }
          const alpha = 0.25 + 0.55 * Math.abs(Math.sin(e.life * 4));
          ctx.fillStyle = `rgba(251, 146, 60, ${alpha.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Update & draw dragons
        for (let i = 0; i < dragons.length; i++) {
          const d = dragons[i];
          d.x += d.dir * d.speed * dt;
          d.breathCooldown -= dt;
          if (d.breathCooldown <= 0) {
            d.breathTimer = 0.75;
            d.breathCooldown = 3.5 + Math.random() * 5.5;
          }
          const mouth = drawDragon(d, t);
          if (d.breathTimer > 0) {
            d.breathTimer -= dt;
            for (let k = 0; k < 2; k++) {
              flames.push({
                x: mouth.mouthX,
                y: mouth.mouthY,
                vx: d.dir * (110 + Math.random() * 110) * d.scale,
                vy: (Math.random() - 0.5) * 44 * d.scale,
                r: (3 + Math.random() * 4.5) * d.scale,
                life: 1
              });
            }
          }
          if ((d.dir === 1 && d.x > width + 240 * d.scale) || (d.dir === -1 && d.x < -240 * d.scale)) {
            const next = spawnDragon(false);
            next.baseY = next.y;
            dragons[i] = next;
          }
        }

        // Render fire-breath particles
        for (let i = flames.length - 1; i >= 0; i--) {
          const f = flames[i];
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          f.life -= dt * 1.7;
          if (f.life <= 0) { flames.splice(i, 1); continue; }
          const g = Math.round(90 + f.life * 145);
          ctx.fillStyle = `rgba(255, ${g}, 28, ${(f.life * 0.75).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * (1.4 - f.life * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
  }

  /* ── 2. Psychedelic Melt Engine: silky liquid-light oil projector + iridescent metaballs + sacred mandala ── */
  function createPsychedelicEngine() {
    const pw = 216;
    const ph = 132;
    const off = document.createElement('canvas');
    off.width = pw;
    off.height = ph;
    const octx = off.getContext('2d');
    const img = octx.createImageData(pw, ph);
    const data = img.data;

    // Drifting liquid-mercury / oil-projector lava blobs that slowly melt downward
    const blobs = Array.from({ length: 8 }, (_, i) => ({
      x: (i + 0.45) / 8,
      y: (i * 0.17) % 1,
      rx: 0.12 + (i % 3) * 0.05,
      ry: 0.15 + ((i + 1) % 3) * 0.06,
      vy: 0.011 + (i % 4) * 0.005,
      hueOff: i * 47,
      phase: i * 1.17
    }));

    return {
      resize() {},
      step(dt, t) {
        let idx = 0;
        const tt = t * 0.42;
        const drip = t * 0.15;
        for (let y = 0; y < ph; y++) {
          const ny = y / ph;
          const yw = (ny - 0.5) * 2.1;
          for (let x = 0; x < pw; x++) {
            const nx = x / pw;
            const xw = (nx - 0.5) * 3.0;

            const qx = Math.sin(xw * 1.7 + tt * 0.85) + Math.cos(yw * 2.1 - drip * 1.2);
            const qy = Math.cos(xw * 1.5 - tt * 0.65) + Math.sin(yw * 1.9 + tt * 0.55);

            const wx = xw + 0.52 * qx;
            const wy = yw + 0.52 * qy - drip * 0.55;
            const r2 = wx * wx + wy * wy;
            const swirl = Math.sin(Math.sqrt(r2 + 0.12) * 3.8 - tt * 1.1 + Math.atan2(wy, wx) * 2.0);
            const fold = Math.sin(wx * 2.0 + Math.cos(wy * 2.3 + tt * 0.7)) * Math.cos(wy * 1.7 - Math.sin(wx * 1.8 - tt * 0.45));
            const field = swirl * 0.58 + fold * 0.72 + 0.22 * Math.sin(qx - qy + tt);

            // Smooth silky liquid-light oil sheen (no pixelated hard threshold dots!)
            const sheen = 0.5 + 0.5 * Math.cos(field * 2.4);
            const sheenSmooth = sheen * sheen * (3 - 2 * sheen);

            const phase = field * 1.45 + tt * 0.32;
            const crest = 0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.sin(field * 1.35), 1.25);
            const baseR = (0.48 + 0.52 * Math.cos(phase + 0.0)) * crest;
            const baseG = (0.36 + 0.54 * Math.cos(phase + 2.1)) * crest;
            const baseB = (0.58 + 0.42 * Math.cos(phase + 4.0)) * crest;

            const r = Math.min(255, Math.round(10 + baseR * 136 + sheenSmooth * 46));
            const g = Math.min(255, Math.round(6 + baseG * 108 + sheenSmooth * 38));
            const b = Math.min(255, Math.round(22 + baseB * 158 + sheenSmooth * 54));
            data[idx++] = r;
            data[idx++] = g;
            data[idx++] = b;
            data[idx++] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, width, height);

        // Soft melting chromatic oil-lamp droplets
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const b of blobs) {
          b.y = (b.y + b.vy * dt) % 1.28;
          const bx = (b.x + 0.06 * Math.sin(t * 0.55 + b.phase)) * width;
          const by = (b.y - 0.14) * height;
          const stretch = 1 + 0.22 * Math.sin(t * 1.1 + b.phase);
          const rad = Math.min(width, height) * b.rx * stretch;
          const hue = (t * 28 + b.hueOff) % 360;
          const hue2 = (hue + 95) % 360;
          const g = ctx.createRadialGradient(bx, by, rad * 0.05, bx, by, rad);
          g.addColorStop(0, `hsla(${hue}, 100%, 66%, 0.26)`);
          g.addColorStop(0.55, `hsla(${hue2}, 96%, 54%, 0.12)`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.ellipse(bx, by, rad, rad * (1.28 / stretch), Math.sin(t * 0.4 + b.phase) * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // Crisp breathing Flower-of-Life sacred geometry mandala
        ctx.save();
        ctx.translate(width * 0.56, height * 0.48);
        ctx.globalCompositeOperation = 'screen';
        const maxR = Math.hypot(width, height) * 0.40;
        for (let layer = 0; layer < 2; layer++) {
          ctx.save();
          ctx.rotate(t * (layer === 0 ? 0.07 : -0.05));
          const petals = layer === 0 ? 8 : 12;
          for (let ring = 0; ring < 3; ring++) {
            const hue = (t * 36 + ring * 78 + layer * 130) % 360;
            const r = maxR * (0.20 + ring * 0.20 + 0.024 * Math.sin(t * 0.8 + ring + layer));
            ctx.strokeStyle = `hsla(${hue}, 98%, 70%, ${layer === 0 ? '0.18' : '0.12'})`;
            ctx.lineWidth = layer === 0 ? 1.6 : 1.1;
            ctx.beginPath();
            for (let s = 0; s <= 120; s++) {
              const a = (s / 120) * Math.PI * 2;
              const mod = 1 + 0.14 * Math.sin(a * petals + t * 0.9 + ring) + 0.04 * Math.cos(a * (petals * 2) - t * 1.4);
              const px = Math.cos(a) * r * mod;
              const py = Math.sin(a) * r * mod;
              if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.restore();

        // Soft velvet center vignette so workspace text stays razor-crisp
        const vig = ctx.createRadialGradient(width * 0.54, height * 0.50, Math.min(width, height) * 0.12, width * 0.54, height * 0.50, Math.max(width, height) * 0.65);
        vig.addColorStop(0, 'rgba(9, 4, 20, 0.42)');
        vig.addColorStop(0.55, 'rgba(9, 4, 20, 0.12)');
        vig.addColorStop(1, 'rgba(6, 2, 14, 0.34)');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, width, height);
      }
    };
  }

  /* ── 3. Ultra Hacker Engine: 2-depth parallax Matrix katakana/hex rain + CRT vignette ── */
  function createHackerEngine() {
    const glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFG0DM0D3$#><';
    const fontSize = 15;
    const farSize = 10;
    let cols = 0;
    let drops = [];
    let speeds = [];
    let farCols = 0;
    let farDrops = [];
    let farSpeeds = [];

    function setup() {
      cols = Math.max(12, Math.ceil(width / fontSize));
      drops = Array.from({ length: cols }, () => Math.random() * (height / fontSize));
      speeds = Array.from({ length: cols }, () => 7.5 + Math.random() * 14);
      farCols = Math.max(18, Math.ceil(width / (farSize * 1.4)));
      farDrops = Array.from({ length: farCols }, () => Math.random() * (height / farSize));
      farSpeeds = Array.from({ length: farCols }, () => 3.5 + Math.random() * 5.5);
      ctx.fillStyle = '#020904';
      ctx.fillRect(0, 0, width, height);
    }
    setup();

    return {
      resize: setup,
      step(dt) {
        ctx.fillStyle = 'rgba(2, 9, 4, 0.14)';
        ctx.fillRect(0, 0, width, height);

        // Distant micro-glyph parallax layer
        ctx.font = `500 ${farSize}px SFMono-Regular, Menlo, Consolas, monospace`;
        for (let i = 0; i < farCols; i++) {
          const prevRow = Math.floor(farDrops[i]);
          farDrops[i] += farSpeeds[i] * dt;
          const curRow = Math.floor(farDrops[i]);
          if (curRow !== prevRow || dt > 0.2) {
            const x = i * farSize * 1.4;
            const y = curRow * farSize;
            const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
            ctx.fillStyle = 'rgba(0, 175, 92, 0.34)';
            ctx.fillText(ch, x, y);
          }
          if (farDrops[i] * farSize > height + 20 && Math.random() > 0.96) {
            farDrops[i] = -Math.random() * 10;
          }
        }

        // Crisp foreground phosphor streams
        ctx.font = `600 ${fontSize}px SFMono-Regular, Menlo, Consolas, monospace`;
        for (let i = 0; i < cols; i++) {
          const prevRow = Math.floor(drops[i]);
          drops[i] += speeds[i] * dt;
          const curRow = Math.floor(drops[i]);
          if (curRow !== prevRow || dt > 0.2) {
            const x = i * fontSize;
            const y = curRow * fontSize;
            const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
            // Bright phosphor head
            ctx.fillStyle = '#d9ffe9';
            ctx.fillText(ch, x, y);
            // Glowing emerald trail right behind
            if (curRow > 0) {
              const ch2 = glyphs[Math.floor(Math.random() * glyphs.length)];
              ctx.fillStyle = '#00e676';
              ctx.fillText(ch2, x, (curRow - 1) * fontSize);
            }
          }
          if (drops[i] * fontSize > height + 30 && Math.random() > 0.96) {
            drops[i] = -Math.random() * 8;
          }
        }

        // Subtle CRT radial focus vignette keeping center UI crystal-clear
        const vig = ctx.createRadialGradient(width * 0.54, height * 0.48, Math.min(width, height) * 0.14, width * 0.54, height * 0.48, Math.max(width, height) * 0.72);
        vig.addColorStop(0, 'rgba(2, 10, 5, 0.08)');
        vig.addColorStop(0.65, 'rgba(2, 9, 4, 0.02)');
        vig.addColorStop(1, 'rgba(1, 5, 2, 0.22)');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, width, height);
      }
    };
  }

  /* ── 4. Synthwave '84 Engine: 3D neon laser grid + Outrun sun + stars ── */
  function createSynthwaveEngine() {
    let stars = [];
    function initStars() {
      stars = Array.from({ length: 75 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height * 0.56,
        r: 0.7 + Math.random() * 1.5,
        p: Math.random() * Math.PI * 2
      }));
    }
    initStars();

    return {
      resize: initStars,
      step(_dt, t) {
        const horizon = height * 0.58;
        const sky = ctx.createLinearGradient(0, 0, 0, horizon);
        sky.addColorStop(0, '#070312');
        sky.addColorStop(0.55, '#190838');
        sky.addColorStop(1, '#4c1054');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, horizon);

        // Twinkling stars
        for (const s of stars) {
          const a = 0.3 + 0.65 * Math.abs(Math.sin(t * 1.6 + s.p));
          ctx.fillStyle = `rgba(224, 242, 254, ${a.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Atmospheric Outrun sun corona (positioned high enough to crown clearly above the composer!)
        const sunX = width * 0.60;
        const sunR = Math.min(width, height) * 0.17;
        const sunY = horizon - sunR * 1.18;
        const sunHalo = ctx.createRadialGradient(sunX, sunY, sunR * 0.35, sunX, sunY, sunR * 2.5);
        sunHalo.addColorStop(0, 'rgba(251, 113, 133, 0.38)');
        sunHalo.addColorStop(0.5, 'rgba(192, 38, 211, 0.16)');
        sunHalo.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = sunHalo;
        ctx.fillRect(0, 0, width, horizon);

        ctx.save();
        ctx.beginPath();
        ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
        ctx.clip();
        const sunGrad = ctx.createLinearGradient(sunX, sunY - sunR, sunX, sunY + sunR);
        sunGrad.addColorStop(0, '#fef08a');
        sunGrad.addColorStop(0.42, '#fb7185');
        sunGrad.addColorStop(1, '#c026d3');
        ctx.fillStyle = sunGrad;
        ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);
        ctx.fillStyle = '#24093d';
        for (let i = 0; i < 6; i++) {
          const cutY = sunY + sunR * (0.04 + i * 0.15) + ((t * 10) % 12) * 0.35;
          ctx.fillRect(sunX - sunR, cutY, sunR * 2, 1.8 + i * 1.35);
        }
        ctx.restore();

        // Far violet ridge + foreground neon wireframe mountain range
        ctx.fillStyle = 'rgba(30, 8, 56, 0.72)';
        ctx.beginPath();
        ctx.moveTo(0, horizon);
        const farPeaks = [0.06, 0.22, 0.36, 0.50, 0.68, 0.82, 0.94, 1.0];
        const farH = [0.14, 0.08, 0.18, 0.09, 0.16, 0.20, 0.10, 0.05];
        for (let i = 0; i < farPeaks.length; i++) ctx.lineTo(width * farPeaks[i], horizon - height * farH[i]);
        ctx.lineTo(width, horizon);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#100422';
        ctx.strokeStyle = 'rgba(244, 63, 142, 0.82)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, horizon);
        const peaks = [0.08, 0.18, 0.29, 0.42, 0.56, 0.71, 0.84, 0.94, 1.0];
        const heights = [0.1, 0.04, 0.13, 0.05, 0.09, 0.14, 0.06, 0.11, 0.03];
        for (let i = 0; i < peaks.length; i++) {
          ctx.lineTo(width * peaks[i], horizon - height * heights[i]);
        }
        ctx.lineTo(width, horizon);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Cyan ridge wireframe facets on foreground peaks
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.32)';
        ctx.lineWidth = 1;
        for (let i = 0; i < peaks.length; i += 2) {
          const px = width * peaks[i];
          const py = horizon - height * heights[i];
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + width * 0.035, horizon);
          ctx.stroke();
        }

        // Ground plane + 3D perspective laser grid
        const ground = ctx.createLinearGradient(0, horizon, 0, height);
        ground.addColorStop(0, '#1e0836');
        ground.addColorStop(1, '#070312');
        ctx.fillStyle = ground;
        ctx.fillRect(0, horizon, width, height - horizon);

        ctx.strokeStyle = 'rgba(34, 211, 238, 0.36)';
        ctx.lineWidth = 1.2;
        const vpX = width * 0.56;
        for (let i = -12; i <= 12; i++) {
          ctx.beginPath();
          ctx.moveTo(vpX + i * 24, horizon);
          ctx.lineTo(vpX + i * 190, height);
          ctx.stroke();
        }
        const scroll = (t * 0.55) % 1;
        ctx.strokeStyle = 'rgba(244, 63, 142, 0.45)';
        for (let i = 0; i < 14; i++) {
          const p = (i + scroll) / 14;
          const y = horizon + Math.pow(p, 2.2) * (height - horizon);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
        // Horizon glow bar
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, horizon);
        ctx.lineTo(width, horizon);
        ctx.stroke();
      }
    };
  }

  /* ── 5. Plinian Vesuvius Engine: rising volcanic sparks, lava glow & ash ── */
  function createVolcanoEngine() {
    const sparks = [];
    const ash = [];
    function init() {
      sparks.length = 0;
      ash.length = 0;
      for (let i = 0; i < 95; i++) {
        sparks.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 26,
          vy: -(24 + Math.random() * 68),
          r: 1.1 + Math.random() * 2.6,
          phase: Math.random() * Math.PI * 2
        });
      }
      for (let i = 0; i < 45; i++) {
        ash.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 10 + Math.random() * 18,
          vy: -(8 + Math.random() * 18),
          r: 1.5 + Math.random() * 3.2
        });
      }
    }
    init();

    return {
      resize() {},
      step(dt, t) {
        const bg = ctx.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, '#0d0706');
        bg.addColorStop(0.68, '#1b0d09');
        bg.addColorStop(1, '#3a1409');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        // Pulsing magma caldera glow + backlit Plinian eruption plume
        const pulse = 0.28 + 0.10 * Math.sin(t * 1.8);
        const vx = width * 0.76;
        const craterY = height * 0.62;
        const caldera = ctx.createRadialGradient(vx, craterY, 16, vx, craterY, Math.max(width, height) * 0.56);
        caldera.addColorStop(0, `rgba(255, 178, 66, ${(pulse + 0.12).toFixed(2)})`);
        caldera.addColorStop(0.32, `rgba(255, 92, 36, ${pulse.toFixed(2)})`);
        caldera.addColorStop(0.65, 'rgba(153, 27, 27, 0.14)');
        caldera.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = caldera;
        ctx.fillRect(0, 0, width, height);

        // Rising backlit Plinian pine-tree ash crown above Vesuvius crater
        ctx.save();
        const plumeSway = Math.sin(t * 0.5) * 14;
        const plumeGrad = ctx.createLinearGradient(vx, craterY - height * 0.46, vx, craterY + 12);
        plumeGrad.addColorStop(0, 'rgba(42, 22, 26, 0.26)');
        plumeGrad.addColorStop(0.55, 'rgba(124, 38, 36, 0.36)');
        plumeGrad.addColorStop(1, 'rgba(255, 146, 56, 0.48)');
        ctx.fillStyle = plumeGrad;
        ctx.beginPath();
        ctx.moveTo(vx - 34, craterY + 6);
        ctx.bezierCurveTo(vx - 46, craterY - 88, vx - 150 + plumeSway, craterY - 135, vx - 120 + plumeSway, craterY - 210);
        ctx.bezierCurveTo(vx - 70 + plumeSway, craterY - 280, vx + 80 + plumeSway, craterY - 280, vx + 135 + plumeSway, craterY - 205);
        ctx.bezierCurveTo(vx + 165 + plumeSway, craterY - 132, vx + 48, craterY - 85, vx + 34, craterY + 6);
        ctx.closePath();
        ctx.fill();

        // Occasional crackling volcanic lightning inside the ash plume
        if (Math.sin(t * 2.7) > 0.91) {
          ctx.strokeStyle = 'rgba(255, 244, 196, 0.82)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(vx - 18 + plumeSway * 0.5, craterY - 195);
          ctx.lineTo(vx - 34 + plumeSway * 0.4, craterY - 142);
          ctx.lineTo(vx - 16 + plumeSway * 0.3, craterY - 135);
          ctx.lineTo(vx - 38 + plumeSway * 0.2, craterY - 86);
          ctx.stroke();
        }
        ctx.restore();

        // Faceted dark basalt Mount Vesuvius silhouette + molten lava fissures
        ctx.save();
        ctx.fillStyle = '#120807';
        ctx.beginPath();
        ctx.moveTo(vx - width * 0.44, height);
        ctx.lineTo(vx - 44, craterY);
        ctx.lineTo(vx + 44, craterY);
        ctx.lineTo(vx + width * 0.34, height);
        ctx.closePath();
        ctx.fill();

        // Rim-lit caldera glow lip
        ctx.strokeStyle = 'rgba(255, 168, 66, 0.85)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(vx - 42, craterY + 1);
        ctx.quadraticCurveTo(vx, craterY + 10, vx + 42, craterY + 1);
        ctx.stroke();

        // Glowing lava rivers snaking down the volcano flanks
        const lavaGrad = ctx.createLinearGradient(vx, craterY, vx, height);
        lavaGrad.addColorStop(0, 'rgba(255, 236, 153, 0.92)');
        lavaGrad.addColorStop(0.4, 'rgba(255, 114, 42, 0.72)');
        lavaGrad.addColorStop(1, 'rgba(185, 28, 28, 0.12)');
        ctx.strokeStyle = lavaGrad;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(vx - 6, craterY + 4);
        ctx.bezierCurveTo(vx - 24, craterY + 75, vx - 12, craterY + 145, vx - 68, height - 10);
        ctx.stroke();
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        ctx.moveTo(vx + 10, craterY + 5);
        ctx.bezierCurveTo(vx + 32, craterY + 82, vx + 22, craterY + 150, vx + 78, height - 12);
        ctx.stroke();
        ctx.restore();

        // Ash flakes
        ctx.fillStyle = 'rgba(200, 172, 154, 0.16)';
        for (const a of ash) {
          a.x += a.vx * dt;
          a.y += a.vy * dt;
          if (a.y < -10) { a.y = height + 10; a.x = Math.random() * width; }
          if (a.x > width + 10) a.x = -10;
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Magma sparks
        for (const s of sparks) {
          s.x += (s.vx + Math.sin(t * 2.1 + s.phase) * 18) * dt;
          s.y += s.vy * dt;
          if (s.y < -12) {
            s.y = height + 8;
            s.x = Math.random() * width;
          }
          const heat = Math.max(0, Math.min(1, s.y / height));
          const g = Math.round(90 + heat * 145);
          ctx.fillStyle = `rgba(255, ${g}, 42, ${(0.3 + heat * 0.65).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
  }

  /* ── 6. Ancient Greco-Roman Engine: Carrara marble atrium, fluted columns, Pantheon sunbeams & gold leaf ── */
  function createAncientEngine() {
    const motes = [];
    const leaves = [];
    const veins = [];

    function init() {
      motes.length = 0;
      leaves.length = 0;
      veins.length = 0;
      for (let i = 0; i < 65; i++) {
        motes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 5 + Math.random() * 11,
          vy: -(3 + Math.random() * 8),
          r: 0.9 + Math.random() * 2.1,
          phase: Math.random() * Math.PI * 2,
          gold: Math.random() < 0.72
        });
      }
      for (let i = 0; i < 8; i++) {
        leaves.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 10 + Math.random() * 14,
          vy: 6 + Math.random() * 9,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 0.9,
          size: 5 + Math.random() * 5,
          phase: Math.random() * Math.PI * 2
        });
      }
      for (let i = 0; i < 7; i++) {
        veins.push({
          y0: (i + 0.4) * (height / 7),
          amp: 18 + Math.random() * 34,
          freq: 0.002 + Math.random() * 0.003,
          phase: Math.random() * Math.PI * 2
        });
      }
    }
    init();

    function drawColumn(cx, colW) {
      const topY = 0;
      const colGrad = ctx.createLinearGradient(cx - colW / 2, 0, cx + colW / 2, 0);
      colGrad.addColorStop(0, 'rgba(182, 160, 122, 0.24)');
      colGrad.addColorStop(0.28, 'rgba(255, 250, 238, 0.34)');
      colGrad.addColorStop(0.62, 'rgba(222, 205, 174, 0.20)');
      colGrad.addColorStop(1, 'rgba(155, 132, 95, 0.26)');
      ctx.fillStyle = colGrad;
      ctx.fillRect(cx - colW / 2, topY, colW, height);

      // Fluted vertical grooves
      const flutes = 5;
      ctx.strokeStyle = 'rgba(150, 124, 82, 0.14)';
      ctx.lineWidth = 1;
      for (let f = 1; f < flutes; f++) {
        const fx = cx - colW / 2 + (colW * f) / flutes;
        ctx.beginPath();
        ctx.moveTo(fx, 44);
        ctx.lineTo(fx, height - 34);
        ctx.stroke();
      }
      // Capital echinus & abacus crown
      ctx.fillStyle = 'rgba(188, 152, 88, 0.22)';
      ctx.fillRect(cx - colW * 0.68, 22, colW * 1.36, 10);
      ctx.fillRect(cx - colW * 0.58, 32, colW * 1.16, 8);
      // Base plinth
      ctx.fillRect(cx - colW * 0.66, height - 26, colW * 1.32, 10);
      ctx.fillRect(cx - colW * 0.76, height - 16, colW * 1.52, 16);
    }

    function drawMeanderStrip(y, alpha) {
      const unit = 18;
      ctx.strokeStyle = `rgba(168, 126, 46, ${alpha})`;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let x = 0; x < width + unit; x += unit) {
        ctx.moveTo(x, y + 8);
        ctx.lineTo(x + 12, y + 8);
        ctx.lineTo(x + 12, y + 2);
        ctx.lineTo(x + 5, y + 2);
        ctx.lineTo(x + 5, y + 5);
        ctx.lineTo(x + 8, y + 5);
        ctx.moveTo(x + 12, y + 8);
        ctx.lineTo(x + unit, y + 8);
      }
      ctx.stroke();
    }

    return {
      resize() { init(); },
      step(dt, t) {
        // Warm Carrara marble gradient backdrop
        const bg = ctx.createLinearGradient(0, 0, width * 0.35, height);
        bg.addColorStop(0, '#f7f1e3');
        bg.addColorStop(0.52, '#f1e7d3');
        bg.addColorStop(1, '#e6d7bc');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        // Subtle Carrara marble mineral veining
        ctx.lineWidth = 1.2;
        for (let i = 0; i < veins.length; i++) {
          const v = veins[i];
          ctx.strokeStyle = i % 2 === 0 ? 'rgba(172, 152, 120, 0.12)' : 'rgba(140, 38, 51, 0.045)';
          ctx.beginPath();
          for (let x = 0; x <= width; x += 28) {
            const y = v.y0 + Math.sin(x * v.freq + v.phase) * v.amp + Math.cos(x * v.freq * 2.1 - v.phase) * (v.amp * 0.35);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        // Pantheon oculus sunbeams drifting diagonally
        ctx.save();
        for (let b = 0; b < 3; b++) {
          const bx = width * (0.28 + b * 0.24) + Math.sin(t * 0.22 + b * 1.7) * 32;
          const beamW = 90 + b * 36;
          const beamGrad = ctx.createLinearGradient(bx, 0, bx + 180, height);
          const alpha = 0.085 + 0.03 * Math.sin(t * 0.65 + b);
          beamGrad.addColorStop(0, `rgba(255, 222, 148, ${(alpha * 1.5).toFixed(3)})`);
          beamGrad.addColorStop(0.6, `rgba(246, 206, 122, ${alpha.toFixed(3)})`);
          beamGrad.addColorStop(1, 'rgba(246, 206, 122, 0)');
          ctx.fillStyle = beamGrad;
          ctx.beginPath();
          ctx.moveTo(bx - beamW * 0.4, 0);
          ctx.lineTo(bx + beamW * 0.6, 0);
          ctx.lineTo(bx + beamW * 1.55, height);
          ctx.lineTo(bx + beamW * 0.25, height);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        // Architectural flanking Doric columns
        const colW = Math.max(32, Math.min(54, width * 0.036));
        drawColumn(colW * 0.9, colW);
        drawColumn(width - colW * 0.9, colW);
        if (width > 1100) {
          drawColumn(width - colW * 3.1, colW * 0.78);
        }

        // Subtle Greek key (meander) frieze along bottom edge
        drawMeanderStrip(height - 14, 0.22);

        // Gently drifting golden laurel leaves
        for (const lf of leaves) {
          lf.x += (lf.vx + Math.sin(t * 0.9 + lf.phase) * 6) * dt;
          lf.y += (lf.vy + Math.cos(t * 0.7 + lf.phase) * 3) * dt;
          lf.rot += lf.vrot * dt;
          if (lf.x > width + 24) lf.x = -20;
          if (lf.y > height + 24) { lf.y = -18; lf.x = Math.random() * width; }
          ctx.save();
          ctx.translate(lf.x, lf.y);
          ctx.rotate(lf.rot);
          ctx.fillStyle = 'rgba(164, 124, 46, 0.22)';
          ctx.beginPath();
          ctx.ellipse(0, 0, lf.size, lf.size * 0.38, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Shimmering gold-leaf dust motes
        for (const m of motes) {
          m.x += (m.vx + Math.sin(t * 1.3 + m.phase) * 6) * dt;
          m.y += m.vy * dt;
          if (m.y < -10) { m.y = height + 8; m.x = Math.random() * width; }
          if (m.x > width + 10) m.x = -8;
          const glint = 0.28 + 0.42 * (0.5 + 0.5 * Math.sin(t * 2.4 + m.phase));
          ctx.fillStyle = m.gold
            ? `rgba(186, 138, 36, ${glint.toFixed(2)})`
            : `rgba(140, 38, 51, ${(glint * 0.55).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
  }

  /* ── 7. Astral Observatory Engine: deep-space nebula, golden astrolabe, constellations & meteors ── */
  function createCelestialEngine() {
    const stars = [];
    const constellations = [];
    const meteors = [];
    let meteorTimer = 1.6;

    function init() {
      stars.length = 0;
      constellations.length = 0;
      meteors.length = 0;
      const count = Math.min(220, Math.max(110, Math.round((width * height) / 7200)));
      for (let i = 0; i < count; i++) {
        const tier = Math.random();
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: tier > 0.92 ? 1.8 + Math.random() * 1.1 : tier > 0.65 ? 1.0 + Math.random() * 0.7 : 0.55 + Math.random() * 0.5,
          phase: Math.random() * Math.PI * 2,
          speed: 0.8 + Math.random() * 2.2,
          tint: tier > 0.86 ? 'gold' : tier > 0.58 ? 'blue' : 'white'
        });
      }
      // Build 3 subtle star constellations in the upper & outer sky
      const anchors = [
        [[0.18, 0.18], [0.24, 0.24], [0.31, 0.20], [0.36, 0.29], [0.27, 0.34]],
        [[0.68, 0.14], [0.75, 0.20], [0.83, 0.16], [0.88, 0.25], [0.79, 0.28]],
        [[0.74, 0.68], [0.81, 0.74], [0.89, 0.71], [0.84, 0.82]]
      ];
      for (const poly of anchors) {
        constellations.push(poly.map(([px, py]) => ({ x: px * width, y: py * height })));
      }
    }
    init();

    function spawnMeteor() {
      const startX = width * (0.25 + Math.random() * 0.7);
      const startY = height * (0.04 + Math.random() * 0.35);
      const speed = 520 + Math.random() * 340;
      const angle = Math.PI * (0.68 + Math.random() * 0.14);
      meteors.push({
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        len: 75 + Math.random() * 65,
        life: 0,
        maxLife: 0.65 + Math.random() * 0.45
      });
    }

    function drawAstrolabe(cx, cy, radius, t) {
      ctx.save();
      ctx.translate(cx, cy);

      // Outer celestial ring with fine degree ticks
      ctx.save();
      ctx.rotate(t * 0.03);
      ctx.strokeStyle = 'rgba(240, 201, 117, 0.16)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(240, 201, 117, 0.11)';
      ctx.lineWidth = 1;
      for (let deg = 0; deg < 360; deg += 10) {
        const rad = (deg * Math.PI) / 180;
        const inner = deg % 30 === 0 ? radius - 12 : radius - 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(rad) * inner, Math.sin(rad) * inner);
        ctx.lineTo(Math.cos(rad) * radius, Math.sin(rad) * radius);
        ctx.stroke();
      }
      ctx.restore();

      // Inner counter-rotating ecliptic ellipse
      ctx.save();
      ctx.rotate(-t * 0.045 + 0.42);
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.14)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.78, radius * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(240, 201, 117, 0.13)';
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.56, 0, Math.PI * 2);
      ctx.stroke();

      // Cardinal crosshair meridians
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.08)';
      ctx.beginPath();
      ctx.moveTo(-radius * 0.85, 0); ctx.lineTo(radius * 0.85, 0);
      ctx.moveTo(0, -radius * 0.85); ctx.lineTo(0, radius * 0.85);
      ctx.stroke();
      ctx.restore();

      // Glowing astrolabe orbital node
      const orbitA = t * 0.16;
      const ox = Math.cos(orbitA) * radius * 0.78;
      const oy = Math.sin(orbitA) * radius * 0.78;
      ctx.fillStyle = 'rgba(240, 201, 117, 0.65)';
      ctx.beginPath();
      ctx.arc(ox, oy, 2.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    return {
      resize() { init(); },
      step(dt, t) {
        // Deep midnight cosmic backdrop
        const bg = ctx.createLinearGradient(0, 0, width * 0.4, height);
        bg.addColorStop(0, '#050814');
        bg.addColorStop(0.55, '#091026');
        bg.addColorStop(1, '#0d1532');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        // Soft drifting nebula clouds (sapphire, violet, teal-gold)
        const n1x = width * 0.74 + Math.sin(t * 0.12) * 28;
        const n1y = height * 0.34 + Math.cos(t * 0.1) * 18;
        const neb1 = ctx.createRadialGradient(n1x, n1y, 16, n1x, n1y, Math.max(width, height) * 0.42);
        neb1.addColorStop(0, 'rgba(99, 102, 241, 0.22)');
        neb1.addColorStop(0.45, 'rgba(56, 189, 248, 0.10)');
        neb1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = neb1;
        ctx.fillRect(0, 0, width, height);

        const n2x = width * 0.26 + Math.cos(t * 0.09) * 24;
        const n2y = height * 0.74 + Math.sin(t * 0.11) * 20;
        const neb2 = ctx.createRadialGradient(n2x, n2y, 12, n2x, n2y, Math.max(width, height) * 0.38);
        neb2.addColorStop(0, 'rgba(240, 201, 117, 0.11)');
        neb2.addColorStop(0.42, 'rgba(139, 92, 246, 0.13)');
        neb2.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = neb2;
        ctx.fillRect(0, 0, width, height);

        // Golden Ptolemaic astrolabe rings
        const astroR = Math.min(width, height) * 0.34;
        drawAstrolabe(width * 0.76, height * 0.44, astroR, t);

        // Constellation lines & anchor nodes
        ctx.lineWidth = 0.85;
        for (const pts of constellations) {
          ctx.strokeStyle = 'rgba(147, 197, 253, 0.14)';
          ctx.beginPath();
          pts.forEach((p, idx) => idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.stroke();
          for (const p of pts) {
            ctx.fillStyle = 'rgba(240, 201, 117, 0.65)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.0, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Twinkling multi-tint starfield
        for (const s of stars) {
          const tw = 0.38 + 0.62 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
          ctx.fillStyle = s.tint === 'gold'
            ? `rgba(253, 224, 152, ${tw.toFixed(2)})`
            : s.tint === 'blue'
              ? `rgba(165, 216, 255, ${tw.toFixed(2)})`
              : `rgba(240, 245, 255, ${tw.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Periodic shooting stars / meteors
        meteorTimer -= dt;
        if (meteorTimer <= 0 && meteors.length < 2) {
          spawnMeteor();
          meteorTimer = 3.2 + Math.random() * 4.5;
        }
        for (let i = meteors.length - 1; i >= 0; i--) {
          const m = meteors[i];
          m.life += dt;
          m.x += m.vx * dt;
          m.y += m.vy * dt;
          if (m.life >= m.maxLife) { meteors.splice(i, 1); continue; }
          const fade = Math.sin((m.life / m.maxLife) * Math.PI);
          const mag = Math.hypot(m.vx, m.vy) || 1;
          const tx = m.x - (m.vx / mag) * m.len;
          const ty = m.y - (m.vy / mag) * m.len;
          const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
          grad.addColorStop(0, `rgba(255, 248, 220, ${(fade * 0.9).toFixed(2)})`);
          grad.addColorStop(0.35, `rgba(147, 197, 253, ${(fade * 0.55).toFixed(2)})`);
          grad.addColorStop(1, 'rgba(96, 165, 250, 0)');
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
        }
      }
    };
  }

  function startEngine(id) {
    stopEngine();
    const theme = byId.get(id);
    if (!theme || !theme.animated) return;
    ensureCanvas();
    if (id === 'dragons') engine = createDragonsEngine();
    else if (id === 'psychedelic') engine = createPsychedelicEngine();
    else if (id === 'hacker') engine = createHackerEngine();
    else if (id === 'synthwave') engine = createSynthwaveEngine();
    else if (id === 'volcano') engine = createVolcanoEngine();
    else if (id === 'ancient') engine = createAncientEngine();
    else if (id === 'celestial') engine = createCelestialEngine();
    if (!engine) return;

    // Always paint an immediate initial frame (even under prefers-reduced-motion or user pause!)
    engine.step(0.05, 1.2);
    document.documentElement.dataset.themeMotion = (reducedMotion.matches || motionPaused) ? 'paused' : 'live';
    if (reducedMotion.matches || motionPaused) return;

    let last = performance.now();
    const loop = now => {
      rafId = requestAnimationFrame(loop);
      if (document.hidden) { last = now; return; }
      const dt = Math.min(0.06, Math.max(0.008, (now - last) / 1000));
      // Pace psychedelic & hacker smoothly around ~30fps to stay feather-light on laptops
      if ((id === 'psychedelic' || id === 'hacker') && now - last < 30) return;
      last = now;
      engine.step(dt, now / 1000);
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopEngine() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    engine = null;
  }

  function cardMarkup(t) {
    const active = t.id === activeId;
    return `<button type="button" class="theme-card${active ? ' is-active' : ''}" data-select-theme="${t.id}" aria-pressed="${active ? 'true' : 'false'}">
      <div class="theme-swatch theme-swatch-${t.id}">
        <span class="theme-swatch-tag">${t.badge}</span>
      </div>
      <div class="theme-card-meta">
        <span class="theme-card-name">${t.name}</span>
        ${active ? '<span class="theme-card-check" aria-hidden="true">✓</span>' : ''}
      </div>
      <span class="theme-card-desc">${t.desc}</span>
    </button>`;
  }

  function syncThemeUI() {
    const theme = byId.get(activeId) || THEMES[0];
    const label = document.getElementById('theme-label');
    if (label) label.textContent = `Theme · ${theme.short}`;
    const iconDark = document.getElementById('theme-icon-dark');
    const iconLight = document.getElementById('theme-icon-light');
    if (iconDark) iconDark.classList.toggle('hidden', theme.base === 'dark');
    if (iconLight) iconLight.classList.toggle('hidden', theme.base !== 'dark');

    const popGrid = document.getElementById('theme-popover-grid');
    if (popGrid) popGrid.innerHTML = THEMES.map(cardMarkup).join('');
    const settingsGrid = document.getElementById('settings-theme-grid');
    if (settingsGrid) settingsGrid.innerHTML = THEMES.map(cardMarkup).join('');
    const activeTag = document.getElementById('settings-theme-active');
    if (activeTag) activeTag.textContent = theme.name;
  }

  function apply(id, { persist = true, notify = false } = {}) {
    const resolved = byId.has(id) ? id : 'obsidian';
    const theme = byId.get(resolved);
    activeId = resolved;

    const root = document.documentElement;
    root.dataset.theme = theme.base;
    root.dataset.themeSkin = theme.id;
    root.dataset.themeAnimated = theme.animated ? 'true' : 'false';

    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme.base;
    const icon = document.getElementById('brand-icon');
    if (icon) icon.setAttribute('href', theme.base === 'dark' ? '/lysios-mark-reverse-white.svg' : '/lysios-mark-canonical-ink.svg');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#171817';

    if (theme.animated) startEngine(theme.id);
    else stopEngine();

    if (persist) {
      try {
        localStorage.setItem('g0dc0d3.themeSkin', theme.id);
        localStorage.setItem('g0dc0d3.theme', theme.base);
      } catch {}
    }

    syncThemeUI();
    if (notify && typeof window.toast === 'function') {
      window.toast(`Theme: ${theme.name}`);
    }
    return theme;
  }

  function resolveSavedTheme() {
    try {
      const skin = localStorage.getItem('g0dc0d3.themeSkin');
      if (skin && byId.has(skin)) return skin;
      const legacy = localStorage.getItem('g0dc0d3.theme');
      if (legacy === 'light') return 'light';
      if (legacy === 'dark') return 'obsidian';
    } catch {}
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'obsidian';
  }

  function togglePopover(force) {
    const pop = document.getElementById('theme-popover');
    const btn = document.getElementById('theme-toggle');
    if (!pop) return;
    const open = typeof force === 'boolean' ? force : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !open);
    btn?.setAttribute('aria-expanded', String(open));
    if (open) syncThemeUI();
  }

  function wireControls() {
    const btn = document.getElementById('theme-toggle');
    if (btn && !btn.dataset.themesWired) {
      btn.dataset.themesWired = '1';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', event => {
        event.stopPropagation();
        togglePopover();
      });
    }

    document.addEventListener('click', event => {
      const card = event.target.closest('[data-select-theme]');
      if (card) {
        const chosen = apply(card.dataset.selectTheme, { persist: true, notify: true });
        if (typeof window.settingsFeedback === 'function' && document.getElementById('settings-dialog')?.open) {
          window.settingsFeedback(`Theme switched to ${chosen.name}.`);
        }
        if (card.closest('#theme-popover')) togglePopover(false);
        return;
      }
      if (event.target.closest('[data-close-theme-popover]')) {
        togglePopover(false);
        return;
      }
      const pop = document.getElementById('theme-popover');
      if (pop && !pop.classList.contains('hidden') && !pop.contains(event.target) && !event.target.closest('#theme-toggle')) {
        togglePopover(false);
      }
    });

    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const pop = document.getElementById('theme-popover');
        if (pop && !pop.classList.contains('hidden')) togglePopover(false);
      }
    });

    window.addEventListener('resize', resizeCanvas);
    reducedMotion.addEventListener('change', () => {
      if (byId.get(activeId)?.animated) startEngine(activeId);
    });
  }

  window.G0DThemes = {
    list: () => THEMES.slice(),
    current: () => byId.get(activeId) || THEMES[0],
    apply,
    togglePopover,
    syncUI: syncThemeUI,
    setMotionPaused(paused) {
      motionPaused = Boolean(paused);
      const theme = byId.get(activeId);
      document.documentElement.dataset.themeMotion = (reducedMotion.matches || motionPaused) ? 'paused' : 'live';
      if (theme?.animated) startEngine(theme.id);
    },
    matchByQuery(q) {
      const s = String(q || '').trim().toLowerCase();
      if (!s) return null;
      if (['roman', 'greek', 'greco', 'greco-roman', 'marble', 'classical', 'rome', 'athens', 'spqr'].includes(s)) return byId.get('ancient');
      if (['astral', 'cosmos', 'cosmic', 'space', 'stars', 'galaxy', 'nebula', 'observatory', 'astrolabe'].includes(s)) return byId.get('celestial');
      return THEMES.find(t => t.id === s || t.short.toLowerCase() === s || t.name.toLowerCase().includes(s)) || null;
    }
  };

  wireControls();
  apply(resolveSavedTheme(), { persist: false, notify: false });
})();
