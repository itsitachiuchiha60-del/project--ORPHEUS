"""
backend/logic.py — O2S: Mission Architect Physics Engine

Implements:
  1. Sequential Multi-Stage Tsiolkovsky ΔV with TWR check
  2. Patched-conics Hohmann transfer burn-node budget
  3. Inverse-square solar irradiance (1/r²) power balance
  4. DSN Link Budget & data bottleneck penalty
  5. Educational Post-Mortem diagnostics (0–1000 score, S/A/B/C/F rank)
  6. Parametric 2D trajectory points for the orbital canvas
"""

import math
import numpy as np

# ---------------------------------------------------------------------------
# Physical Constants
# ---------------------------------------------------------------------------
G0 = 9.80665                   # Standard gravity (m/s²) — NIST 2018
GRAVITY_DRAG_LOSS_MS = 1650.0  # Ascent gravity + atmospheric drag losses (m/s)

GM_SUN = 1.32712440018e20     # Heliocentric gravitational parameter (m³/s²)
GM_EARTH = 3.986004418e14     # Geocentric gravitational parameter (m³/s²)
GM_MOON = 4.9048695e12        # Selenocentric gravitational parameter (m³/s²)
AU_M = 1.495978707e11         # Meters per Astronomical Unit

# Earth-Moon transfer constants
R_EARTH_M = 6.371e6           # Earth mean radius (m)
R_MOON_M = 1.7374e6           # Moon mean radius (m)
D_MOON_M = 3.844e8            # Earth-Moon mean distance (m)
LEO_ALT_M = 200e3             # Parking orbit altitude (m)
LEO_R_M = R_EARTH_M + LEO_ALT_M

# Base spacecraft bus parameters
BASE_BUS_MASS_KG = 250.0
BASE_BUS_COST_M = 20.0
BASE_BUS_POWER_W = 80.0

# Score weights
SCORE_SCIENCE_MAX = 500
SCORE_BUDGET_MAX = 300
SCORE_MARGIN_MAX = 200


# ---------------------------------------------------------------------------
# 1. Multi-Stage Tsiolkovsky ΔV  (rocket equation per stage)
# ---------------------------------------------------------------------------
def calculate_multistage_dv(stages: list, payload_mass_kg: float) -> tuple[float, list]:
    """
    Compute effective ΔV for a multi-stage rocket carrying a given payload mass.

    For stage i, the initial mass includes all propellant of that stage plus
    the total mass of all upper stages and the spacecraft payload:

        m_initial,i = m_dry,i + m_prop,i + Σ(k=i+1..N)(m_dry,k + m_prop,k) + m_sc
        m_final,i   = m_dry,i + Σ(k=i+1..N)(m_dry,k + m_prop,k) + m_sc
        ΔV_i        = Isp,i × g₀ × ln(m_initial,i / m_final,i)

    Total effective ΔV subtracts ascent gravity and drag losses:
        ΔV_eff = max(0, ΣΔV_i − 1650 m/s)

    Returns (effective_dv_ms, stage_breakdown_list).
    """
    total_raw_dv = 0.0
    stage_breakdown = []

    for i, stage in enumerate(stages):
        # Mass of all stages above this one (fully fueled)
        upper_mass = sum(
            s["dry_mass_kg"] + s["prop_mass_kg"]
            for s in stages[i + 1:]
        )

        m_initial = (
            stage["dry_mass_kg"]
            + stage["prop_mass_kg"]
            + upper_mass
            + payload_mass_kg
        )
        m_final = (
            stage["dry_mass_kg"]
            + upper_mass
            + payload_mass_kg
        )

        if m_final <= 0 or m_initial <= m_final:
            # Degenerate case — no propellant contributes ΔV
            stage_breakdown.append({
                "stage_name": stage["name"],
                "raw_dv_ms": 0.0,
                "m_initial_kg": round(m_initial, 1),
                "m_final_kg": round(m_final, 1),
                "mass_ratio": 1.0,
                "twr_warning": "ERROR: Zero or negative propellant mass",
            })
            continue

        mass_ratio = m_initial / m_final
        stage_dv = stage["isp_s"] * G0 * math.log(mass_ratio)
        total_raw_dv += stage_dv

        # Thrust-to-Weight Ratio check at stage ignition
        twr_warning = None
        if "thrust_kn" in stage and stage["thrust_kn"] > 0:
            twr = (stage["thrust_kn"] * 1000.0) / (m_initial * G0)
            if twr < 1.15:
                twr_warning = (
                    f"⚠ LOW TWR {twr:.2f} for '{stage['name']}' — "
                    f"insufficient thrust to lift combined vehicle stack off the pad"
                )

        stage_breakdown.append({
            "stage_name": stage["name"],
            "propellant": stage.get("propellant", "Unknown"),
            "isp_s": stage["isp_s"],
            "raw_dv_ms": round(stage_dv, 1),
            "m_initial_kg": round(m_initial, 1),
            "m_final_kg": round(m_final, 1),
            "mass_ratio": round(mass_ratio, 4),
            "twr_warning": twr_warning,
        })

    effective_dv = max(0.0, total_raw_dv - GRAVITY_DRAG_LOSS_MS)
    return round(effective_dv, 1), stage_breakdown


# ---------------------------------------------------------------------------
# 2. Hohmann Transfer Burn Budget & Trajectory Points
# ---------------------------------------------------------------------------
def _earth_moon_trajectory(scenario: dict) -> dict:
    """
    Compute Earth-Moon transfer trajectory in units normalized to Earth-Moon distance.
    Uses patched-conics: LEO → TLI burn → lunar transfer ellipse → LOI.
    """
    r1 = LEO_R_M                     # LEO parking orbit radius from Earth center
    r2 = D_MOON_M + R_MOON_M + 100e3 # Lunar orbit: Moon surface + 100 km alt

    # Transfer ellipse semi-major axis
    a_t = (r1 + r2) / 2.0
    e_t = (r2 - r1) / (r2 + r1)
    p_t = a_t * (1.0 - e_t ** 2)     # Semi-latus rectum

    # Transfer time (half-period of ellipse under GM_EARTH)
    T_half = math.pi * math.sqrt(a_t ** 3 / GM_EARTH)

    # TLI burn: ΔV from LEO circular to transfer ellipse periapsis
    v_circ_leo = math.sqrt(GM_EARTH / r1)
    v_perigee_t = math.sqrt(GM_EARTH * (2.0 / r1 - 1.0 / a_t))
    dv_tli = v_perigee_t - v_circ_leo

    # LOI burn: ΔV from hyperbolic arrival to 100 km lunar circular orbit
    # Arrival velocity at Moon SOI (approximated as v at apoapsis of transfer)
    v_apogee_t = math.sqrt(GM_EARTH * (2.0 / r2 - 1.0 / a_t))
    # Moon orbital speed (doesn't matter for relative arrival, simplified approach)
    # LOI ΔV to circular lunar orbit at r_moon_orb
    r_moon_orb = R_MOON_M + 100e3
    v_circ_moon = math.sqrt(GM_MOON / r_moon_orb)
    # Hyperbolic excess velocity relative to Moon
    v_inf_moon = abs(v_apogee_t - math.sqrt(GM_EARTH / D_MOON_M))
    v_hyperbolic = math.sqrt(v_inf_moon ** 2 + 2.0 * GM_MOON / r_moon_orb)
    dv_loi = abs(v_hyperbolic - v_circ_moon)

    # Parametric transfer ellipse points (normalized: 1 unit = D_MOON_M)
    N_POINTS = 180
    points = []
    for i in range(N_POINTS + 1):
        theta = math.pi * i / N_POINTS      # 0 → π (departure at θ=0, arrival at θ=π)
        r = p_t / (1.0 + e_t * math.cos(theta))
        x = r * math.cos(theta) / D_MOON_M
        y = r * math.sin(theta) / D_MOON_M
        points.append([round(x, 6), round(y, 6)])

    # Burn node positions (in normalized units)
    burn_nodes = [
        {
            "label": "TLI",
            "description": "Trans-Lunar Injection",
            "pos": [round(r1 / D_MOON_M, 6), 0.0],
            "dv_ms": round(dv_tli, 1),
            "color": "#f59e0b",
        },
        {
            "label": "LOI",
            "description": "Lunar Orbit Insertion",
            "pos": [round(-r2 / D_MOON_M, 6), 0.0],
            "dv_ms": round(dv_loi, 1),
            "color": "#3b82f6",
        },
    ]

    return {
        "mode": "earth_moon",
        "units": "normalized (1 = Earth-Moon distance = 384,400 km)",
        "central_body": {
            "label": "Earth", "pos": [0.0, 0.0],
            "color": "#4a90d9", "display_radius": 0.045,
        },
        "target_body": {
            "label": "Moon", "pos": [-1.0, 0.0],
            "color": "#aaaaaa", "display_radius": 0.012,
        },
        "parking_orbit_r": round(r1 / D_MOON_M, 6),
        "target_orbit_r": round(r2 / D_MOON_M, 6),
        "transfer_ellipse_points": points,
        "burn_nodes": burn_nodes,
        "semi_major_axis_norm": round(a_t / D_MOON_M, 4),
        "eccentricity": round(e_t, 4),
        "transfer_time_days": round(T_half / 86400.0, 2),
    }


def _solar_system_trajectory(scenario: dict) -> dict:
    """
    Compute heliocentric Hohmann transfer trajectory in AU.
    Coordinate system: Sun at (0,0), Earth at (1,0) AU.
    For outer planets (R>1 AU): Earth at periapsis, target at apoapsis.
    For inner planets (R<1 AU): Earth at apoapsis, target at periapsis.
    """
    r1_au = 1.0                        # Earth orbit
    r2_au = scenario["solar_distance_au"]
    r1 = r1_au * AU_M
    r2 = r2_au * AU_M

    outer = r2_au > r1_au

    # Transfer ellipse orbital elements
    a_t = (r1 + r2) / 2.0             # Semi-major axis (m)
    e_t = abs(r2 - r1) / (r2 + r1)   # Eccentricity

    # Heliocentric circular velocities
    v_earth = math.sqrt(GM_SUN / r1)   # ~29,785 m/s
    v_target = math.sqrt(GM_SUN / r2)

    # Velocities on the transfer ellipse at periapsis and apoapsis
    v_perihelion_t = math.sqrt(GM_SUN * (2.0 / min(r1, r2) - 1.0 / a_t))
    v_aphelion_t = math.sqrt(GM_SUN * (2.0 / max(r1, r2) - 1.0 / a_t))

    # Injection ΔV (burn at Earth orbit to enter transfer ellipse)
    if outer:
        dv_injection = abs(v_perihelion_t - v_earth)
        dv_capture = abs(v_target - v_aphelion_t)
    else:
        # Inner planet: Earth is at apoapsis → departure burn reduces velocity
        dv_injection = abs(v_earth - v_aphelion_t)
        dv_capture = abs(v_target - v_perihelion_t)

    # Transfer time (half-period under GM_SUN)
    T_half = math.pi * math.sqrt(a_t ** 3 / GM_SUN)

    # Polar parametric ellipse: r(θ) = a(1-e²) / (1 + e·cosθ)
    # For outer: θ=0 at Earth (periapsis), θ=π at target (apoapsis)
    # For inner: θ=0 at target (periapsis), θ=π at Earth (apoapsis), then flip x
    p_t = a_t * (1.0 - e_t ** 2)      # Semi-latus rectum (m)

    N_POINTS = 180
    points = []
    for i in range(N_POINTS + 1):
        theta = math.pi * i / N_POINTS
        r = p_t / (1.0 + e_t * math.cos(theta))
        x_au = (r * math.cos(theta)) / AU_M
        y_au = (r * math.sin(theta)) / AU_M
        if not outer:
            # Flip x so Earth stays at (1, 0)
            x_au = -x_au
        points.append([round(x_au, 6), round(y_au, 6)])

    # Target body position (at apoapsis of transfer ellipse, opposite Earth)
    target_x = -r2_au if outer else r2_au

    burn_nodes = [
        {
            "label": "Inject",
            "description": scenario["burn_budget"]["injection_label"],
            "pos": [1.0, 0.0],
            "dv_ms": round(dv_injection, 1),
            "color": "#f59e0b",
        },
        {
            "label": "Capture",
            "description": scenario["burn_budget"]["capture_label"],
            "pos": [round(target_x, 4), 0.0],
            "dv_ms": round(dv_capture, 1),
            "color": "#3b82f6",
        },
    ]

    # Add descent node if applicable
    if scenario["burn_budget"].get("dv_descent_ms", 0) > 0:
        burn_nodes.append({
            "label": "Land",
            "description": scenario["burn_budget"]["descent_label"],
            "pos": [round(target_x, 4), 0.0],
            "dv_ms": scenario["burn_budget"]["dv_descent_ms"],
            "color": "#10b981",
        })

    # Orbital rings for central body and target
    # Earth orbit ring points (circle at r=1 AU)
    n_ring = 120
    earth_ring = [
        [round(math.cos(2 * math.pi * j / n_ring), 5),
         round(math.sin(2 * math.pi * j / n_ring), 5)]
        for j in range(n_ring + 1)
    ]
    target_ring = [
        [round(r2_au * math.cos(2 * math.pi * j / n_ring), 5),
         round(r2_au * math.sin(2 * math.pi * j / n_ring), 5)]
        for j in range(n_ring + 1)
    ]

    return {
        "mode": "solar_system",
        "units": "AU (1 AU = 149,597,870.7 km)",
        "central_body": {
            "label": "Sun", "pos": [0.0, 0.0],
            "color": "#ffd700", "display_radius": 0.06,
        },
        "origin_body": {
            "label": "Earth", "pos": [1.0, 0.0],
            "color": "#4a90d9", "display_radius": 0.025,
        },
        "target_body": {
            "label": scenario["target_body"],
            "pos": [round(target_x, 4), 0.0],
            "color": _planet_color(scenario["target_body"]),
            "display_radius": _planet_display_radius(scenario["target_body"]),
        },
        "earth_orbit_ring": earth_ring,
        "target_orbit_ring": target_ring,
        "transfer_ellipse_points": points,
        "burn_nodes": burn_nodes,
        "semi_major_axis_au": round(a_t / AU_M, 4),
        "eccentricity": round(e_t, 4),
        "transfer_time_days": round(T_half / 86400.0, 1),
        "dv_injection_heliocentric_ms": round(dv_injection, 1),
        "dv_capture_heliocentric_ms": round(dv_capture, 1),
    }


def _planet_color(target_body: str) -> str:
    colors = {
        "Moon": "#c8c8c8",
        "Mars": "#c1440e",
        "Venus": "#e8c97a",
        "Jupiter (Europa)": "#c88b3a",
        "Saturn (Titan)": "#d4b483",
    }
    for key, val in colors.items():
        if key in target_body:
            return val
    return "#aaaaaa"


def _planet_display_radius(target_body: str) -> float:
    radii = {
        "Moon": 0.015,
        "Mars": 0.022,
        "Venus": 0.024,
        "Jupiter": 0.045,
        "Saturn": 0.040,
    }
    for key, val in radii.items():
        if key in target_body:
            return val
    return 0.02


def compute_trajectory_data(scenario: dict, completion_fraction: float) -> dict:
    """Generate trajectory data dict for the 2D orbital canvas."""
    view_mode = scenario.get("view_mode", "solar_system")
    if view_mode == "earth_moon":
        data = _earth_moon_trajectory(scenario)
    else:
        data = _solar_system_trajectory(scenario)

    data["completion_fraction"] = round(max(0.0, min(1.0, completion_fraction)), 4)
    return data


# ---------------------------------------------------------------------------
# 3. Power Balance (Inverse-Square Solar Irradiance + RTG constant)
# ---------------------------------------------------------------------------
def compute_power_balance(
    power_sys: dict,
    comms_sys: dict,
    instruments: list,
    r_au: float,
) -> tuple[float, float]:
    """
    Compute (available_power_w, required_power_w).

    Solar panels: P_avail = P_1AU / r²       (inverse-square law)
    RTG/Nuclear:  P_avail = P_1AU             (independent of solar distance)
    """
    if power_sys["type"] == "solar":
        available = power_sys["base_power_w_1au"] / (r_au ** 2)
    else:
        # Nuclear (MMRTG) — constant regardless of solar distance
        available = float(power_sys["base_power_w_1au"])

    required = (
        BASE_BUS_POWER_W
        + comms_sys["power_draw_w"]
        + sum(inst["power_w"] for inst in instruments)
    )
    return round(available, 1), round(required, 1)


# ---------------------------------------------------------------------------
# 4. DSN Link Budget — Data Downlink Capacity vs. Generated Volume
# ---------------------------------------------------------------------------
def compute_link_budget(
    comms_sys: dict, instruments: list, r_au: float, scenario: dict
) -> tuple[float, float, float, str | None]:
    """
    Compute (data_generated_gb, capacity_gb, transmission_ratio, warning_msg).

    Deep Space Network throughput degrades with distance. The comms_sys
    max_data_gb_day is specified at a reference distance; we apply a simple
    inverse-square range penalty scaled relative to 1 AU.

    effective_capacity = capacity_1au / r²   (for solar_system mode)
    For Earth-Moon mode the range penalty is negligible (~0.003 AU).
    """
    view_mode = scenario.get("view_mode", "solar_system")
    raw_capacity = comms_sys["max_data_gb_day"]

    if view_mode == "solar_system":
        # Apply inverse-square link margin loss (approximation of free-space path loss)
        effective_capacity = raw_capacity / (r_au ** 2)
    else:
        # Lunar: ~1 AU distance from DSN ground stations — negligible link margin loss
        effective_capacity = raw_capacity

    generated = sum(inst["data_gb_day"] for inst in instruments)

    if generated == 0:
        ratio = 1.0
        warning = None
    else:
        ratio = min(1.0, effective_capacity / generated)
        if ratio < 1.0:
            lost_pct = round((1.0 - ratio) * 100)
            warning = (
                f"📡 DSN COMMS BOTTLENECK: Antenna downlink effective capacity "
                f"{effective_capacity:.1f} GB/day at {r_au} AU is insufficient for "
                f"{generated:.1f} GB/day instrument output. "
                f"{lost_pct}% of science data is LOST. "
                f"Upgrade to a higher-gain antenna or reduce high-data instruments."
            )
        else:
            warning = None

    return (
        round(generated, 2),
        round(effective_capacity, 2),
        round(ratio, 4),
        warning,
    )


# ---------------------------------------------------------------------------
# 5. Composite Score & Letter Rank
# ---------------------------------------------------------------------------
def compute_score(
    mission_go: bool,
    effective_science_pts: float,
    total_cost_m: float,
    budget_cap_m: float,
    dv_margin_ms: float,
    available_power_w: float,
    required_power_w: float,
    failures: list,
) -> tuple[int, str]:
    """
    Compute composite mission score (0–1000) and letter grade.

    Weights:
      Science Return   = 500 pts (capped)
      Budget Efficiency= 300 pts (fractional savings × 300)
      Safety Margin    = 200 pts (ΔV margin + power margin combined)

    Grade thresholds: S≥900, A≥750, B≥550, C≥300, F<300
    """
    if not mission_go:
        # Partial credit for near-misses but hard floor of 0
        score = 0
        for f in failures:
            # Award partial credit for single-failure scenarios
            if len(failures) == 1:
                score = max(0, min(100, int(effective_science_pts * 0.1)))
        return max(0, score), "F"

    # Science contribution (500 pts max)
    science_score = min(SCORE_SCIENCE_MAX, int(effective_science_pts * 0.6))

    # Budget efficiency: (money_saved / budget) × 300
    savings_fraction = max(0.0, (budget_cap_m - total_cost_m) / budget_cap_m)
    budget_score = int(savings_fraction * SCORE_BUDGET_MAX)

    # Safety margin: ΔV + power contributions, 200 pts max
    # ΔV margin contribution (150 pts, saturates at 3000 m/s surplus)
    dv_score = min(150, int((max(0.0, dv_margin_ms) / 3000.0) * 150))
    # Power margin contribution (50 pts)
    power_surplus_pct = max(0.0, (available_power_w - required_power_w) / required_power_w)
    power_score = min(50, int(power_surplus_pct * 50))

    total = science_score + budget_score + dv_score + power_score

    if total >= 900:
        grade = "S"
    elif total >= 750:
        grade = "A"
    elif total >= 550:
        grade = "B"
    elif total >= 300:
        grade = "C"
    else:
        grade = "F"

    return min(1000, total), grade


# ---------------------------------------------------------------------------
# 6. Main Evaluation Entry Point
# ---------------------------------------------------------------------------
def evaluate_mission(
    catalog: dict,
    scenario_key: str,
    rocket_key: str,
    power_key: str,
    comms_key: str,
    selected_inst_keys: list,
    sandbox_mode: bool = False,
) -> dict:
    """
    Full mission simulation. Returns a comprehensive result dict consumed by
    the FastAPI endpoint and the frontend telemetry panel + 2D canvas.
    """
    scenario = catalog["scenarios"][scenario_key]
    rocket = catalog["rockets"][rocket_key]
    power_sys = catalog["power_systems"][power_key]
    comms_sys = catalog["comms_systems"][comms_key]
    instruments = [catalog["instruments"][k] for k in selected_inst_keys if k in catalog["instruments"]]

    # --- Spacecraft Mass Budget ---
    inst_mass_kg = sum(inst["mass_kg"] for inst in instruments)
    total_payload_mass_kg = (
        BASE_BUS_MASS_KG
        + power_sys["mass_kg"]
        + comms_sys["mass_kg"]
        + inst_mass_kg
    )

    # --- Cost Budget ---
    inst_cost_m = sum(inst["cost_m"] for inst in instruments)
    total_cost_m = (
        rocket["cost_m"]
        + BASE_BUS_COST_M
        + power_sys["cost_m"]
        + comms_sys["cost_m"]
        + inst_cost_m
    )

    # --- Multi-Stage ΔV ---
    available_dv_ms, stage_breakdown = calculate_multistage_dv(
        rocket["stages"], total_payload_mass_kg
    )
    required_dv_ms = scenario["required_dv_ms"]
    dv_margin_ms = round(available_dv_ms - required_dv_ms, 1)
    completion_fraction = round(min(1.0, available_dv_ms / max(1, required_dv_ms)), 4)

    # --- Solar Power Balance ---
    r_au = scenario["solar_distance_au"]
    available_power_w, required_power_w = compute_power_balance(
        power_sys, comms_sys, instruments, r_au
    )
    power_margin_w = round(available_power_w - required_power_w, 1)

    # --- DSN Link Budget ---
    data_generated_gb, comms_capacity_gb, data_ratio, comms_warning = compute_link_budget(
        comms_sys, instruments, r_au, scenario
    )

    # --- Science Return ---
    raw_science_pts = sum(inst["science_pts"] for inst in instruments)
    effective_science_pts = round(raw_science_pts * data_ratio, 1)

    # --- Failure & Warning Diagnostics ---
    failures = []
    warnings = []

    # STRUCTURAL OVERLOAD
    if total_payload_mass_kg > rocket["max_leo_payload_kg"]:
        overmass = round(total_payload_mass_kg - rocket["max_leo_payload_kg"], 1)
        failures.append(
            f"🚨 STRUCTURAL OVERLOAD: Spacecraft payload mass "
            f"({total_payload_mass_kg:.0f} kg) exceeds {rocket['name']} "
            f"fairing payload limit ({rocket['max_leo_payload_kg']:,} kg) by "
            f"{overmass:.0f} kg. Remove heavy instruments or upgrade launch vehicle."
        )

    # PROPELLANT EXHAUSTION
    if dv_margin_ms < 0:
        failures.append(
            f"🚨 PROPELLANT EXHAUSTION: Available effective ΔV ({available_dv_ms:.0f} m/s) "
            f"falls short of mission requirement ({required_dv_ms:,} m/s) by "
            f"{abs(dv_margin_ms):.0f} m/s. Spacecraft halts at "
            f"{completion_fraction * 100:.1f}% of trajectory. "
            f"Select a higher-performance launch vehicle."
        )

    # SOLAR INVERSE-SQUARE BLACKOUT
    if available_power_w < required_power_w:
        failures.append(
            f"🚨 SOLAR POWER BLACKOUT: At {r_au} AU, solar irradiance is "
            f"{1.0 / (r_au ** 2):.3f}× Earth-baseline. "
            f"Power generated: {available_power_w:.0f} W, required: {required_power_w:.0f} W "
            f"(deficit: {abs(power_margin_w):.0f} W). "
            f"Switch to Multi-Mission RTG (nuclear) or reduce power-hungry instruments."
        )

    if not sandbox_mode:
        # GRANT BUDGET OVERRUN
        if total_cost_m > scenario["budget_cap_m"]:
            overrun = round(total_cost_m - scenario["budget_cap_m"], 1)
            failures.append(
                f"🚨 BUDGET OVERRUN: Total mission cost ${total_cost_m:.0f}M exceeds "
                f"NASA/ESA grant cap of ${scenario['budget_cap_m']}M by ${overrun}M. "
                f"Remove instruments, downgrade antenna, or choose a cheaper launcher."
            )

        # MISSING MANDATORY SCIENCE INSTRUMENT
        missing_instruments = [
            catalog["instruments"][key]["name"]
            for key in scenario["required_instruments"]
            if key not in selected_inst_keys
        ]
        if missing_instruments:
            failures.append(
                f"🚨 MISSING MANDATORY PAYLOAD: Mission objective '{scenario['name']}' "
                f"requires: {', '.join(missing_instruments)}. "
                f"These instruments are scientifically non-negotiable for this objective."
            )

        # INSUFFICIENT SCIENCE RETURN
        if effective_science_pts < scenario["min_science_points"]:
            failures.append(
                f"🚨 INSUFFICIENT SCIENCE RETURN: Effective science yield "
                f"({effective_science_pts:.0f} pts) is below the minimum mission threshold "
                f"({scenario['min_science_points']} pts). "
                f"Add more science instruments and/or upgrade comms antenna."
            )

    # Comms bottleneck is a warning, not necessarily a failure
    if comms_warning:
        warnings.append(comms_warning)

    # Low ΔV margin advisory
    if 0 <= dv_margin_ms < 500:
        warnings.append(
            f"⚠ LOW ΔV MARGIN: Only {dv_margin_ms:.0f} m/s reserve above requirement. "
            f"Mid-course correction burns may leave insufficient propellant for contingency maneuvers."
        )

    # Power margin advisory
    if 0 <= power_margin_w < 50:
        warnings.append(
            f"⚠ TIGHT POWER BUDGET: Only {power_margin_w:.0f} W power surplus. "
            f"Any instrument anomaly or solar panel degradation may cause brownout."
        )

    # TWR warnings from stage breakdown
    for stage in stage_breakdown:
        if stage.get("twr_warning"):
            warnings.append(stage["twr_warning"])

    mission_go = len(failures) == 0

    # --- Score & Grade ---
    score, grade = compute_score(
        mission_go, effective_science_pts, total_cost_m,
        scenario["budget_cap_m"], dv_margin_ms,
        available_power_w, required_power_w, failures,
    )

    # --- 2D Trajectory Data ---
    trajectory_data = compute_trajectory_data(scenario, completion_fraction)

    # Compute per-burn-node ΔV budget from scenario
    burn_budget = scenario.get("burn_budget", {})

    return {
        # Mission status
        "mission_go": mission_go,
        "score": score,
        "grade": grade,

        # Mass budget
        "total_payload_mass_kg": round(total_payload_mass_kg, 1),
        "max_leo_payload_kg": rocket["max_leo_payload_kg"],
        "mass_breakdown": {
            "bus_kg": BASE_BUS_MASS_KG,
            "power_kg": power_sys["mass_kg"],
            "comms_kg": comms_sys["mass_kg"],
            "instruments_kg": round(inst_mass_kg, 1),
        },

        # Cost budget
        "total_cost_m": round(total_cost_m, 1),
        "budget_cap_m": scenario["budget_cap_m"],
        "cost_breakdown": {
            "rocket_m": rocket["cost_m"],
            "bus_m": BASE_BUS_COST_M,
            "power_m": power_sys["cost_m"],
            "comms_m": comms_sys["cost_m"],
            "instruments_m": round(inst_cost_m, 1),
        },

        # ΔV budget
        "available_dv_ms": available_dv_ms,
        "required_dv_ms": required_dv_ms,
        "dv_margin_ms": dv_margin_ms,
        "completion_fraction": completion_fraction,
        "stage_breakdown": stage_breakdown,
        "burn_budget": burn_budget,

        # Power balance
        "available_power_w": available_power_w,
        "required_power_w": required_power_w,
        "power_margin_w": power_margin_w,
        "solar_irradiance_factor": round(1.0 / (r_au ** 2), 4),
        "power_system_type": power_sys["type"],

        # Comms & data
        "data_generated_gb_day": data_generated_gb,
        "comms_capacity_gb_day": comms_capacity_gb,
        "data_transmission_ratio": data_ratio,

        # Science
        "raw_science_pts": raw_science_pts,
        "effective_science_pts": effective_science_pts,
        "min_science_pts": scenario["min_science_points"],

        # Transfer parameters
        "transfer_time_days": scenario.get("transfer_time_days", 0),
        "semi_major_axis_au": scenario.get("semi_major_axis_au", 1.0),
        "eccentricity": scenario.get("eccentricity", 0.0),
        "solar_distance_au": r_au,

        # Diagnostics
        "failures": failures,
        "warnings": warnings,

        # 2D Canvas Data
        "trajectory_data": trajectory_data,

        # Scenario metadata for UI
        "scenario_name": scenario["name"],
        "scenario_regime": scenario["regime"],
        "scenario_target": scenario["target_body"],
        "rocket_name": rocket["name"],
    }