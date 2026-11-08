/**
 * trajectory_2d.js — O2S: Mission Architect
 *
 * Interactive HTML5 2D Canvas — Spaceflight Simulator-style Orbital Map
 *
 * Features:
 *  - Pan/zoom with mouse drag and wheel
 *  - Coordinate grid with AU/km labels
 *  - Central body, origin body, target body rendered as circles
 *  - Parking orbit ring (dashed)
 *  - Hohmann transfer ellipse (parametric points from backend)
 *  - Animated spacecraft marker flying along ellipse in real-time
 *  - Clickable burn nodes showing exact ΔV values and descriptions
 *  - Propellant exhaustion: halt + solid-red incomplete arc → dashed-red remaining
 *  - Failure callout bubble at truncation point
 *  - Full/partial trajectory visualization based on completion_fraction
 */

const TRAJ = (() => {
    'use strict';

    // -----------------------------------------------------------------------
    // Canvas state
    // -----------------------------------------------------------------------
    let canvas, ctx;
    let w = 0, h = 0;

    // Pan/zoom camera
    let camX = 0, camY = 0;
    let scale = 1;        // pixels per AU (solar) or per Earth-Moon dist (lunar)
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let camStart = { x: 0, y: 0 };

    // Data
    let trajectoryData = null;
    let completionFraction = 1.0;
    let missionGo = true;

    // Animation
    let animProgress = 0;
    let animRunning = false;
    let animId = null;
    let lastTime = 0;
    let animSpeed = 0.0003;  // fraction per ms

    // Hover state for burn nodes
    let hoveredNode = null;
    let mousePos = { x: 0, y: 0 };

    // -----------------------------------------------------------------------
    // Colors
    // -----------------------------------------------------------------------
    const C = {
        bg: '#04080f',
        grid: 'rgba(30, 58, 95, 0.4)',
        gridBright: 'rgba(59, 130, 246, 0.2)',
        text: '#64748b',
        textBright: '#94a3b8',
        orbitRing: 'rgba(30, 58, 95, 0.7)',
        transferGo: '#06b6d4',
        transferNogo: '#ef4444',
        transferDimmed: 'rgba(6, 182, 212, 0.25)',
        spacecraft: '#f59e0b',
        thrustFlame: '#ff7c00',
        burnNode: '#f59e0b',
        burnNodeHover: '#fcd34d',
        sun: '#ffd700',
        earth: '#4a90d9',
        moon: '#aaaaaa',
        mars: '#c1440e',
        venus: '#e8c97a',
        jupiter: '#c88b3a',
        saturn: '#d4b483',
    };

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    function init() {
        canvas = document.getElementById('trajectory-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');

        _bindEvents();
        _resize();

        const ro = new ResizeObserver(_resize);
        ro.observe(canvas.parentElement);

        _drawIdle();
    }

    function _bindEvents() {
        canvas.addEventListener('mousedown', _onMouseDown);
        canvas.addEventListener('mousemove', _onMouseMove);
        canvas.addEventListener('mouseup', () => isDragging = false);
        canvas.addEventListener('mouseleave', () => { isDragging = false; hoveredNode = null; _render(); });
        canvas.addEventListener('wheel', _onWheel, { passive: false });

        document.getElementById('traj-reset')?.addEventListener('click', _resetView);
        document.getElementById('traj-animate')?.addEventListener('click', _startAnimation);
    }

    function _resize() {
        const container = canvas.parentElement;
        w = container.clientWidth || 800;
        h = container.clientHeight || 600;
        canvas.width = w;
        canvas.height = h;
        if (trajectoryData) {
            _render();
        } else {
            _drawIdle();
        }
    }

    // -----------------------------------------------------------------------
    // Pan / Zoom Event Handlers
    // -----------------------------------------------------------------------
    function _onMouseDown(e) {
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        camStart = { x: camX, y: camY };
    }

    function _onMouseMove(e) {
        mousePos = { x: e.offsetX, y: e.offsetY };

        if (isDragging) {
            camX = camStart.x + (e.clientX - dragStart.x);
            camY = camStart.y + (e.clientY - dragStart.y);
            _render();
            return;
        }

        // Burn node hover detection
        if (trajectoryData?.burn_nodes) {
            const prev = hoveredNode;
            hoveredNode = null;
            for (const node of trajectoryData.burn_nodes) {
                const sp = _worldToScreen(node.pos[0], node.pos[1]);
                const dx = mousePos.x - sp.x;
                const dy = mousePos.y - sp.y;
                if (Math.sqrt(dx * dx + dy * dy) < 18) {
                    hoveredNode = node;
                    break;
                }
            }
            if (hoveredNode !== prev) _render();
        }
    }

    function _onWheel(e) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        // Zoom toward cursor position
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        camX = mx - (mx - camX) * factor;
        camY = my - (my - camY) * factor;
        scale *= factor;
        scale = Math.max(20, Math.min(scale, 5000));
        _render();
    }

    // -----------------------------------------------------------------------
    // Coordinate Transform: world (AU) → screen pixels
    // -----------------------------------------------------------------------
    function _worldToScreen(wx, wy) {
        return {
            x: w / 2 + camX + wx * scale,
            y: h / 2 + camY - wy * scale,  // y-axis flipped
        };
    }

    function _screenToWorld(sx, sy) {
        return {
            x: (sx - w / 2 - camX) / scale,
            y: (h / 2 + camY - sy) / scale,
        };
    }

    // -----------------------------------------------------------------------
    // Reset View to fit trajectory
    // -----------------------------------------------------------------------
    function _resetView() {
        if (!trajectoryData) {
            camX = 0; camY = 0; scale = 100;
            _render(); return;
        }

        const mode = trajectoryData.mode;
        if (mode === 'earth_moon') {
            // Moon at 1 unit, fit canvas with margin
            scale = Math.min(w, h) * 0.38;
            camX = -0.0 * scale;
            camY = 0;
        } else {
            // Solar system: fit the target orbit ring
            const rMax = trajectoryData.target_body?.pos
                ? Math.abs(trajectoryData.target_body.pos[0]) * 1.3
                : 2.0;
            scale = Math.min(w, h) * 0.38 / rMax;
            camX = 0; camY = 0;
        }
        _render();
    }

    // -----------------------------------------------------------------------
    // Animation: spacecraft flying along ellipse
    // -----------------------------------------------------------------------
    function _startAnimation() {
        if (!trajectoryData) return;
        animProgress = 0;
        animRunning = true;
        lastTime = performance.now();
        _animLoop(lastTime);
    }

    function _animLoop(ts) {
        if (!animRunning) return;
        const dt = ts - lastTime;
        lastTime = ts;

        // Speed inversely proportional to transfer time (normalize to ~6s anim)
        const transferDays = trajectoryData.transfer_time_days || 100;
        const speed = 1.0 / (transferDays * 15);
        animProgress = Math.min(1.0, animProgress + speed * dt);

        _render();

        if (animProgress >= 1.0) {
            animRunning = false;
            return;
        }
        animId = requestAnimationFrame(_animLoop);
    }

    function _stopAnimation() {
        animRunning = false;
        if (animId) cancelAnimationFrame(animId);
    }

    // -----------------------------------------------------------------------
    // Load new trajectory data and render
    // -----------------------------------------------------------------------
    function update(data, go) {
        trajectoryData = data;
        completionFraction = data.completion_fraction ?? 1.0;
        missionGo = go ?? true;
        animProgress = 0;
        _stopAnimation();
        _resetView();
    }

    // -----------------------------------------------------------------------
    // Drawing Functions
    // -----------------------------------------------------------------------
    function _drawIdle() {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, w, h);

        // Draw subtle star field
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        const rng = _seededRng(42);
        for (let i = 0; i < 200; i++) {
            const sx = rng() * w;
            const sy = rng() * h;
            const sr = rng() * 1.2;
            ctx.beginPath();
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
            ctx.fill();
        }

        // Center text
        ctx.fillStyle = '#1e3a5f';
        ctx.font = '600 14px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Configure mission parameters and click', w / 2, h / 2 - 10);
        ctx.fillStyle = '#3b82f6';
        ctx.fillText('🚀 LAUNCH & SIMULATE MISSION', w / 2, h / 2 + 14);
        ctx.fillStyle = '#1e3a5f';
        ctx.fillText('to generate the orbital trajectory map.', w / 2, h / 2 + 38);
    }

    function _render() {
        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, w, h);

        if (!trajectoryData) { _drawIdle(); return; }

        _drawGrid();
        _drawOrbitalRings();
        _drawTransferEllipse();
        _drawBodies();
        _drawSpacecraft();
        _drawBurnNodes();
        _drawFailureCallout();
        _drawHUD();
    }

    // -----------------------------------------------------------------------
    // Grid
    // -----------------------------------------------------------------------
    function _drawGrid() {
        const mode = trajectoryData.mode;
        const unit = mode === 'earth_moon' ? 'EM' : 'AU';
        const gridStep = _niceGridStep();

        ctx.save();
        ctx.lineWidth = 0.5;

        // Find range in world units
        const tl = _screenToWorld(0, 0);
        const br = _screenToWorld(w, h);

        const startX = Math.floor(tl.x / gridStep) * gridStep;
        const startY = Math.floor(br.y / gridStep) * gridStep;

        for (let x = startX; x <= br.x + gridStep; x += gridStep) {
            const sp = _worldToScreen(x, 0);
            ctx.strokeStyle = Math.abs(x) < gridStep * 0.1 ? C.gridBright : C.grid;
            ctx.beginPath();
            ctx.moveTo(sp.x, 0);
            ctx.lineTo(sp.x, h);
            ctx.stroke();

            if (Math.abs(x) > 0.001) {
                ctx.fillStyle = C.text;
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${x.toFixed(1)}${unit}`, sp.x, h - 6);
            }
        }

        for (let y = startY; y <= tl.y + gridStep; y += gridStep) {
            const sp = _worldToScreen(0, y);
            ctx.strokeStyle = Math.abs(y) < gridStep * 0.1 ? C.gridBright : C.grid;
            ctx.beginPath();
            ctx.moveTo(0, sp.y);
            ctx.lineTo(w, sp.y);
            ctx.stroke();

            if (Math.abs(y) > 0.001) {
                ctx.fillStyle = C.text;
                ctx.font = '10px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(`${y.toFixed(1)}${unit}`, 4, sp.y - 2);
            }
        }
        ctx.restore();
    }

    function _niceGridStep() {
        const worldWidth = w / scale;
        const rawStep = worldWidth / 8;
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const frac = rawStep / mag;
        if (frac < 1.5) return mag;
        if (frac < 3.5) return 2 * mag;
        if (frac < 7.5) return 5 * mag;
        return 10 * mag;
    }

    // -----------------------------------------------------------------------
    // Orbital Rings
    // -----------------------------------------------------------------------
    function _drawOrbitalRings() {
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = C.orbitRing;

        // Earth parking orbit ring (or LEO around Earth in solar view = tiny dot)
        if (trajectoryData.mode === 'earth_moon') {
            const pR = trajectoryData.parking_orbit_r || 0.017;
            const cp = _worldToScreen(0, 0);
            const r = pR * scale;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Earth orbit ring (solar system)
        if (trajectoryData.earth_orbit_ring) {
            ctx.beginPath();
            trajectoryData.earth_orbit_ring.forEach((pt, i) => {
                const sp = _worldToScreen(pt[0], pt[1]);
                i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            });
            ctx.closePath();
            ctx.stroke();
        }

        // Target orbit ring
        if (trajectoryData.target_orbit_ring) {
            ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
            ctx.beginPath();
            trajectoryData.target_orbit_ring.forEach((pt, i) => {
                const sp = _worldToScreen(pt[0], pt[1]);
                i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            });
            ctx.closePath();
            ctx.stroke();
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Transfer Ellipse
    // -----------------------------------------------------------------------
    function _drawTransferEllipse() {
        const pts = trajectoryData.transfer_ellipse_points;
        if (!pts || pts.length < 2) return;

        const totalPts = pts.length - 1;
        // Index where spacecraft currently is (animation or completion)
        const displayFraction = animRunning
            ? Math.min(animProgress, completionFraction)
            : completionFraction;

        const cutIdx = Math.floor(displayFraction * totalPts);

        ctx.save();
        ctx.lineWidth = 2.5;

        // Draw completed portion (bright solid)
        if (cutIdx > 0) {
            ctx.strokeStyle = C.transferGo;
            ctx.setLineDash([]);
            ctx.shadowColor = C.transferGo;
            ctx.shadowBlur = 6;
            ctx.beginPath();
            for (let i = 0; i <= cutIdx; i++) {
                const sp = _worldToScreen(pts[i][0], pts[i][1]);
                i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            }
            ctx.stroke();
        }

        // Draw remaining portion (dashed red = propellant exhausted / incomplete)
        if (cutIdx < totalPts) {
            ctx.strokeStyle = completionFraction < 1.0 ? C.transferNogo : C.transferDimmed;
            ctx.setLineDash(completionFraction < 1.0 ? [6, 5] : [3, 7]);
            ctx.shadowBlur = 0;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = cutIdx; i <= totalPts; i++) {
                const sp = _worldToScreen(pts[i][0], pts[i][1]);
                i === cutIdx ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            }
            ctx.stroke();
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Celestial Bodies
    // -----------------------------------------------------------------------
    function _drawBodies() {
        // Central body (Sun or Earth)
        const cb = trajectoryData.central_body;
        if (cb) {
            _drawBody(cb.pos[0], cb.pos[1], cb.display_radius, cb.color, cb.label, true);
        }

        // Origin body (Earth in solar system view)
        const ob = trajectoryData.origin_body;
        if (ob) {
            _drawBody(ob.pos[0], ob.pos[1], ob.display_radius, ob.color, ob.label, false);
        }

        // Target body
        const tb = trajectoryData.target_body;
        if (tb) {
            _drawBody(tb.pos[0], tb.pos[1], tb.display_radius, tb.color, tb.label, false);
        }
    }

    function _drawBody(wx, wy, displayRadius, color, label, glow) {
        const sp = _worldToScreen(wx, wy);
        const r = Math.max(5, displayRadius * scale);

        ctx.save();
        if (glow) {
            ctx.shadowColor = color;
            ctx.shadowBlur = r * 1.2;
        }

        // Body fill
        const grad = ctx.createRadialGradient(sp.x, sp.y, r * 0.1, sp.x, sp.y, r);
        grad.addColorStop(0, color);
        grad.addColorStop(1, _darken(color, 0.4));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Label
        if (label) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '600 11px system-ui';
            ctx.textAlign = 'center';
            ctx.shadowBlur = 0;
            ctx.fillText(label, sp.x, sp.y + r + 14);
        }
        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Animated Spacecraft
    // -----------------------------------------------------------------------
    function _drawSpacecraft() {
        const pts = trajectoryData.transfer_ellipse_points;
        if (!pts || pts.length < 2) return;

        const displayFraction = animRunning
            ? Math.min(animProgress, completionFraction)
            : (completionFraction < 1.0 ? completionFraction : 0);

        if (displayFraction <= 0 && !animRunning) return;

        const totalPts = pts.length - 1;
        const idx = Math.min(Math.floor(displayFraction * totalPts), totalPts - 1);
        const t = displayFraction * totalPts - idx;

        const p0 = pts[idx];
        const p1 = pts[Math.min(idx + 1, totalPts)];
        const wx = p0[0] + (p1[0] - p0[0]) * t;
        const wy = p0[1] + (p1[1] - p0[1]) * t;

        const sp = _worldToScreen(wx, wy);

        // Direction vector
        const dx = p1[0] - p0[0];
        const dy = -(p1[1] - p0[1]);
        const angle = Math.atan2(dy, dx);

        ctx.save();
        ctx.translate(sp.x, sp.y);
        ctx.rotate(angle + Math.PI / 2);

        const exhausting = displayFraction >= completionFraction && completionFraction < 1.0;
        const bodyColor = exhausting ? '#ef4444' : C.spacecraft;

        // Thrust flame
        if (!exhausting && animRunning) {
            const flameGrad = ctx.createRadialGradient(0, 8, 1, 0, 14, 8);
            flameGrad.addColorStop(0, 'rgba(255, 200, 50, 0.9)');
            flameGrad.addColorStop(0.4, 'rgba(255, 100, 20, 0.6)');
            flameGrad.addColorStop(1, 'rgba(255, 50, 0, 0)');
            ctx.fillStyle = flameGrad;
            ctx.beginPath();
            ctx.ellipse(0, 10, 3, 8, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // Spacecraft body — stylized diamond/arrow
        ctx.fillStyle = bodyColor;
        ctx.shadowColor = bodyColor;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(3, 2);
        ctx.lineTo(0, 0);
        ctx.lineTo(-3, 2);
        ctx.closePath();
        ctx.fill();

        // Solar panels
        ctx.fillStyle = exhausting ? '#7f1d1d' : '#1d4ed8';
        ctx.shadowBlur = 4;
        ctx.fillRect(-9, -1, 6, 2);
        ctx.fillRect(3, -1, 6, 2);

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Burn Nodes
    // -----------------------------------------------------------------------
    function _drawBurnNodes() {
        if (!trajectoryData.burn_nodes) return;

        trajectoryData.burn_nodes.forEach(node => {
            const sp = _worldToScreen(node.pos[0], node.pos[1]);
            const isHovered = hoveredNode === node;
            const r = isHovered ? 12 : 9;

            ctx.save();

            // Outer glow ring
            ctx.strokeStyle = node.color || C.burnNode;
            ctx.lineWidth = isHovered ? 2.5 : 1.5;
            ctx.shadowColor = node.color || C.burnNode;
            ctx.shadowBlur = isHovered ? 16 : 8;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            ctx.stroke();

            // Center dot
            ctx.fillStyle = isHovered ? (node.color || C.burnNodeHover) : '#0d1526';
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r * 0.45, 0, Math.PI * 2);
            ctx.fill();

            // Label
            const lbl = node.label || '';
            ctx.fillStyle = node.color || C.burnNode;
            ctx.font = `${isHovered ? '700' : '600'} 10px monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(lbl, sp.x, sp.y - r - 5);

            // Hover tooltip
            if (isHovered) {
                const tw = 180;
                const th = 48;
                let tx = sp.x - tw / 2;
                let ty = sp.y + r + 8;
                if (tx < 4) tx = 4;
                if (tx + tw > w - 4) tx = w - tw - 4;
                if (ty + th > h - 4) ty = sp.y - r - th - 8;

                ctx.fillStyle = 'rgba(13, 25, 50, 0.95)';
                ctx.strokeStyle = node.color || C.burnNode;
                ctx.lineWidth = 1;
                _roundRect(ctx, tx, ty, tw, th, 6);
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = node.color || C.burnNode;
                ctx.font = '700 11px system-ui';
                ctx.textAlign = 'left';
                ctx.fillText(node.description || node.label, tx + 8, ty + 16);

                ctx.fillStyle = '#e2e8f0';
                ctx.font = '700 14px monospace';
                ctx.fillText(`ΔV = ${node.dv_ms?.toLocaleString() || '—'} m/s`, tx + 8, ty + 36);
            }

            ctx.restore();
        });
    }

    // -----------------------------------------------------------------------
    // Failure Callout at truncation point
    // -----------------------------------------------------------------------
    function _drawFailureCallout() {
        if (completionFraction >= 1.0 || !trajectoryData.transfer_ellipse_points) return;

        const pts = trajectoryData.transfer_ellipse_points;
        const idx = Math.floor(completionFraction * (pts.length - 1));
        const pt = pts[Math.min(idx, pts.length - 1)];
        const sp = _worldToScreen(pt[0], pt[1]);

        ctx.save();

        // Red X marker
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 12;
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(sp.x - r, sp.y - r); ctx.lineTo(sp.x + r, sp.y + r);
        ctx.moveTo(sp.x + r, sp.y - r); ctx.lineTo(sp.x - r, sp.y + r);
        ctx.stroke();

        // Callout bubble
        const pct = Math.round(completionFraction * 100);
        const msg = `PROPELLANT EXHAUSTED @ ${pct}%`;
        const bw = 220;
        const bh = 36;
        let bx = sp.x + 14;
        let by = sp.y - bh / 2;
        if (bx + bw > w - 4) bx = sp.x - bw - 14;

        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(69, 10, 10, 0.92)';
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1;
        _roundRect(ctx, bx, by, bw, bh, 5);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#fca5a5';
        ctx.font = '700 11px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText('🚨 ' + msg, bx + 8, by + bh / 2 + 4);

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // HUD overlay (top-left info)
    // -----------------------------------------------------------------------
    function _drawHUD() {
        ctx.save();
        const mode = trajectoryData.mode;
        const title = mode === 'earth_moon' ? 'Earth–Moon Transfer' : 'Heliocentric Hohmann Transfer';
        const tf = trajectoryData.transfer_time_days;
        const frac = completionFraction;

        ctx.fillStyle = C.textBright;
        ctx.font = '600 12px system-ui';
        ctx.textAlign = 'left';

        let infoLines = [
            `📡 ${title}`,
            `🕐 Transfer time: ${tf?.toFixed(0) ?? '—'} days`,
            `✅ Completion: ${(frac * 100).toFixed(1)}%`,
        ];

        if (trajectoryData.semi_major_axis_au) {
            infoLines.push(`📏 Semi-major axis: ${trajectoryData.semi_major_axis_au?.toFixed(3)} AU`);
        }
        if (trajectoryData.eccentricity) {
            infoLines.push(`🌀 Eccentricity: ${trajectoryData.eccentricity?.toFixed(4)}`);
        }

        // HUD background
        const hudH = infoLines.length * 16 + 14;
        ctx.fillStyle = 'rgba(4, 8, 15, 0.7)';
        _roundRect(ctx, 10, 10, 220, hudH, 6);
        ctx.fill();

        infoLines.forEach((line, i) => {
            ctx.fillStyle = i === 0 ? '#60a5fa' : C.textBright;
            ctx.font = i === 0 ? '600 11px system-ui' : '400 10px system-ui';
            ctx.fillText(line, 18, 24 + i * 16);
        });

        // Legend
        ctx.fillStyle = C.transferGo;
        ctx.fillRect(14, hudH + 16, 20, 2);
        ctx.fillStyle = C.textBright;
        ctx.font = '400 10px system-ui';
        ctx.fillText('Completed trajectory', 40, hudH + 19);

        ctx.strokeStyle = C.transferNogo;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(14, hudH + 28); ctx.lineTo(34, hudH + 28);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.textBright;
        ctx.fillText('Propellant exhausted', 40, hudH + 31);

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------
    function _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function _darken(hex, factor) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
    }

    function _seededRng(seed) {
        let s = seed;
        return () => {
            s = (s * 1664525 + 1013904223) & 0xffffffff;
            return (s >>> 0) / 0xffffffff;
        };
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return { init, update, resetView: _resetView, startAnimation: _startAnimation };
})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => TRAJ.init());

// Export for app.js
window.TRAJ = TRAJ;
