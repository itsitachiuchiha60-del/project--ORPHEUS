"""
backend/main.py — O2S: Mission Architect FastAPI Server

Endpoints:
  GET  /api/catalog        — Full aerospace database (scenarios, rockets, etc.)
  POST /api/simulate       — Physics simulation + 2D trajectory data
  GET  /api/assets         — List of .glb model files available on disk

Static Mounts (ORDER IS CRITICAL):
  1. /3d assets  → "3d assets/" directory  (must be BEFORE frontend mount)
  2. /           → frontend/               (catch-all, must be LAST)
"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
import os
import glob

from backend.logic import evaluate_mission

app = FastAPI(
    title="O2S: Mission Architect API",
    description="NASA Space Apps 2026 — Aerospace Systems Simulation Engine",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Catalog loader (cached on each request; for production use lru_cache)
# ---------------------------------------------------------------------------
CATALOG_PATH = os.path.join(os.path.dirname(__file__), "data", "catalog.json")
ASSETS_DIR = "3d assets"


def load_catalog() -> dict:
    if not os.path.exists(CATALOG_PATH):
        raise HTTPException(status_code=500, detail="Catalog database not found.")
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------
class SimulationRequest(BaseModel):
    scenario_key: str
    rocket_key: str
    power_key: str
    comms_key: str
    instrument_keys: list[str]
    sandbox_mode: bool = False


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/catalog")
def get_catalog():
    """Return the complete aerospace database catalog."""
    return load_catalog()


@app.post("/api/simulate")
def run_simulation(req: SimulationRequest):
    """
    Run the full mission physics simulation.

    Returns telemetry, stage breakdown, power balance, link budget,
    scoring (0-1000 + grade), and 2D trajectory canvas data.
    """
    catalog = load_catalog()

    if req.scenario_key not in catalog["scenarios"]:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scenario key '{req.scenario_key}'. "
                   f"Valid keys: {list(catalog['scenarios'].keys())}",
        )
    if req.rocket_key not in catalog["rockets"]:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown rocket key '{req.rocket_key}'. "
                   f"Valid keys: {list(catalog['rockets'].keys())}",
        )
    if req.power_key not in catalog.get("power_systems", {}):
        raise HTTPException(status_code=400, detail=f"Unknown power system key '{req.power_key}'.")
    if req.comms_key not in catalog.get("comms_systems", {}):
        raise HTTPException(status_code=400, detail=f"Unknown comms system key '{req.comms_key}'.")

    result = evaluate_mission(
        catalog=catalog,
        scenario_key=req.scenario_key,
        rocket_key=req.rocket_key,
        power_key=req.power_key,
        comms_key=req.comms_key,
        selected_inst_keys=req.instrument_keys,
        sandbox_mode=req.sandbox_mode,
    )
    return result


@app.get("/api/assets")
def list_3d_assets():
    """
    Return a list of all .glb model files available in the '3d assets' directory.
    Used by the frontend to verify model availability before attempting GLTFLoader.
    """
    if not os.path.exists(ASSETS_DIR):
        return {"glb_files": [], "count": 0}

    glb_files = [
        os.path.basename(f)
        for f in glob.glob(os.path.join(ASSETS_DIR, "*.glb"))
    ]
    return {
        "glb_files": sorted(glb_files),
        "count": len(glb_files),
        "base_url": "/3d assets/",
    }


# ---------------------------------------------------------------------------
# Static File Mounts — ORDER IS CRITICAL
# ---------------------------------------------------------------------------

# 1. Mount 3D assets FIRST so /3d%20assets/*.glb requests resolve correctly
if os.path.exists(ASSETS_DIR):
    app.mount(
        "/3d assets",
        StaticFiles(directory=ASSETS_DIR),
        name="assets_3d",
    )

# 2. Mount frontend LAST — catch-all HTML5 history mode
app.mount(
    "/",
    StaticFiles(directory="frontend", html=True),
    name="frontend",
)