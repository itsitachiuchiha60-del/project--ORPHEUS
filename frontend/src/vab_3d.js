/**
 * vab_3d.js — O2S: Mission Architect
 *
 * Three.js r128 WebGL Vehicle Assembly Building (VAB) Inspector
 *
 * Features:
 *  - GLTFLoader with auto-normalize: Box3 → scale to height 14, bottom-center at y=-5
 *  - PBR metallic lighting (3-point studio + environment)
 *  - Starfield + launchpad grid ground plane
 *  - 4 camera presets: Full Stack / Upper Stage / Engine Bay / Auto-Rotate
 *  - Procedural multi-stage fallback rocket when .glb is unavailable
 */

const VAB = (() => {
    'use strict';

    // -----------------------------------------------------------------------
    // Scene state
    // -----------------------------------------------------------------------
    let renderer, scene, camera, controls;
    let currentModel = null;
    let autoRotate = false;
    let animationId = null;
    let isInitialized = false;

    const NORMALIZED_HEIGHT = 14;   // scene units for any rocket model
    const BASE_Y = -5;              // y-position of rocket bottom-center

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------
    function init(containerId) {
        const container = document.getElementById(containerId);
        if (!container || isInitialized) return;
        isInitialized = true;

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        container.appendChild(renderer.domElement);

        // Scene
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x04080f);
        scene.fog = new THREE.FogExp2(0x04080f, 0.018);

        // Camera
        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
        camera.position.set(0, 5, 22);

        // Orbit Controls
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.07;
        controls.minDistance = 5;
        controls.maxDistance = 80;
        controls.target.set(0, 2, 0);
        controls.update();

        // Lighting
        _setupLighting();

        // Environment
        _buildStarfield();
        _buildLaunchpad();

        // Camera preset buttons
        document.querySelectorAll('.cam-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                setPreset(btn.dataset.preset);
            });
        });

        // Resize observer
        const ro = new ResizeObserver(() => _resize());
        ro.observe(container);
        _resize();

        // Start render loop
        _animate();
    }

    // -----------------------------------------------------------------------
    // 3-Point PBR Lighting
    // -----------------------------------------------------------------------
    function _setupLighting() {
        // Key light — warm directional (sun-like)
        const keyLight = new THREE.DirectionalLight(0xfff4e0, 1.8);
        keyLight.position.set(8, 20, 10);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 2048;
        keyLight.shadow.mapSize.height = 2048;
        keyLight.shadow.camera.near = 0.1;
        keyLight.shadow.camera.far = 100;
        keyLight.shadow.camera.left = -20;
        keyLight.shadow.camera.right = 20;
        keyLight.shadow.camera.top = 30;
        keyLight.shadow.camera.bottom = -10;
        scene.add(keyLight);

        // Fill light — cool blue rim
        const fillLight = new THREE.DirectionalLight(0x4488cc, 0.9);
        fillLight.position.set(-10, 5, -8);
        scene.add(fillLight);

        // Back rim light
        const rimLight = new THREE.DirectionalLight(0x88aaff, 0.5);
        rimLight.position.set(0, 15, -15);
        scene.add(rimLight);

        // Ambient — dark space
        const ambient = new THREE.AmbientLight(0x112244, 0.6);
        scene.add(ambient);

        // Ground bounce light
        const bounce = new THREE.PointLight(0x224466, 0.4, 30);
        bounce.position.set(0, -4, 0);
        scene.add(bounce);
    }

    // -----------------------------------------------------------------------
    // Environment: Starfield
    // -----------------------------------------------------------------------
    function _buildStarfield() {
        const count = 2500;
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);

        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(Math.random() * 2 - 1);
            const r = 200 + Math.random() * 100;

            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);

            // Slight color variation (blue-white spectrum)
            const t = Math.random();
            colors[i * 3] = 0.7 + t * 0.3;
            colors[i * 3 + 1] = 0.7 + t * 0.3;
            colors[i * 3 + 2] = 0.85 + t * 0.15;
        }

        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const mat = new THREE.PointsMaterial({
            size: 0.4,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.9,
        });

        scene.add(new THREE.Points(geo, mat));
    }

    // -----------------------------------------------------------------------
    // Environment: Launchpad grid + pedestal
    // -----------------------------------------------------------------------
    function _buildLaunchpad() {
        // Infinite grid
        const gridHelper = new THREE.GridHelper(80, 40, 0x1e3a5f, 0x0d1f3c);
        gridHelper.position.y = BASE_Y - 0.01;
        scene.add(gridHelper);

        // Launchpad platform
        const padGeo = new THREE.BoxGeometry(6, 0.3, 6);
        const padMat = new THREE.MeshStandardMaterial({
            color: 0x1a2a3a,
            roughness: 0.8,
            metalness: 0.3,
        });
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.position.y = BASE_Y - 0.15;
        pad.receiveShadow = true;
        scene.add(pad);

        // Flame trench hint lines
        const trenchMat = new THREE.LineBasicMaterial({ color: 0x2a4060 });
        [-3, 3].forEach(x => {
            const pts = [
                new THREE.Vector3(x, BASE_Y, -6),
                new THREE.Vector3(x, BASE_Y, 6),
            ];
            scene.add(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts),
                trenchMat
            ));
        });
    }

    // -----------------------------------------------------------------------
    // Model Loading & Auto-Normalization
    // -----------------------------------------------------------------------
    function loadModel(glbUrl, rocketName) {
        const label = document.getElementById('vab-model-name');
        if (label) label.textContent = `Loading ${rocketName}…`;

        // Remove previous model
        if (currentModel) {
            scene.remove(currentModel);
            currentModel = null;
        }

        const loader = new THREE.GLTFLoader();
        loader.load(
            glbUrl,
            (gltf) => {
                const model = gltf.scene;

                // --- Auto-Normalize: Box3 bounding box ---
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());

                // Scale to NORMALIZED_HEIGHT
                const modelHeight = size.y;
                if (modelHeight > 0) {
                    const scale = NORMALIZED_HEIGHT / modelHeight;
                    model.scale.setScalar(scale);
                }

                // Re-compute bounding box after scaling
                const box2 = new THREE.Box3().setFromObject(model);
                const bottom = box2.min.y;
                const centerXZ = box2.getCenter(new THREE.Vector3());

                // Translate: bottom-center to (0, BASE_Y, 0)
                model.position.set(
                    -centerXZ.x,
                    BASE_Y - bottom,
                    -centerXZ.z
                );

                // Enable shadows on all meshes
                model.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        // Enhance existing materials
                        if (child.material) {
                            const mats = Array.isArray(child.material) ? child.material : [child.material];
                            mats.forEach(mat => {
                                if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
                                    mat.envMapIntensity = 0.8;
                                }
                            });
                        }
                    }
                });

                currentModel = model;
                scene.add(model);

                if (label) label.textContent = rocketName;

                // Reset camera to full-stack view
                setPreset('full');
            },
            undefined,
            (error) => {
                console.warn(`[VAB] GLTFLoader failed for ${glbUrl}:`, error);
                _buildProceduralRocket(rocketName);
                if (label) label.textContent = `${rocketName} (Procedural)`;
            }
        );
    }

    // -----------------------------------------------------------------------
    // Procedural Fallback: Multi-stage rocket mesh
    // -----------------------------------------------------------------------
    function _buildProceduralRocket(name) {
        if (currentModel) {
            scene.remove(currentModel);
            currentModel = null;
        }

        const group = new THREE.Group();

        // Materials
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd0d8e0, metalness: 0.6, roughness: 0.3 });
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a2a3a, metalness: 0.8, roughness: 0.2 });
        const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.9, roughness: 0.15 });
        const accentMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.3, roughness: 0.5 });
        const faringMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.5 });

        // Helper to add mesh to group with shadow
        const addMesh = (geo, mat, x = 0, y = 0, z = 0, rx = 0) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z);
            m.rotation.x = rx;
            m.castShadow = true;
            m.receiveShadow = true;
            group.add(m);
            return m;
        };

        // Stage 1 booster
        addMesh(new THREE.CylinderGeometry(0.65, 0.75, 6, 16), bodyMat, 0, 0, 0);
        // Stage 1 ring detail
        addMesh(new THREE.TorusGeometry(0.70, 0.04, 8, 32), darkMat, 0, 0.8, 0, Math.PI / 2);
        addMesh(new THREE.TorusGeometry(0.70, 0.04, 8, 32), darkMat, 0, -0.8, 0, Math.PI / 2);

        // Engine cluster nozzles (3×3 ring)
        const nozzlePositions = [
            [0, 0], [0.4, 0], [-0.4, 0],
            [0, 0.4], [0, -0.4],
            [0.28, 0.28], [-0.28, 0.28], [0.28, -0.28], [-0.28, -0.28],
        ];
        nozzlePositions.forEach(([nx, nz]) => {
            addMesh(new THREE.ConeGeometry(0.09, 0.3, 8), nozzleMat, nx, -3.1, nz, Math.PI);
        });

        // 4× strap-on boosters
        [[-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9]].forEach(([bx, bz]) => {
            addMesh(new THREE.CylinderGeometry(0.22, 0.26, 4.5, 10), bodyMat, bx, -0.5, bz);
            addMesh(new THREE.ConeGeometry(0.22, 0.6, 10), bodyMat, bx, 1.85, bz);
            addMesh(new THREE.ConeGeometry(0.08, 0.2, 8), nozzleMat, bx, -2.8, bz, Math.PI);
        });

        // Interstage
        addMesh(new THREE.CylinderGeometry(0.65, 0.65, 0.3, 16), darkMat, 0, 3.15, 0);

        // Stage 2
        addMesh(new THREE.CylinderGeometry(0.55, 0.65, 3.5, 16), bodyMat, 0, 5.1, 0);
        addMesh(new THREE.TorusGeometry(0.60, 0.04, 8, 32), accentMat, 0, 5.5, 0, Math.PI / 2);
        // Stage 2 nozzle
        addMesh(new THREE.ConeGeometry(0.22, 0.4, 12), nozzleMat, 0, 3.4, 0, Math.PI);

        // Payload fairing
        addMesh(new THREE.CylinderGeometry(0.55, 0.55, 1.6, 16), faringMat, 0, 7.4, 0);
        addMesh(new THREE.ConeGeometry(0.55, 1.4, 16), faringMat, 0, 8.9, 0);

        // Logo accent lines
        for (let i = 0; i < 4; i++) {
            const angle = (i / 4) * Math.PI * 2;
            addMesh(
                new THREE.BoxGeometry(0.05, 5, 0.05),
                accentMat,
                Math.cos(angle) * 0.66,
                0,
                Math.sin(angle) * 0.66
            );
        }

        // Position group so bottom is at BASE_Y
        const box = new THREE.Box3().setFromObject(group);
        group.position.y = BASE_Y - box.min.y;

        // Scale to NORMALIZED_HEIGHT
        const height = box.max.y - box.min.y;
        if (height > 0) {
            const scale = NORMALIZED_HEIGHT / height;
            group.scale.setScalar(scale);
            group.position.y = BASE_Y - box.min.y * scale;
        }

        currentModel = group;
        scene.add(group);
        setPreset('full');
    }

    // -----------------------------------------------------------------------
    // Camera Presets
    // -----------------------------------------------------------------------
    function setPreset(preset) {
        autoRotate = false;
        controls.autoRotate = false;

        switch (preset) {
            case 'full':
                // Full rocket in frame
                _animateCamera(
                    { x: 0, y: 5, z: 22 },
                    { x: 0, y: 2, z: 0 },
                    1.0
                );
                break;
            case 'upper':
                // Upper stage close-up
                _animateCamera(
                    { x: 4, y: 10, z: 10 },
                    { x: 0, y: 8, z: 0 },
                    0.8
                );
                break;
            case 'engine':
                // Engine bay / nozzle cluster
                _animateCamera(
                    { x: 3, y: -3, z: 7 },
                    { x: 0, y: -4, z: 0 },
                    0.6
                );
                break;
            case 'auto':
                // Auto-rotate mode
                _animateCamera(
                    { x: 0, y: 4, z: 20 },
                    { x: 0, y: 2, z: 0 },
                    0.8
                );
                setTimeout(() => {
                    autoRotate = true;
                    controls.autoRotate = true;
                    controls.autoRotateSpeed = 1.2;
                }, 900);
                break;
        }
    }

    // Smooth camera animation using lerp
    function _animateCamera(targetPos, targetLook, duration) {
        const startPos = camera.position.clone();
        const startTarget = controls.target.clone();
        const endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
        const endTarget = new THREE.Vector3(targetLook.x, targetLook.y, targetLook.z);
        const startTime = performance.now();
        const dur = (duration || 1.0) * 1000;

        function step() {
            const t = Math.min(1, (performance.now() - startTime) / dur);
            const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
            camera.position.lerpVectors(startPos, endPos, ease);
            controls.target.lerpVectors(startTarget, endTarget, ease);
            controls.update();
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // -----------------------------------------------------------------------
    // Resize Handler
    // -----------------------------------------------------------------------
    function _resize() {
        const container = renderer.domElement.parentElement;
        if (!container) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    // -----------------------------------------------------------------------
    // Render Loop
    // -----------------------------------------------------------------------
    function _animate() {
        animationId = requestAnimationFrame(_animate);
        controls.update();

        // Subtle model rotation when not in auto-rotate mode
        if (currentModel && !autoRotate) {
            // gentle bob
            currentModel.rotation.y += 0.0003;
        }

        renderer.render(scene, camera);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return { init, loadModel, setPreset };
})();

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    VAB.init('webgl-container');
});

// Export for app.js
window.VAB = VAB;