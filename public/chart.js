/* ============================================================================
   Minimal canvas time-series chart (no dependencies).

   Written from scratch so the dashboard has zero external assets: it works
   offline, inside a sandbox preview and on a VPS with no CDN access.

   Features: DPR-crisp rendering, gradient area, min/max band for bucketed
   data, dashed styling for simulated segments, crosshair + tooltip on hover
   and touch, resize observation, reduced-motion support.
   ========================================================================== */
(function (global) {
  'use strict';

  const PAD = { top: 18, right: 20, bottom: 30, left: 62 };
  const TWO_DAYS = 2 * 24 * 3600 * 1000;
  const NINETY_DAYS = 90 * 24 * 3600 * 1000;

  function niceTicks(min, max, count) {
    const span = max - min || Math.abs(max) || 1;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) {
      ticks.push(Number(v.toFixed(10)));
    }
    return ticks;
  }

  function defaultFormatValue(v, decimals) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function formatTimeLabel(t, span) {
    const d = new Date(t);
    if (span <= TWO_DAYS) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + 'Z';
    }
    if (span <= NINETY_DAYS) {
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    }
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function formatFullTime(t) {
    const d = new Date(t);
    return (
      d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) +
      ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
      ' UTC'
    );
  }

  class RateChart {
    constructor(canvas, tooltipEl, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltipEl;
      this.options = Object.assign(
        {
          color: '#ff7a1a',
          bandColor: 'rgba(255,122,26,0.14)',
          simulatedColor: '#ffb020',
          gridColor: 'rgba(128,140,170,0.16)',
          axisColor: 'rgba(128,140,170,0.75)',
          decimals: 2,
          animate: true,
        },
        options || {}
      );
      this.points = [];
      this.hoverIndex = -1;
      this.progress = 1;
      this.raf = null;
      this.reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this._resize = this._resize.bind(this);

      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mouseleave', this._onLeave);
      canvas.addEventListener('touchstart', this._onMove, { passive: true });
      canvas.addEventListener('touchmove', this._onMove, { passive: true });
      canvas.addEventListener('touchend', this._onLeave);

      if (global.ResizeObserver) {
        this.ro = new ResizeObserver(this._resize);
        this.ro.observe(canvas.parentElement || canvas);
      } else {
        global.addEventListener('resize', this._resize);
      }
      this._resize();
    }

    setData(data) {
      this.options = Object.assign(this.options, data.options || {});
      this.points = (data.points || []).filter((p) => p && Number.isFinite(p.t) && p.v !== null && p.v !== undefined);
      this.hoverIndex = -1;
      this._hideTooltip();
      if (this.options.animate && !this.reducedMotion && this.points.length > 1) {
        this.progress = 0;
        const start = performance.now();
        const duration = 420;
        const step = (now) => {
          this.progress = Math.min(1, (now - start) / duration);
          this.draw();
          if (this.progress < 1) this.raf = requestAnimationFrame(step);
        };
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(step);
      } else {
        this.progress = 1;
        this.draw();
      }
    }

    setTheme(colors) {
      Object.assign(this.options, colors || {});
      this.draw();
    }

    _resize() {
      const parent = this.canvas.parentElement || this.canvas;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      const w = Math.max(240, Math.round(rect.width));
      const h = Math.max(160, Math.round(rect.height));
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
      }
      this.dpr = dpr;
      this.width = w;
      this.height = h;
      this.draw();
    }

    _geometry() {
      const pts = this.points;
      if (!pts.length) return null;
      const values = [];
      for (const p of pts) {
        values.push(p.v);
        if (Number.isFinite(p.min)) values.push(p.min);
        if (Number.isFinite(p.max)) values.push(p.max);
      }
      let min = Math.min.apply(null, values);
      let max = Math.max.apply(null, values);
      if (min === max) {
        const pad = Math.abs(min) * 0.01 || 1;
        min -= pad;
        max += pad;
      } else {
        const pad = (max - min) * 0.12;
        min -= pad;
        max += pad;
      }
      const t0 = pts[0].t;
      const t1 = pts[pts.length - 1].t;
      const spanT = Math.max(1, t1 - t0);
      const plotW = this.width - PAD.left - PAD.right;
      const plotH = this.height - PAD.top - PAD.bottom;
      return {
        min,
        max,
        t0,
        t1,
        spanT,
        plotW,
        plotH,
        x: (t) => PAD.left + ((t - t0) / spanT) * plotW,
        y: (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH,
      };
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);

      const g = this._geometry();
      if (!g) {
        ctx.restore();
        return;
      }
      const pts = this.points;
      const visible = Math.max(1, Math.round(pts.length * this.progress));
      const decimals = this.options.decimals;

      // grid + y labels
      const ticks = niceTicks(g.min, g.max, this.height < 260 ? 3 : 5);
      ctx.font = '11px ' + (global.getComputedStyle(document.body).fontFamily || 'sans-serif');
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (const t of ticks) {
        const y = Math.round(g.y(t)) + 0.5;
        ctx.strokeStyle = this.options.gridColor;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(this.width - PAD.right, y);
        ctx.stroke();
        ctx.fillStyle = this.options.axisColor;
        ctx.textAlign = 'right';
        ctx.fillText(defaultFormatValue(t, decimals > 2 ? 2 : decimals), PAD.left - 9, y);
      }

      // x labels
      const labelCount = this.width < 520 ? 3 : this.width < 900 ? 5 : 6;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < labelCount; i += 1) {
        const t = g.t0 + (g.spanT * i) / (labelCount - 1);
        const x = g.x(t);
        ctx.strokeStyle = this.options.gridColor;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, PAD.top);
        ctx.lineTo(Math.round(x) + 0.5, this.height - PAD.bottom);
        ctx.stroke();
        ctx.fillStyle = this.options.axisColor;
        ctx.fillText(formatTimeLabel(t, g.spanT), x, this.height - PAD.bottom + 8);
      }

      // min/max band (bucketed data)
      const hasBand = pts.some((p) => Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min);
      if (hasBand) {
        ctx.beginPath();
        for (let i = 0; i < visible; i += 1) {
          const p = pts[i];
          const x = g.x(p.t);
          const y = g.y(p.max);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = visible - 1; i >= 0; i -= 1) {
          ctx.lineTo(g.x(pts[i].t), g.y(pts[i].min));
        }
        ctx.closePath();
        ctx.fillStyle = this.options.bandColor;
        ctx.fill();
      }

      const line = (filterFn, color, dashed) => {
        const segments = [];
        let current = [];
        for (let i = 0; i < visible; i += 1) {
          const p = pts[i];
          if (filterFn(p)) current.push(p);
          else if (current.length) { segments.push(current); current = []; }
        }
        if (current.length) segments.push(current);
        ctx.save();
        ctx.setLineDash(dashed ? [5, 4] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const seg of segments) {
          if (seg.length < 2) {
            // single sample: draw a dot so short histories are still visible
            const p = seg[0];
            ctx.beginPath();
            ctx.arc(g.x(p.t), g.y(p.v), 3, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            continue;
          }
          ctx.beginPath();
          seg.forEach((p, idx) => {
            const x = g.x(p.t);
            const y = g.y(p.v);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
        ctx.restore();
        return segments;
      };

      // area fill under the real-data line
      const real = pts.filter((p) => !p.sim);
      if (real.length > 1) {
        ctx.beginPath();
        real.forEach((p, i) => {
          const x = g.x(p.t);
          const y = g.y(p.v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.lineTo(g.x(real[real.length - 1].t), this.height - PAD.bottom);
        ctx.lineTo(g.x(real[0].t), this.height - PAD.bottom);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, PAD.top, 0, this.height - PAD.bottom);
        grad.addColorStop(0, this._alpha(this.options.color, 0.3));
        grad.addColorStop(1, this._alpha(this.options.color, 0.01));
        ctx.fillStyle = grad;
        ctx.fill();
      }

      line((p) => !p.sim, this.options.color, false);
      line((p) => p.sim, this.options.simulatedColor, true);

      // last point marker
      const last = pts[visible - 1];
      if (last) {
        const x = g.x(last.t);
        const y = g.y(last.v);
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = this._alpha(last.sim ? this.options.simulatedColor : this.options.color, 0.22);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = last.sim ? this.options.simulatedColor : this.options.color;
        ctx.fill();
      }

      // crosshair
      if (this.hoverIndex >= 0 && this.hoverIndex < pts.length) {
        const p = pts[this.hoverIndex];
        const x = g.x(p.t);
        const y = g.y(p.v);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = this.options.axisColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, this.height - PAD.bottom);
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(this.width - PAD.right, y);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = p.sim ? this.options.simulatedColor : this.options.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      ctx.restore();
      this.geom = g;
    }

    _alpha(hex, alpha) {
      const h = String(hex).replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    _eventPos(ev) {
      const rect = this.canvas.getBoundingClientRect();
      const src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    _onMove(ev) {
      if (!this.points.length || !this.geom) return;
      const { x, y } = this._eventPos(ev);
      if (x < PAD.left - 12 || x > this.width - PAD.right + 12) {
        this._onLeave();
        return;
      }
      const g = this.geom;
      const t = g.t0 + ((x - PAD.left) / g.plotW) * g.spanT;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < this.points.length; i += 1) {
        const d = Math.abs(this.points[i].t - t);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best === this.hoverIndex) return;
      this.hoverIndex = best;
      this.draw();
      this._showTooltip(best, y);
    }

    _showTooltip(index) {
      if (!this.tooltip || !this.geom) return;
      const p = this.points[index];
      const g = this.geom;
      const rows = [];
      rows.push(`<div class="tt-time">${formatFullTime(p.t)}</div>`);
      rows.push(`<div class="tt-value">${defaultFormatValue(p.v, this.options.decimals)}</div>`);
      if (Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min && p.count > 1) {
        rows.push(
          `<div class="tt-row"><span>low/high</span><span>${defaultFormatValue(p.min, this.options.decimals)} – ${defaultFormatValue(p.max, this.options.decimals)}</span></div>`
        );
        rows.push(`<div class="tt-row"><span>samples</span><span>${p.count}</span></div>`);
      }
      if (p.sim) rows.push('<div class="tt-sim">simulated</div>');
      this.tooltip.innerHTML = rows.join('');
      this.tooltip.hidden = false;
      const x = Math.min(Math.max(g.x(p.t), 90), this.width - 90);
      const y = g.y(p.v);
      this.tooltip.style.left = `${x}px`;
      this.tooltip.style.top = `${Math.max(y, 46)}px`;
    }

    _hideTooltip() {
      if (this.tooltip) this.tooltip.hidden = true;
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.draw();
      }
    }

    _onLeave() {
      this._hideTooltip();
    }

    destroy() {
      this.canvas.removeEventListener('mousemove', this._onMove);
      this.canvas.removeEventListener('mouseleave', this._onLeave);
      if (this.ro) this.ro.disconnect();
      else global.removeEventListener('resize', this._resize);
    }
  }

  global.RateChart = RateChart;
  global.RateChartUtils = { formatFullTime, formatTimeLabel, defaultFormatValue, niceTicks };
})(window);
