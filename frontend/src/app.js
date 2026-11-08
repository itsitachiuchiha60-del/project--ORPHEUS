/**
 * app.js — O2S: Mission Architect
 *
 * State Management, Live Reactive Telemetry, Web Audio,
 * Scenario Mode Controller, and UI Orchestrator.
 *
 * Architecture:
 *  - Fetches /api/catalog on load → populates all selects and instrument grid
 *  - On every input change → calls /api/simulate (debounced 150ms) → updates all telemetry bars
 *  - On "LAUNCH & SIMULATE MISSION" → switches to 2D Orbital Map tab → triggers spacecraft animation
 *  - Web Audio API: procedural sound synthesis (clicks, launches, alarms, success chimes)
 *  - Sandbox Mode toggle: disables budget/science constraints
 *  - Post-Mortem Flight Review modal: shown on each launch simulation
 */

// ============================================================================
// Web Audio API — Procedural Sound Engine
// ============================================================================
const Audio = (() => {
    let ctx = null;
    let enabled = false;

    function _getCtx() {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function playClick() {
        if (!enabled) return;
        try {
            const ac = _getCtx();
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.connect(gain); gain.connect(ac.destination);
            osc.frequency.setValueAtTime(600, ac.currentTime);
            osc.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.08);
            gain.gain.setValueAtTime(0.08, ac.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.1);
            osc.start(); osc.stop(ac.currentTime + 0.12);
        } catch (e) {}
    }

    function playLaunch() {
        if (!enabled) return;
        try {
            const ac = _getCtx();
            // Rumble: low noise burst
            const buf = ac.createBuffer(1, ac.sampleRate * 1.5, ac.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.3;

            const src = ac.createBufferSource();
            src.buffer = buf;
            const lowpass = ac.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.value = 120;
            const gain = ac.createGain();
            gain.gain.setValueAtTime(0.6, ac.currentTime);
            gain.gain.linearRampToValueAtTime(0.0, ac.currentTime + 1.5);
            src.connect(lowpass); lowpass.connect(gain); gain.connect(ac.destination);
            src.start();

            // High whistle overtone
            const osc = ac.createOscillator();
            const og = ac.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(80, ac.currentTime);
            osc.frequency.exponentialRampToValueAtTime(240, ac.currentTime + 1.0);
            og.gain.setValueAtTime(0.08, ac.currentTime);
            og.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 1.5);
            osc.connect(og); og.connect(ac.destination);
            osc.start(); osc.stop(ac.currentTime + 1.5);
        } catch (e) {}
    }

    function playAlarm() {
        if (!enabled) return;
        try {
            const ac = _getCtx();
            [0, 0.25, 0.5].forEach(delay => {
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain); gain.connect(ac.destination);
                osc.type = 'square';
                osc.frequency.value = 440;
                gain.gain.setValueAtTime(0.0, ac.currentTime + delay);
                gain.gain.linearRampToValueAtTime(0.07, ac.currentTime + delay + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + 0.18);
                osc.start(ac.currentTime + delay);
                osc.stop(ac.currentTime + delay + 0.2);
            });
        } catch (e) {}
    }

    function playSuccess() {
        if (!enabled) return;
        try {
            const ac = _getCtx();
            const freqs = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
            freqs.forEach((freq, i) => {
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.connect(gain); gain.connect(ac.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t = ac.currentTime + i * 0.12;
                gain.gain.setValueAtTime(0.0, t);
                gain.gain.linearRampToValueAtTime(0.1, t + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
                osc.start(t);
                osc.stop(t + 0.5);
            });
        } catch (e) {}
    }

    function toggle() {
        enabled = !enabled;
        const btn = document.getElementById('audio-btn');
        if (btn) {
            btn.textContent = enabled ? '🔊 AUDIO ON' : '🔇 AUDIO';
            btn.classList.toggle('active', enabled);
        }
        if (enabled) {
            _getCtx(); // unlock audio context
            playClick();
        }
    }

    return { playClick, playLaunch, playAlarm, playSuccess, toggle };
})();

// ============================================================================
// App State & Controller
// ============================================================================
let catalog = null;
let catalogData = null;
let lastResult = null;
let debounceTimer = null;
let sandboxMode = false;

// ============================================================================
// Educational Tooltip Glossary
// Maps display terms → plain-English definitions for citizen scientists.
// tipHTML(str) replaces every occurrence of a glossary term found in `str`
// with <span class="edu-tooltip" data-tip="…">term</span>.
// It never double-wraps: it skips text that is already inside an edu-tooltip.
// ============================================================================
const GLOSSARY = {
    // Core orbital mechanics
    'Delta-V':          'Orbital fuel range. The total change in velocity the spacecraft can achieve.',
    'ΔV':               'Orbital fuel range. The total change in velocity the spacecraft can achieve.',
    'Δv':               'Orbital fuel range. The total change in velocity the spacecraft can achieve.',
    // Propulsion metrics
    'TWR':              'Thrust-to-Weight Ratio (Newton\'s 2nd Law). Engine pushing power vs. spacecraft weight. If too low, gravity wins.',
    'Thrust-to-Weight': 'Thrust-to-Weight Ratio (Newton\'s 2nd Law). Engine pushing power vs. spacecraft weight. If too low, gravity wins.',
    // Injection burns
    'TLI':              'Injection Burn: The massive engine burn that breaks Earth\'s orbit to shoot toward the target.',
    'TMI':              'Injection Burn: The massive engine burn that breaks Earth\'s orbit to shoot toward the target.',
    'TVI':              'Injection Burn: The massive engine burn that breaks Earth\'s orbit to shoot toward the target.',
    'Trans-Lunar Injection': 'Injection Burn: The massive engine burn that breaks Earth\'s orbit to shoot toward the target.',
    'Injection Burn':   'Injection Burn: The massive engine burn that breaks Earth\'s orbit to shoot toward the target.',
    // Atmospheric braking
    'Aerocapture':      'Skimming a planet\'s atmosphere to use friction as a brake, saving fuel.',
    'Aerobraking':      'Skimming a planet\'s atmosphere to use friction as a brake, saving fuel.',
    // Comms
    'COMMS BOTTLENECK': 'Generating more gigabytes of science data than your antenna can beam back to Earth.',
    'Comms Bottleneck': 'Generating more gigabytes of science data than your antenna can beam back to Earth.',
    'DSN':              'Deep Space Network — NASA\'s worldwide antenna system for communicating with distant spacecraft.',
    'HGA':              'High-Gain Antenna — a large dish that focuses radio waves into a tight beam for high-speed deep-space data transfer.',
    // Instruments
    'Spectrometer':     'A chemical analysis tool that separates and identifies exact elements in dirt or atmospheres.',
    'Magnetometer':     'A sensor that measures magnetic fields to detect hidden oceans or molten planetary cores.',
    'LIDAR':            'Laser Altimeter — fires laser pulses to measure surface elevation and shape with centimeter accuracy.',
    'GCMS':             'Gas Chromatograph Mass Spectrometer — identifies individual molecules in soil, ice, or air samples.',
    // Mass
    'Dry Mass':         'The weight of the rocket structure and engines when the fuel tanks are completely empty.',
    'Isp':              'Specific Impulse — a measure of engine fuel efficiency, like "miles per gallon" for rockets.',
    // Orbital mechanics
    'LEO':              'Low Earth Orbit — a circular orbit just above the atmosphere, used as the starting point before deep-space burns.',
    'LOI':              'Lunar Orbit Insertion — the braking burn that slows the spacecraft into lunar orbit.',
    'Semi-major Axis':  'Half the longest diameter of an elliptical orbit — sets the orbit\'s size and determines transfer time.',
    'Eccentricity':     'How stretched an orbit is. 0 = perfect circle, 1 = escape trajectory. Hohmann transfers use ~0.2–0.9.',
    'Hohmann':          'The most fuel-efficient two-burn maneuver for moving between two circular orbits around the same body.',
};

/**
 * tipHTML(htmlString) — scan a raw HTML string for glossary terms and wrap
 * each found term with an .edu-tooltip span carrying title and data-tip attributes.
 *
 * Rules:
 *  - Operates only on text nodes (outside of HTML tags and attributes).
 *  - Processes longer terms before shorter ones to avoid partial wrapping.
 *  - Each term is only wrapped once per text node (first occurrence).
 *  - Terms already inside an edu-tooltip are never double-wrapped.
 *
 * Returns the modified HTML string.
 */
function tipHTML(str) {
    // Sort terms longest-first so "Trans-Lunar Injection" is matched before "Injection"
    const terms = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

    // Split into HTML tokens: tags vs text runs
    // Replace text runs only (segments between < and >)
    return str.replace(/(<[^>]+>|[^<]+)/g, (token) => {
        // If this token is an HTML tag, leave it untouched
        if (token.startsWith('<')) return token;

        // It's a text node — scan for glossary terms (case-sensitive, word-boundary aware)
        let out = token;
        for (const term of terms) {
            // Skip if no occurrence
            if (!out.includes(term)) continue;
            // Build a word-boundary-aware regex. Use \\b for ASCII terms;
            // for terms with Δ (non-ASCII start), just match literally.
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = /^[A-Za-z]/.test(term)
                ? new RegExp(`\\b${escaped}\\b`, 'g')
                : new RegExp(escaped, 'g');
            const def = GLOSSARY[term].replace(/"/g, '&quot;');
            out = out.replace(pattern, (match) => {
                return `<span class="edu-tooltip" title="${def}" data-tip="${def}">${match}</span>`;
            });
            // Once a term is replaced, exit so shorter overlapping terms don't re-match
        }
        return out;
    });
}

// ============================================================================
// Initialization
// ============================================================================
async function init() {
    // Load catalog
    try {
        const resp = await fetch('/api/catalog');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        catalog = await resp.json();
        catalogData = catalog;
    } catch (err) {
        console.error('[O2S] Failed to load catalog:', err);
        showError('Failed to connect to backend. Is the server running?');
        return;
    }

    populateUI();
    bindEvents();

    // Initial simulation on load (silent, no animation)
    await runSimulation(false);
}

// ============================================================================
// Populate UI from Catalog
// ============================================================================
function populateUI() {
    if (!catalog) return;

    // Scenarios
    const scenarioSel = document.getElementById('scenario-select');
    Object.entries(catalog.scenarios).forEach(([key, s]) => {
        const opt = new Option(`${s.difficulty.toUpperCase()} · ${s.name}`, key);
        scenarioSel.appendChild(opt);
    });
    updateScenarioCard();

    // Rockets
    const rocketSel = document.getElementById('rocket-select');
    Object.entries(catalog.rockets).forEach(([key, r]) => {
        const opt = new Option(`${r.name} (${r.agency}) — $${r.cost_m}M`, key);
        rocketSel.appendChild(opt);
    });

    // Power systems
    const powerSel = document.getElementById('power-select');
    Object.entries(catalog.power_systems).forEach(([key, p]) => {
        const icon = p.type === 'nuclear' ? '☢️' : '☀️';
        const opt = new Option(`${icon} ${p.name} (${p.base_power_w_1au}W@1AU, ${p.mass_kg}kg)`, key);
        powerSel.appendChild(opt);
    });

    // Comms systems
    const commsSel = document.getElementById('comms-select');
    Object.entries(catalog.comms_systems).forEach(([key, c]) => {
        const opt = new Option(`${c.name} — ${c.max_data_gb_day} GB/day`, key);
        commsSel.appendChild(opt);
    });

    // Instruments
    const instContainer = document.getElementById('instruments-container');
    Object.entries(catalog.instruments).forEach(([key, inst]) => {
        const label = document.createElement('label');
        label.className = 'inst-label';
        label.dataset.key = key;
        label.innerHTML = `
            <input type="checkbox" class="inst-checkbox" data-key="${key}">
            <div class="inst-info">
                <div class="inst-name">${tipHTML(inst.name)}</div>
                <div class="inst-meta">${inst.mass_kg}kg · ${inst.power_w}W · $${inst.cost_m}M · ${inst.data_gb_day}GB/day</div>
                <div class="inst-pts">${inst.science_pts} science pts<span class="req-mark inst-req-mark" data-key="${key}" style="display:none"> ★ REQUIRED</span></div>
            </div>
        `;
        instContainer.appendChild(label);

        // Update label class when checked
        const cb = label.querySelector('.inst-checkbox');
        cb.addEventListener('change', () => {
            label.classList.toggle('checked', cb.checked);
        });
    });

    // Load 3D model for default rocket
    const defaultRocketKey = rocketSel.value;
    loadRocketModel(defaultRocketKey);
    updateRocketSpecsHUD(defaultRocketKey);
}

function loadCatalog() {
    const defaultRocketKey = document.getElementById('rocket-select')?.value;
    if (defaultRocketKey) {
        loadRocketModel(defaultRocketKey);
        updateRocketSpecsHUD(defaultRocketKey);
    }
}

// ============================================================================
// Event Bindings
// ============================================================================
function bindEvents() {
    // Scenario change → update card + required marks + simulate
    document.getElementById('scenario-select').addEventListener('change', () => {
        Audio.playClick();
        updateScenarioCard();
        updateRequiredMarks();
        scheduleSimulation();
    });

    // Rocket change → load 3D model + simulate
    document.getElementById('rocket-select').addEventListener('change', (e) => {
        const key = e.target.value;
        Audio.playClick();
        loadRocketModel(e.target.value);
        updateRocketSpecsHUD(key);
        scheduleSimulation();
    });

    // Power / Comms selects
    document.getElementById('power-select').addEventListener('change', () => {
        Audio.playClick(); scheduleSimulation();
    });
    document.getElementById('comms-select').addEventListener('change', () => {
        Audio.playClick(); scheduleSimulation();
    });

    // Instrument checkboxes
    document.getElementById('instruments-container').addEventListener('change', () => {
        scheduleSimulation();
    });

    // Sandbox toggle
    document.getElementById('sandbox-toggle').addEventListener('change', (e) => {
        sandboxMode = e.target.checked;
        const badge = document.getElementById('frr-badge');
        if (badge) {
            badge.textContent = sandboxMode ? '⚡ SANDBOX MODE' : 'FRR STANDBY';
            badge.style.background = sandboxMode ? 'rgba(245,158,11,0.15)' : '';
            badge.style.color = sandboxMode ? '#f59e0b' : '';
            badge.style.borderColor = sandboxMode ? 'rgba(245,158,11,0.3)' : '';
        }
        Audio.playClick();
        scheduleSimulation();
    });

    // Audio toggle
    document.getElementById('audio-btn').addEventListener('click', () => Audio.toggle());

    // Launch button → animate trajectory
    document.getElementById('simulate-btn').addEventListener('click', async () => {
        Audio.playLaunch();
        document.getElementById('simulate-btn').classList.add('simulating');
        document.getElementById('simulate-btn').textContent = '⌛ COMPUTING TRAJECTORY…';

        await runSimulation(true);  // animate = true

        document.getElementById('simulate-btn').classList.remove('simulating');
        document.getElementById('simulate-btn').textContent = '🚀 LAUNCH & SIMULATE MISSION';
    });

    // Camera preset buttons
    document.querySelectorAll('.cam-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            Audio.playClick();
            if (window.VAB) window.VAB.setPreset(btn.dataset.preset);
        });
    });

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            Audio.playClick();
            switchTab(btn.dataset.tab);
        });
    });

    // Post-mortem close
    document.getElementById('pm-close')?.addEventListener('click', () => {
        document.getElementById('postmortem-modal').classList.remove('open');
    });
}

// ============================================================================
// Tab Switching
// ============================================================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const content = document.getElementById(`tab-${tabId}`);
    if (btn) btn.classList.add('active');
    if (content) content.classList.add('active');

    // Trigger canvas resize when switching to trajectory tab
    if (tabId === 'trajectory' && window.TRAJ) {
        setTimeout(() => {
            if (lastResult?.trajectory_data) {
                window.TRAJ.update(lastResult.trajectory_data, lastResult.mission_go);
            }
        }, 50);
    }
}

// ============================================================================
// Scenario Card
// ============================================================================
function updateScenarioCard() {
    if (!catalog) return;
    const key = document.getElementById('scenario-select').value;
    const scenario = catalog.scenarios[key];
    if (!scenario) return;

    const card = document.getElementById('scenario-card');
    if (!card) return;
    card.style.display = 'block';

    const diffColor = scenario.difficulty_color || '#64748b';
    card.innerHTML = `
        <div class="diff-badge" style="background:${diffColor}22;color:${diffColor};border:1px solid ${diffColor}44">
            ${scenario.difficulty.toUpperCase()}
        </div>
        <div class="sc-desc">${scenario.description}</div>
        <div class="sc-stats">
            <div class="sc-stat">
                <div class="sc-stat-label">Target</div>
                <div class="sc-stat-val">${scenario.target_body}</div>
            </div>
            <div class="sc-stat">
                <div class="sc-stat-label">Budget</div>
                <div class="sc-stat-val">$${scenario.budget_cap_m}M</div>
            </div>
            <div class="sc-stat">
                <div class="sc-stat-label">Req. ΔV</div>
                <div class="sc-stat-val">${(scenario.required_dv_ms / 1000).toFixed(1)} km/s</div>
            </div>
            <div class="sc-stat">
                <div class="sc-stat-label">Solar Dist.</div>
                <div class="sc-stat-val">${scenario.solar_distance_au} AU</div>
            </div>
        </div>
    `;

    updateRequiredMarks();
}

function updateRequiredMarks() {
    if (!catalog) return;
    const key = document.getElementById('scenario-select').value;
    const scenario = catalog.scenarios[key];
    const required = scenario?.required_instruments || [];

    document.querySelectorAll('.inst-req-mark').forEach(mark => {
        const instKey = mark.dataset.key;
        mark.style.display = required.includes(instKey) ? 'inline' : 'none';
    });
}

// ============================================================================
// 3D Model Loader
// ============================================================================
function loadRocketModel(rocketKey) {
    if (!catalog || !rocketKey || !window.VAB) return;
    const rocket = catalog.rockets[rocketKey];
    if (!rocket) return;

    const glbFile = rocket.model_glb;
    // URL-encode filename to handle spaces (e.g. "falcon heavy.glb" → "falcon%20heavy.glb")
    const url = `/3d assets/${encodeURIComponent(glbFile)}`;

    document.getElementById('vab-model-name').textContent = `Loading ${rocket.name}…`;
    window.VAB.loadModel(url, rocket.name);
}

// ============================================================================
// Debounced Simulation (live reactive updates)
// ============================================================================
function scheduleSimulation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSimulation(false), 150);
}

// ============================================================================
// Core Simulation
// ============================================================================
async function runSimulation(launchMode = false) {
    if (!catalog) return;

    const payload = buildRequest();
    if (!payload) return;

    if (launchMode) {
        document.getElementById('global-loading').classList.add('show');
    }

    try {
        const resp = await fetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }

        const result = await resp.json();
        lastResult = result;

        updateTelemetryPanel(result);
        updateStageTelemetryTab(result);

        if (launchMode) {
            // Switch to 2D orbital map and animate
            switchTab('trajectory');
            if (window.TRAJ) {
                window.TRAJ.update(result.trajectory_data, result.mission_go);
                setTimeout(() => window.TRAJ.startAnimation(), 300);
            }

            if (result.mission_go) {
                Audio.playSuccess();
            } else {
                Audio.playAlarm();
            }

            // Show post-mortem modal
            showPostMortem(result);
        }

    } catch (err) {
        console.error('[O2S] Simulation error:', err);
        if (launchMode) showError(`Simulation error: ${err.message}`);
    } finally {
        document.getElementById('global-loading').classList.remove('show');
    }
}

// ============================================================================
// Build Request Payload
// ============================================================================
function buildRequest() {
    const scenario = document.getElementById('scenario-select')?.value;
    const rocket = document.getElementById('rocket-select')?.value;
    const power = document.getElementById('power-select')?.value;
    const comms = document.getElementById('comms-select')?.value;

    if (!scenario || !rocket || !power || !comms) return null;

    const instKeys = Array.from(
        document.querySelectorAll('.inst-checkbox:checked')
    ).map(cb => cb.dataset.key);

    return {
        scenario_key: scenario,
        rocket_key: rocket,
        power_key: power,
        comms_key: comms,
        instrument_keys: instKeys,
        sandbox_mode: sandboxMode,
    };
}

// ============================================================================
// Telemetry Panel Updates
// ============================================================================
function updateTelemetryPanel(r) {
    // Status banner
    const banner = document.getElementById('status-banner');
    if (banner) {
        banner.className = `status-banner ${r.mission_go ? 'status-go' : 'status-nogo'}`;
        banner.textContent = r.mission_go
            ? `✅ MISSION GO — CLEARED FOR LAUNCH (Score: ${r.score}/1000)`
            : `🚫 MISSION NO-GO — ${r.failures.length} CONSTRAINT VIOLATION${r.failures.length > 1 ? 'S' : ''}`;
    }

    // Score display
    const scoreSec = document.getElementById('score-display');
    if (scoreSec) {
        scoreSec.style.display = 'block';
        document.getElementById('score-num').textContent = r.score.toLocaleString();
        const gradeEl = document.getElementById('score-grade');
        gradeEl.textContent = r.grade;
        gradeEl.className = `score-grade grade-${r.grade}`;
    }

    // Mass
    setMetric('mass',
        `${r.total_payload_mass_kg.toLocaleString()} kg`,
        `of ${r.max_leo_payload_kg.toLocaleString()} kg fairing limit`,
        r.total_payload_mass_kg / r.max_leo_payload_kg,
        thresholdColor(r.total_payload_mass_kg / r.max_leo_payload_kg, 0.7, 0.9)
    );

    // ΔV
    const dvFrac = Math.min(1, r.available_dv_ms / r.required_dv_ms);
    setMetric('dv',
        `${r.available_dv_ms.toLocaleString()} m/s`,
        `Required: ${r.required_dv_ms.toLocaleString()} m/s — Margin: ${r.dv_margin_ms.toFixed(0)} m/s`,
        dvFrac,
        dvFrac >= 1.0 ? 'bar-green' : (dvFrac >= 0.85 ? 'bar-amber' : 'bar-red'),
    );

    // Cost
    const costFrac = r.total_cost_m / r.budget_cap_m;
    setMetric('cost',
        `$${r.total_cost_m.toFixed(0)}M`,
        `Grant cap: $${r.budget_cap_m}M — ${sandboxMode ? 'SANDBOX (unlimited)' : ''}`,
        Math.min(1, costFrac),
        costFrac > 1.0 ? 'bar-red' : (costFrac > 0.85 ? 'bar-amber' : 'bar-green')
    );

    // Power
    const powerFrac = Math.min(1.5, r.available_power_w / r.required_power_w);
    setMetric('power',
        `${r.available_power_w.toFixed(0)} W`,
        `Required: ${r.required_power_w.toFixed(0)} W (1/r²=${r.solar_irradiance_factor.toFixed(3)}× at ${r.solar_distance_au}AU)`,
        Math.min(1, powerFrac),
        powerFrac >= 1.0 ? 'bar-amber' : 'bar-red'
    );

    // Data
    const dataFrac = r.data_transmission_ratio;
    setMetric('data',
        `${r.comms_capacity_gb_day.toFixed(1)} GB/day`,
        `Generated: ${r.data_generated_gb_day.toFixed(1)} GB/day — ${(dataFrac * 100).toFixed(0)}% transmitted`,
        dataFrac,
        dataFrac >= 1.0 ? 'bar-cyan' : (dataFrac >= 0.6 ? 'bar-amber' : 'bar-red')
    );

    // Science
    const scienceFrac = r.effective_science_pts / r.min_science_pts;
    setMetric('science',
        `${r.effective_science_pts.toFixed(0)} pts`,
        `Minimum threshold: ${r.min_science_pts} pts — ${(scienceFrac * 100).toFixed(0)}% of target`,
        Math.min(1, scienceFrac),
        scienceFrac >= 1.0 ? 'bar-green' : (scienceFrac >= 0.75 ? 'bar-amber' : 'bar-red')
    );

    // Transfer info
    const ti = document.getElementById('transfer-info');
    if (ti) {
        ti.style.display = 'block';
        document.getElementById('ti-days').textContent = `${r.transfer_time_days?.toFixed(1) ?? '—'} days`;
        document.getElementById('ti-frac').textContent = `${(r.completion_fraction * 100).toFixed(1)}%`;
        document.getElementById('ti-sma').textContent = `${r.semi_major_axis_au?.toFixed(3) ?? '—'} AU`;
        document.getElementById('ti-ecc').textContent = r.eccentricity?.toFixed(4) ?? '—';
    }

    // Failures & Warnings
    const failSec = document.getElementById('failures-section');
    if (failSec) {
        failSec.innerHTML = '';
        r.failures.forEach(f => {
            const div = document.createElement('div');
            div.className = 'failure-item';
            div.innerHTML = tipHTML(f);
            failSec.appendChild(div);
        });
        r.warnings.forEach(w => {
            const div = document.createElement('div');
            div.className = 'warning-item';
            div.innerHTML = tipHTML(w);
            failSec.appendChild(div);
        });
    }

    // FRR badge
    const frrBadge = document.getElementById('frr-badge');
    if (frrBadge && !sandboxMode) {
        frrBadge.textContent = r.mission_go ? '✅ FRR: GO' : '🚫 FRR: NO-GO';
        frrBadge.style.background = r.mission_go ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
        frrBadge.style.color = r.mission_go ? '#10b981' : '#ef4444';
        frrBadge.style.borderColor = r.mission_go ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
    }
}

function setMetric(id, value, sub, fraction, barClass) {
    const mv = document.getElementById(`mv-${id}`);
    const ms = document.getElementById(`ms-${id}`);
    const mb = document.getElementById(`mb-${id}`);
    const mc = document.getElementById(`mc-${id}`);

    if (mv) mv.textContent = value;
    if (ms) ms.textContent = sub;
    if (mb) {
        mb.style.width = `${Math.min(100, Math.max(0, (fraction || 0) * 100)).toFixed(1)}%`;
        mb.className = `bar-fill ${barClass || 'bar-blue'}`;
    }
    if (mc) {
        mc.className = 'metric-card';
        if (barClass === 'bar-red') mc.classList.add('danger');
        else if (barClass === 'bar-amber') mc.classList.add('warn');
        else mc.classList.add('ok');
    }
}

function thresholdColor(fraction, warnAt, dangerAt) {
    if (fraction >= dangerAt) return 'bar-red';
    if (fraction >= warnAt) return 'bar-amber';
    return 'bar-blue';
}

// ============================================================================
// Stage & Link Telemetry Tab
// ============================================================================
function updateStageTelemetryTab(r) {
    const container = document.getElementById('telemetry-tab');
    if (!container) return;

    const maxDv = Math.max(...r.stage_breakdown.map(s => s.raw_dv_ms), 1);

    let html = `
        <div style="margin-bottom:14px">
            <div class="section-header" style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">
                ${tipHTML(`Stage-by-Stage ΔV Breakdown · ${r.rocket_name}`)}
            </div>
            <table class="stag-table">
                <thead>
                    <tr>
                        <th>Stage</th>
                        <th>Propellant</th>
                        <th>${tipHTML('Isp (s)')}</th>
                        <th>${tipHTML('Dry Mass')} → Final (kg)</th>
                        <th>${tipHTML('ΔV')} (m/s)</th>
                    </tr>
                </thead>
                <tbody>
    `;

    r.stage_breakdown.forEach(stage => {
        const frac = stage.raw_dv_ms / maxDv;
        html += `
            <tr>
                <td>${stage.stage_name}</td>
                <td style="color:var(--text-muted);font-size:0.72rem">${stage.propellant || '—'}</td>
                <td>${stage.isp_s || '—'}</td>
                <td style="font-size:0.72rem;font-variant-numeric:tabular-nums">
                    ${stage.m_initial_kg.toLocaleString()} → ${stage.m_final_kg.toLocaleString()}
                    <br><span style="color:var(--text-muted)">ratio: ${stage.mass_ratio}</span>
                </td>
                <td>
                    <div class="dv-bar-wrap">
                        <span style="font-weight:700;font-variant-numeric:tabular-nums">${stage.raw_dv_ms.toLocaleString()}</span>
                        <div class="dv-bar-bg" style="min-width:60px">
                            <div class="dv-bar-fill" style="width:${(frac*100).toFixed(1)}%"></div>
                        </div>
                    </div>
                    ${stage.twr_warning ? `<div style="color:var(--accent-amber);font-size:0.65rem;margin-top:2px">${tipHTML(stage.twr_warning)}</div>` : ''}
                </td>
            </tr>
        `;
    });

    const ascent_loss = 1650;
    html += `
                </tbody>
                <tfoot>
                    <tr style="border-top:2px solid var(--border)">
                        <td colspan="4" style="font-weight:700;color:var(--text-muted)">${tipHTML('Total Raw ΔV')}</td>
                        <td style="font-weight:700">${(r.available_dv_ms + ascent_loss).toFixed(0).toLocaleString()} m/s</td>
                    </tr>
                    <tr>
                        <td colspan="4" style="color:var(--text-muted)">— Gravity &amp; Drag Losses</td>
                        <td style="color:var(--accent-red)">−${ascent_loss} m/s</td>
                    </tr>
                    <tr>
                        <td colspan="4" style="font-weight:800;color:var(--accent-cyan)">${tipHTML('Effective ΔV')}</td>
                        <td style="font-weight:800;color:var(--accent-cyan)">${r.available_dv_ms.toLocaleString()} m/s</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    `;

    // Burn budget breakdown
    if (r.burn_budget && Object.keys(r.burn_budget).length > 0) {
        html += `<div class="burn-budget-section">
            <div class="section-header" style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">${tipHTML('Mission ΔV Budget')}</div>
        `;
        const burns = [
            { label: 'LEO Ascent', key: 'dv_leo_ms', color: '#64748b' },
            { label: r.burn_budget.injection_label || 'Injection Burn', key: 'dv_injection_ms', color: '#f59e0b' },
            { label: r.burn_budget.capture_label || 'Capture Burn', key: 'dv_capture_ms', color: '#3b82f6' },
            { label: r.burn_budget.descent_label || 'Descent/Landing', key: 'dv_descent_ms', color: '#10b981' },
        ];
        burns.forEach(burn => {
            const dv = r.burn_budget[burn.key];
            if (!dv) return;
            html += `<div class="burn-row">
                <span class="burn-label">${tipHTML(burn.label)}</span>
                <span class="burn-dv" style="color:${burn.color}">${dv.toLocaleString()} m/s</span>
            </div>`;
        });
        html += `<div class="burn-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px">
            <span style="font-weight:700">Total Required</span>
            <span style="font-weight:700;color:var(--accent-cyan)">${r.required_dv_ms.toLocaleString()} m/s</span>
        </div>`;
        html += `</div>`;
    }

    // DSN Link Budget section
    html += `
        <div class="link-budget-section">
            <div class="section-header" style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">
                ${tipHTML(`DSN Link Budget · ${r.solar_distance_au} AU`)}
            </div>
            <div class="link-row">
                <span class="link-label">Data Generated</span>
                <span class="link-val">${r.data_generated_gb_day.toFixed(1)} GB/day</span>
            </div>
            <div class="link-row">
                <span class="link-label">${tipHTML('Comms Bottleneck')} Capacity (at distance)</span>
                <span class="link-val" style="color:${r.data_transmission_ratio < 1 ? 'var(--accent-red)' : 'var(--accent-green)'}">${r.comms_capacity_gb_day.toFixed(1)} GB/day</span>
            </div>
            <div class="link-row">
                <span class="link-label">Transmission Ratio</span>
                <span class="link-val">${(r.data_transmission_ratio * 100).toFixed(1)}%</span>
            </div>
            <div class="link-row">
                <span class="link-label">Raw Science Points</span>
                <span class="link-val">${r.raw_science_pts}</span>
            </div>
            <div class="link-row">
                <span class="link-label">${tipHTML('Effective Science (after bottleneck)')}</span>
                <span class="link-val" style="color:var(--accent-cyan)">${r.effective_science_pts.toFixed(0)}</span>
            </div>
            <div class="ratio-bar-wrap">
                <span style="font-size:0.65rem;color:var(--text-muted);min-width:60px">Data Link</span>
                <div class="ratio-bar-bg">
                    <div class="ratio-bar-fill" style="width:${(r.data_transmission_ratio * 100).toFixed(1)}%;background:${r.data_transmission_ratio >= 1 ? 'var(--accent-green)' : (r.data_transmission_ratio >= 0.6 ? 'var(--accent-amber)' : 'var(--accent-red)')}"></div>
                </div>
                <span style="font-size:0.75rem;font-weight:700;min-width:36px;text-align:right">${(r.data_transmission_ratio * 100).toFixed(0)}%</span>
            </div>
        </div>

        <!-- Power Balance -->
        <div class="link-budget-section" style="margin-top:16px">
            <div class="section-header" style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">
                Power Balance · ${r.power_system_type === 'nuclear' ? '☢️ Nuclear RTG (constant)' : `☀️ Solar (1/r² at ${r.solar_distance_au} AU = ${r.solar_irradiance_factor}×)`}
            </div>
            <div class="link-row">
                <span class="link-label">Available Power</span>
                <span class="link-val" style="color:${r.available_power_w >= r.required_power_w ? 'var(--accent-green)' : 'var(--accent-red)'}">${r.available_power_w.toFixed(0)} W</span>
            </div>
            <div class="link-row">
                <span class="link-label">Required Power</span>
                <span class="link-val">${r.required_power_w.toFixed(0)} W</span>
            </div>
            <div class="link-row">
                <span class="link-label">Power Margin</span>
                <span class="link-val" style="color:${r.power_margin_w >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${r.power_margin_w >= 0 ? '+' : ''}${r.power_margin_w.toFixed(0)} W</span>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// ============================================================================
// Post-Mortem Modal
// ============================================================================
function showPostMortem(r) {
    const modal = document.getElementById('postmortem-modal');
    const content = document.getElementById('postmortem-content');
    if (!modal || !content) return;

    const verdictClass = r.mission_go ? 'go' : 'nogo';
    const verdictText = r.mission_go
        ? '✅ MISSION CLEARED — LAUNCH AUTHORIZED'
        : '🚫 MISSION SCRUBBED — CONSTRAINTS VIOLATED';

    const scoreColor = r.score >= 900 ? '#ffd700' : r.score >= 750 ? '#10b981' : r.score >= 550 ? '#3b82f6' : r.score >= 300 ? '#f59e0b' : '#ef4444';

    let html = `
        <div class="postmortem-score">
            <div class="pm-score-num" style="color:${scoreColor}">${r.score}<span style="font-size:1.2rem;color:var(--text-muted)">/1000</span></div>
            <div class="pm-verdict ${verdictClass}">${verdictText}</div>
            <div style="font-size:0.9rem;margin-top:4px;color:var(--text-muted)">Grade: <strong style="color:${scoreColor};font-size:1.1rem">${r.grade}</strong></div>
        </div>

        <div class="pm-section">
            <h4>Mission Summary</h4>
            <div class="pm-row"><span class="pm-label">Scenario</span><span class="pm-val">${r.scenario_name}</span></div>
            <div class="pm-row"><span class="pm-label">Launch Vehicle</span><span class="pm-val">${r.rocket_name}</span></div>
            <div class="pm-row"><span class="pm-label">Total Cost</span><span class="pm-val" style="color:${r.total_cost_m > r.budget_cap_m ? 'var(--accent-red)' : 'var(--accent-green)'}">$${r.total_cost_m.toFixed(0)}M / $${r.budget_cap_m}M cap</span></div>
            <div class="pm-row"><span class="pm-label">Payload Mass</span><span class="pm-val">${r.total_payload_mass_kg.toLocaleString()} kg</span></div>
        </div>

        <div class="pm-section">
            <h4>Propulsion Analysis</h4>
            <div class="pm-row"><span class="pm-label">${tipHTML('Available ΔV')}</span><span class="pm-val">${r.available_dv_ms.toLocaleString()} m/s</span></div>
            <div class="pm-row"><span class="pm-label">${tipHTML('Required ΔV')}</span><span class="pm-val">${r.required_dv_ms.toLocaleString()} m/s</span></div>
            <div class="pm-row"><span class="pm-label">${tipHTML('ΔV Margin')}</span><span class="pm-val" style="color:${r.dv_margin_ms >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
                ${r.dv_margin_ms >= 0 ? '+' : ''}${r.dv_margin_ms.toFixed(0)} m/s
            </span></div>
            <div class="pm-row"><span class="pm-label">Trajectory Completion</span><span class="pm-val">${(r.completion_fraction * 100).toFixed(1)}%</span></div>
        </div>

        <div class="pm-section">
            <h4>Science &amp; Comms</h4>
            <div class="pm-row"><span class="pm-label">Raw Science Points</span><span class="pm-val">${r.raw_science_pts}</span></div>
            <div class="pm-row"><span class="pm-label">${tipHTML('DSN')} Data Ratio</span><span class="pm-val">${(r.data_transmission_ratio * 100).toFixed(0)}%</span></div>
            <div class="pm-row"><span class="pm-label">${tipHTML('Effective Science')}</span><span class="pm-val" style="color:var(--accent-cyan)">${r.effective_science_pts.toFixed(0)} pts</span></div>
            <div class="pm-row"><span class="pm-label">Science Threshold</span><span class="pm-val">${r.min_science_pts} pts minimum</span></div>
        </div>
    `;

    // Failures
    if (r.failures.length > 0) {
        html += `<div class="pm-section"><h4>🚨 Failure Analysis (${r.failures.length})</h4>`;
        r.failures.forEach(f => {
            html += `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:5px;padding:8px;margin-bottom:6px;font-size:0.75rem;color:#fca5a5;line-height:1.5">${tipHTML(f)}</div>`;
        });
        html += `</div>`;
    }

    // Warnings
    if (r.warnings.length > 0) {
        html += `<div class="pm-section"><h4>⚠ Warnings (${r.warnings.length})</h4>`;
        r.warnings.forEach(w => {
            html += `<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:5px;padding:8px;margin-bottom:6px;font-size:0.75rem;color:#fcd34d;line-height:1.5">${tipHTML(w)}</div>`;
        });
        html += `</div>`;
    }

    content.innerHTML = html;
    modal.classList.add('open');
}

// ============================================================================
// Error Helper
// ============================================================================
function showError(msg) {
    const banner = document.getElementById('status-banner');
    if (banner) {
        banner.className = 'status-banner status-nogo';
        banner.textContent = `❌ ERROR: ${msg}`;
    }
}

// ============================================================================
// Boot
// ============================================================================
document.addEventListener('DOMContentLoaded', init);

function updateRocketSpecsHUD(rocketKey) {
    if (!catalogData || !catalogData.rockets) return;
    const rocket = catalogData.rockets[rocketKey];
    if (!rocket) return;
    
    document.getElementById('rocket-specs-overlay').style.display = 'block';
    document.getElementById('hud-rocket-name').textContent = rocket.name;
    document.getElementById('hud-rocket-agency').textContent = rocket.agency;
    document.getElementById('hud-rocket-leo').textContent = rocket.max_leo_payload_kg.toLocaleString() + ' kg';
    document.getElementById('hud-rocket-cost').textContent = '$' + rocket.cost_m + 'M';
    
    const stagesContainer = document.getElementById('hud-rocket-stages');
    stagesContainer.innerHTML = '<div class="hud-subtitle" style="margin-top: 12px;">Stage Breakdown</div>';
    
    rocket.stages.forEach((stage, idx) => {
        stagesContainer.innerHTML += `
            <div class="hud-stage-card">
                <div class="hud-stage-name">Stage ${idx + 1}: ${stage.name}</div>
                <div class="hud-stage-stats">
                    <span>Dry: ${stage.dry_mass_kg.toLocaleString()} kg</span>
                    <span>Prop: ${stage.prop_mass_kg.toLocaleString()} kg</span>
                    <span>ISP: ${stage.isp_s}s</span>
                </div>
            </div>
        `;
    });
}