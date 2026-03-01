const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const { NodeIO } = require('@gltf-transform/core');

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// OpenRouter API configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const VISION_MODEL = 'gemini-2.5-flash';
const SKETCHFAB_API_TOKEN = process.env.SKETCHFAB_API_TOKEN;
const MODELS_DIR = path.join(__dirname, 'public', 'models');

// ==========================================
// SQLite Database Setup
// ==========================================
const db = new Database(path.join(__dirname, 'models.db'));
db.pragma('journal_mode = WAL');

// Migrate: add new columns if they don't exist
try { db.exec('ALTER TABLE visuals ADD COLUMN glb_path TEXT'); } catch (e) { /* column exists */ }
try { db.exec('ALTER TABLE visuals ADD COLUMN source TEXT DEFAULT "ai"'); } catch (e) { /* column exists */ }

db.exec(`
    CREATE TABLE IF NOT EXISTS visuals (
        topic TEXT PRIMARY KEY,
        model_type TEXT NOT NULL,
        data TEXT NOT NULL,
        image_url TEXT,
        glb_path TEXT,
        source TEXT DEFAULT 'ai',
        created_at INTEGER DEFAULT (unixepoch())
    )
`);
console.log('📦 SQLite database ready (models.db)');

// Ensure models directory exists
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

// Prepared statements
const getVisual = db.prepare('SELECT data, glb_path, source FROM visuals WHERE topic = ?');
const insertVisual = db.prepare('INSERT OR REPLACE INTO visuals (topic, model_type, data, image_url, glb_path, source) VALUES (?, ?, ?, ?, ?, ?)');

// ==========================================
// Wikimedia Commons Image Fetcher
// ==========================================
async function fetchReferenceImage(topic) {
    try {
        const searchTerm = topic.replace(/-/g, ' ');
        const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(searchTerm + ' anatomy diagram')}&gsrlimit=5&prop=imageinfo&iiprop=url|mime&iiurlwidth=800&format=json&origin=*`;

        const res = await fetch(url);
        const data = await res.json();

        if (!data.query || !data.query.pages) return null;

        // Find the first actual image (not SVG, prefer jpg/png)
        const pages = Object.values(data.query.pages);
        for (const page of pages) {
            if (page.imageinfo && page.imageinfo[0]) {
                const info = page.imageinfo[0];
                const mime = info.mime || '';
                if (mime.startsWith('image/') && !mime.includes('svg') && info.thumburl) {
                    console.log(`🖼️  Found reference image for "${topic}": ${info.thumburl}`);
                    return info.thumburl;
                }
            }
        }

        // Fallback: try without 'anatomy diagram'
        const url2 = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(searchTerm)}&gsrlimit=5&prop=imageinfo&iiprop=url|mime&iiurlwidth=800&format=json&origin=*`;
        const res2 = await fetch(url2);
        const data2 = await res2.json();

        if (!data2.query || !data2.query.pages) return null;

        const pages2 = Object.values(data2.query.pages);
        for (const page of pages2) {
            if (page.imageinfo && page.imageinfo[0]) {
                const info = page.imageinfo[0];
                const mime = info.mime || '';
                if (mime.startsWith('image/') && !mime.includes('svg') && info.thumburl) {
                    console.log(`🖼️  Found reference image for "${topic}": ${info.thumburl}`);
                    return info.thumburl;
                }
            }
        }

        console.log(`⚠️  No reference image found for "${topic}"`);
        return null;
    } catch (err) {
        console.error('Image fetch error:', err.message);
        return null;
    }
}

// System instruction for the main chat model
const SYSTEM_INSTRUCTION = `You are Imagion, a friendly AI tutor for students in grades 6-12. Your goal is one thing — genuine understanding. Not memorisation, not information dumping. Real understanding.
You always teach alongside a visual that the student is looking at on their screen. Use that visual as your anchor — reference it naturally in your explanation, the way a good teacher would point at a whiteboard while explaining.
How you respond depends entirely on what the student needs:

For simple questions or specific doubts, answer concisely in 2-3 sentences. Do not pad it out.
For complex topics that genuinely require depth, take the space you need. But break it into small digestible chunks — short paragraphs, never walls of text.
For follow up questions, match the depth of the question. A one line question usually needs a one paragraph answer.

Your tone is always warm, direct and encouraging — like a smart older friend explaining something, not a teacher lecturing. Use simple language. Use analogies that a student can relate to. If a concept has a real world equivalent they would know, use it.
Never use formal headers like ### or dividers like ---. Never write in a way that feels like a textbook or a Wikipedia article. Always write like you are speaking directly to the student.
Most importantly — after explaining something, ask one question that makes the student think deeper or want to explore the visual more. Not a quiz question. A genuine curiosity question. The kind that makes them go "hm, I never thought about that."
A visual is currently displayed to the student showing [topic]. Reference it naturally — say things like "notice how" or "look at the" or "see how the arrows show." Make the visual feel essential to understanding, not decorative.`;

// Helper: Call Google Gemini API
const { GoogleGenerativeAI } = require('@google/generative-ai');
const API_KEY = process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);

async function callGemini(messages, modelId = 'gemini-2.5-flash', maxTokens = 8192) {
    let systemInstruction = '';
    const history = [];
    let latestMessage = '';

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction += msg.content + '\n';
        } else if (msg.role === 'user' || msg.role === 'assistant') {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            if (Array.isArray(msg.content)) {
                const parts = [];
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        parts.push({ text: part.text });
                        latestMessage += part.text;
                    } else if (part.type === 'image_url') {
                        try {
                            const imgRes = await fetch(part.image_url.url);
                            const buffer = await imgRes.arrayBuffer();
                            parts.push({
                                inlineData: {
                                    data: Buffer.from(buffer).toString("base64"),
                                    mimeType: imgRes.headers.get("content-type") || "image/jpeg"
                                }
                            });
                        } catch (e) {
                            console.error("Failed to fetch image:", e);
                        }
                    }
                }
                history.push({ role, parts });
            } else {
                history.push({ role, parts: [{ text: msg.content }] });
                if (role === 'user') latestMessage = msg.content;
            }
        }
    }

    const modelOptions = {
        model: modelId.replace('google/', ''),
        generationConfig: { maxOutputTokens: maxTokens }
    };
    if (systemInstruction) modelOptions.systemInstruction = systemInstruction.trim();

    const model = genAI.getGenerativeModel(modelOptions);

    if (history.length > 1) {
        const lastMsg = history.pop();
        const chat = model.startChat({ history });
        const result = await chat.sendMessage(lastMsg.parts);
        return result.response.text();
    } else {
        const contentContext = history.length > 0 ? history[0].parts : [{ text: latestMessage }];
        const result = await model.generateContent(contentContext);
        return result.response.text();
    }
}

// Models Endpoint
app.get('/api/models', (req, res) => {
    res.json({
        models: [
            { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
        ],
        default: 'gemini-2.5-flash'
    });
});

// Removed Wikimedia diagram fetcher - routing to AI SVG generation only

// ==========================================
// Sketchfab API Helpers
// ==========================================
async function searchSketchfab(topic) {
    if (!SKETCHFAB_API_TOKEN) return null;

    try {
        const searchTerm = topic.replace(/-/g, ' ');

        // Search with more specific terms and fetch more results to filter
        const searches = [
            `${searchTerm} anatomy 3d model`,
            `${searchTerm} 3d model`,
            searchTerm
        ];

        for (const query of searches) {
            const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(query)}&downloadable=true&sort_by=-likeCount&count=20&max_face_count=50000`;

            const res = await fetch(url, {
                headers: { 'Authorization': `Token ${SKETCHFAB_API_TOKEN}` }
            });

            if (!res.ok) {
                console.error('Sketchfab search error:', res.status);
                continue;
            }

            const data = await res.json();
            if (!data.results || data.results.length === 0) continue;

            // Score each result for relevance to the specific topic
            const topicWords = searchTerm.toLowerCase().split(' ');
            const scored = data.results.map(model => {
                const name = (model.name || '').toLowerCase();
                const desc = (model.description || '').toLowerCase();
                let score = 0;

                // Strong bonus: model name contains the topic keyword
                topicWords.forEach(word => {
                    if (name.includes(word)) score += 50;
                    if (desc.includes(word)) score += 5;
                });

                // Penalty: generic full-body / multi-organ models
                const genericTerms = ['full body', 'skeleton', 'splanchnology', 'human body', 'whole body', 'full anatomy', 'muscular system', 'nervous system'];
                genericTerms.forEach(term => {
                    if (name.includes(term)) score -= 40;
                });

                // Bonus: educational / anatomy keywords in name
                if (name.includes('anatomy') || name.includes('medical')) score += 10;
                if (name.includes('realistic') || name.includes('detailed')) score += 5;

                // Small bonus for popularity
                score += Math.min(model.likeCount || 0, 20) * 0.5;

                return { model, score };
            });

            // Sort by score descending
            scored.sort((a, b) => b.score - a.score);

            // Pick the best match that has the topic in its name
            const best = scored[0];
            if (best && best.score > 10) {
                console.log(`🔍 Found Sketchfab model: "${best.model.name}" (score: ${best.score}, uid: ${best.model.uid}, likes: ${best.model.likeCount})`);
                return best.model;
            }
        }

        console.log(`⚠️  No relevant Sketchfab models found for "${topic}"`);
        return null;
    } catch (err) {
        console.error('Sketchfab search error:', err.message);
        return null;
    }
}

async function downloadSketchfabGLB(uid, topic) {
    try {
        const dlRes = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, {
            headers: { 'Authorization': `Token ${SKETCHFAB_API_TOKEN}` }
        });

        if (!dlRes.ok) {
            console.error('Sketchfab download error:', dlRes.status, await dlRes.text());
            return null;
        }

        const dlData = await dlRes.json();
        const downloadInfo = dlData.glb || dlData.gltf;
        if (!downloadInfo || !downloadInfo.url) {
            console.error('No download URL available');
            return null;
        }

        console.log(`⬇️  Downloading GLB for "${topic}"...`);

        const fileRes = await fetch(downloadInfo.url);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        const glbPath = path.join(MODELS_DIR, `${topic}.glb`);

        if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
            // It's a ZIP — extract GLB/GLTF
            const zip = new AdmZip(buffer);
            const entries = zip.getEntries();

            const glbEntry = entries.find(e => e.entryName.endsWith('.glb'));
            const gltfEntry = entries.find(e => e.entryName.endsWith('.gltf'));

            if (glbEntry) {
                fs.writeFileSync(glbPath, glbEntry.getData());
            } else if (gltfEntry) {
                const extractDir = path.join(MODELS_DIR, topic);
                zip.extractAllTo(extractDir, true);
                console.log(`✅ Extracted GLTF to ${extractDir}`);
                return `/models/${topic}/${gltfEntry.entryName}`;
            } else {
                console.error('No GLB or GLTF found in archive');
                return null;
            }
        } else {
            fs.writeFileSync(glbPath, buffer);
        }

        console.log(`✅ Saved GLB: ${glbPath}`);
        return `/models/${topic}.glb`;
    } catch (err) {
        console.error('GLB download error:', err.message);
        return null;
    }
}

// ==========================================
// GLB Mesh Name Extractor
// ==========================================
// ==========================================
// GLB Mesh Parsing with Headless Three.js
// ==========================================
// Setup headless DOM for Three.js GLTFLoader
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.XMLHttpRequest = dom.window.XMLHttpRequest;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.self = global; // Fix for "self is not defined" in GLTFLoader texture parsing
if (typeof URL.createObjectURL === 'undefined') {
    URL.createObjectURL = () => ''; // Mock to prevent texture blob crashes
    URL.revokeObjectURL = () => '';
}

const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

async function extractMeshData(glbFilePath) {
    return new Promise((resolve) => {
        // Enforce a strict 10 second timeout in case GLTFLoader hangs on Draco/KTX2 in headless Node
        const timeout = setTimeout(() => {
            console.warn('⚠️ GLB parse timed out. Model likely requires Draco/KTX2 decoding unavailable in Node.');
            resolve([]);
        }, 10000);

        try {
            const absolutePath = path.isAbsolute(glbFilePath) ? glbFilePath : path.join(__dirname, 'public', glbFilePath);
            const buffer = fs.readFileSync(absolutePath);
            const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

            const loader = new GLTFLoader();
            loader.parse(arrayBuffer, '', (gltf) => {
                clearTimeout(timeout);
                const scene = gltf.scene;

                // Emulate frontend auto-centering & scaling
                const box = new THREE.Box3().setFromObject(scene);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                const scale = 6 / maxDim;
                scene.scale.multiplyScalar(scale);
                scene.position.sub(center.multiplyScalar(scale));

                scene.updateMatrixWorld(true);

                const meshes = [];
                scene.traverse((child) => {
                    if (child.isMesh && child.name) {
                        child.geometry.computeBoundingBox();
                        const meshBox = child.geometry.boundingBox.clone();
                        meshBox.applyMatrix4(child.matrixWorld);

                        const meshCenter = new THREE.Vector3();
                        meshBox.getCenter(meshCenter);

                        // Skip tiny or internal helper meshes that clutter the labeling prompt
                        const meshSize = meshBox.getSize(new THREE.Vector3());
                        if (meshSize.length() > 0.05) { // Filter out meshes smaller than 0.05 units
                            meshes.push({
                                name: child.name || 'unnamed_part', // Use child.name, fallback to 'unnamed_part'
                                position: [
                                    parseFloat(meshCenter.x.toFixed(3)),
                                    parseFloat(meshCenter.y.toFixed(3)),
                                    parseFloat(meshCenter.z.toFixed(3))
                                ]
                            });
                        }
                    }
                });

                console.log(`🏷️  Extracted ${meshes.length} mesh bounding boxes from GLB`);
                resolve(meshes);
            }, (error) => {
                clearTimeout(timeout);
                console.error('GLB parse error in loader:', error);
                resolve([]);
            });
        } catch (err) {
            clearTimeout(timeout);
            console.error('GLB parse error:', err.message);
            resolve([]);
        }
    });
}

async function generateGLBAnnotations(topic, meshData) {
    const topicName = topic.replace(/-/g, ' ');

    // Filter out very tiny generic meshes or too many meshes to save context
    const validMeshes = meshData.filter(m =>
        !['sketchfab_model', 'rootnode', 'root', 'scene'].includes(m.name.toLowerCase()) &&
        !m.name.includes('.fbx') && !m.name.includes('.obj')
    ).slice(0, 30); // Max 30 meshes to avoid prompt bloat

    let prompt = "";
    if (validMeshes.length > 0) {
        prompt = `You are labeling a 3D model of "${topicName}" for grade 6-12 students.
The model contains the following meshes with positions [x, y, z]:
${JSON.stringify(validMeshes, null, 2)}

Create 6-10 annotations. Map labels to the EXACT [x, y, z] from the list.
Return JSON:
{
  "sections": [
    { "label": "Name", "position": [x, y, z], "short": "Summary", "detail": "Description" }
  ]
}`;
    } else {
        // FALLBACK: No meshes found, suggest general labels
        prompt = `I have a 3D model of "${topicName}" but could not extract specific mesh coordinates.
Suggest 6-8 critical labels for "${topicName}" with general relative positions.
Return JSON:
{
  "annotations": { "is_generic": true },
  "sections": [
    { "label": "Name", "position": [0,0,0], "short": "Summary", "detail": "Description" }
  ]
}
Rules: Use [0,0,0] for position as a fallback.`;
    }

    let responseText = await callGemini([
        { role: 'user', content: prompt }
    ], DEFAULT_MODEL, 8192);

    responseText = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    responseText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    let parsedJson = { sections: [] };
    try {
        parsedJson = JSON.parse(responseText);
    } catch (e) {
        console.error("Failed to parse GLB annotations. Raw output:", responseText);
        const match = responseText.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                parsedJson = JSON.parse(match[0]);
            } catch (e2) {
                console.error("Second parse attempt failed too:", e2.message);
                throw e; // Rethrow original to be caught by /api/generate-visual
            }
        } else {
            throw e;
        }
    }

    // Determine if the model relies heavily on generic mesh names
    let isGeneric = false;
    if (validMeshes.length > 0) {
        const genericKeywords = ['cylinder', 'sphere', 'cube', 'plane', 'object', 'mesh', 'group', 'node', 'null', 'lambert', 'blinn', 'phong', 'material', 'default', 'poly'];
        let genericCount = 0;
        validMeshes.forEach(m => {
            const lower = m.name.toLowerCase();
            if (genericKeywords.some(kw => lower.includes(kw)) || /^[\d\.\-_a-zA-Z]{1,3}$/.test(m.name)) {
                genericCount++;
            }
        });
        isGeneric = (genericCount / validMeshes.length) > 0.6;
    }

    parsedJson.is_generic = isGeneric;
    return parsedJson;
}

// Router Endpoint — supports any visual topic
app.post('/api/router', async (req, res) => {
    try {
        const { question, model } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question string is required' });
        }

        const prompt = `A student asked: "${question}".

Your job is to decide whether this question would benefit from a visual diagram or 3D model.

Respond with JSON only, no markdown, no backticks, just a raw JSON object with these fields:
{
  "type": "3D" | "2D" | "TEXT" | "SIMULATION",
  "topic": "<kebab-case-slug>" | null,
  "generated": true | false
}

Rules:
- Choose "SIMULATION" explicitly if the student asks about the "photoelectric effect" or requests a simulation/interactive tool for it. The topic MUST be exactly "photoelectric-effect".
- Choose "3D" for anatomical structures, organs, molecules, or physical objects that have depth and benefit from rotation (e.g. heart, brain, lungs, DNA, atom, solar-system, eye, kidney, tooth, skull).
- Choose "2D" for processes, cycles, flowcharts, systems, or diagrams (e.g. water-cycle, photosynthesis, cell-division, food-chain, digestive-system, nitrogen-cycle, carbon-cycle, blood-circulation, nervous-system-pathway, periodic-table, cell-structure, plant-cell, animal-cell).
- Choose "TEXT" for math problems, definitions, history questions, opinions, or anything that does NOT benefit from a visual.
- The "topic" should be a short kebab-case slug describing the subject (e.g. "human-heart", "plant-cell", "water-cycle", "photosynthesis", "dna-structure", "photoelectric-effect").
- Set "generated" to true whenever type is "3D" or "2D". Set to false when type is "TEXT" or "SIMULATION".
- Return ONLY the raw JSON object, nothing else.`;

        const responseText = await callGemini([
            { role: 'user', content: prompt }
        ], model || DEFAULT_MODEL, 256);

        let parsedJSON;
        try {
            const cleaned = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            parsedJSON = JSON.parse(cleaned);
        } catch (e) {
            console.error("Failed to parse router output as JSON:", responseText);
            parsedJSON = { type: 'TEXT', topic: null, generated: false };
        }

        // Ensure generated flag is consistent
        if (parsedJSON.type !== 'TEXT' && parsedJSON.topic) {
            parsedJSON.generated = true;
        } else {
            parsedJSON.generated = false;
        }

        res.json(parsedJSON);
    } catch (error) {
        console.error("Error calling Router API:", error.message);
        res.status(500).json({ type: 'TEXT', topic: null, generated: false });
    }
});

// Generate Visual Endpoint — with DB cache + vision-based image reference generation
app.post('/api/generate-visual', async (req, res) => {
    try {
        const { topic, model, visualType } = req.body;

        if (!topic) {
            return res.status(400).json({ error: 'Topic string is required' });
        }

        // STEP 1: Check database for cached model (skip old GLB/SVG_2D entries)
        const cached = getVisual.get(topic);
        if (cached) {
            const cachedData = JSON.parse(cached.data);
            // Only use cache for 3D/2D types that the frontend can render
            if (cachedData.model_type === '3D' || cachedData.model_type === '2D') {
                console.log(`✅ Loaded "${topic}" from database (source: ${cached.source || 'ai'})`);
                return res.json(cachedData);
            } else {
                console.log(`⏭️ Skipping cached "${topic}" (type: ${cachedData.model_type}) — regenerating as AI 3D/2D`);
            }
        }

        console.log(`🔄 Generating new visual for "${topic}" (type: ${visualType || 'auto'})...`);

        // NOTE: Sketchfab GLB pipeline disabled — frontend only supports AI-generated 3D/2D

        // NOTE: SVG_2D pipeline disabled — frontend only supports AI-generated JSON 3D/2D

        // STEP 3: Fallback — AI primitive generation with Wikimedia reference image
        console.log(`🎨 Falling back to AI generation for "${topic}"...`);
        const imageUrl = await fetchReferenceImage(topic);

        const systemPrompt = `You are an expert 3D modeler and scientific illustrator. You output ONLY valid JSON — never markdown, never backticks, never explanations. Your 3D models are built from Three.js primitives (spheres, cylinders, torus, cones, boxes) combined and positioned to form recognizable, anatomically accurate shapes. You always produce visually impressive, scientifically correct educational visualizations.`;

        const textPrompt = `Generate a detailed 3D or 2D visualization JSON for: "${topic}"

${imageUrl ? 'I have provided a REFERENCE IMAGE of this topic. Study it carefully — match the shape, structure, proportions and spatial layout you see in the image. Position your 3D primitives to approximate the real anatomy shown.' : ''}

DECISION: Use 3D for physical objects (organs, molecules, cells, structures). Use 2D for processes (cycles, flowcharts, pathways).

CRITICAL 3D RULES:
1. COMPONENTS MUST BE LARGE AND VISIBLE. Geometry radius 1-6 units for main parts. Never smaller than 0.3.
2. CAMERA at [0, 3, 14], FOV 50. All components within -6 to 6 range.
3. Use NON-UNIFORM SCALE to shape spheres into ovals/organic forms.
4. OVERLAP components where they connect anatomically. No floating disconnected parts.
5. Use EMISSIVE colors on every component (dimmer version of main color, intensity 0.3-0.5) for glow.
6. OUTER SHELL semi-transparent (opacity 0.25-0.4) so internals visible.
7. Scientifically correct colors: arteries=#dc143c, veins=#2563eb, bones=#f5f0e8, muscles=#a52a2a, nerves=#ffd700.

EXAMPLE of a well-made 3D heart (match this quality level):
{
  "model_type": "3D",
  "scene_config": {
    "background": "#0a0a14",
    "fog": { "enabled": true, "color": "#0a0a14", "near": 1, "far": 80 },
    "camera": { "fov": 50, "position": [0, 2, 14], "auto_rotate": true },
    "lighting": {
      "ambient": { "color": "#ffffff", "intensity": 0.5 },
      "directional": { "color": "#ffffff", "intensity": 1.2, "position": [8, 12, 8] },
      "point_lights": [
        { "color": "#ff6b6b", "intensity": 1.5, "distance": 30, "position": [-5, 0, 5] },
        { "color": "#4a90d9", "intensity": 1.0, "distance": 30, "position": [5, -3, 5] }
      ]
    }
  },
  "components": [
    { "mesh_name": "outer_wall", "name": "Heart Wall", "geometry": { "type": "SphereGeometry", "params": [4, 32, 32] }, "material": { "type": "MeshPhysicalMaterial", "color": "#8b2252", "roughness": 0.6, "metalness": 0.1, "transparent": true, "opacity": 0.3, "emissive": "#3d0f24", "emissive_intensity": 0.3, "wireframe": false }, "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.0, 1.15, 0.85], "animation": { "type": "pulse", "axis": "y", "speed": 1.2, "amplitude": 0.02 } },
    { "mesh_name": "left_ventricle", "name": "Left Ventricle", "geometry": { "type": "SphereGeometry", "params": [2.2, 32, 32] }, "material": { "type": "MeshPhysicalMaterial", "color": "#dc143c", "roughness": 0.4, "metalness": 0.1, "transparent": false, "opacity": 1.0, "emissive": "#5c0a1a", "emissive_intensity": 0.4, "wireframe": false }, "position": [-0.8, -1.2, 0], "rotation": [0, 0, 0], "scale": [0.8, 1.1, 0.75], "animation": { "type": "pulse", "axis": "y", "speed": 1.2, "amplitude": 0.03 } },
    { "mesh_name": "aorta", "name": "Aorta", "geometry": { "type": "TorusGeometry", "params": [2.0, 0.35, 16, 32, 3.14] }, "material": { "type": "MeshPhysicalMaterial", "color": "#dc143c", "roughness": 0.3, "metalness": 0.2, "transparent": false, "opacity": 1.0, "emissive": "#6e0a1e", "emissive_intensity": 0.5, "wireframe": false }, "position": [0, 3.5, 0], "rotation": [0, 0, 1.57], "scale": [1, 1, 1], "animation": { "type": "none", "axis": "y", "speed": 0, "amplitude": 0 } }
  ],
  "sections": [
    { "mesh_name": "outer_wall", "label": "Heart Wall", "short": "Muscular outer wall", "detail": "The myocardium contracts rhythmically to pump blood. The left side is thicker because it pumps blood to the entire body." },
    { "mesh_name": "left_ventricle", "label": "Left Ventricle", "short": "Pumps blood to body", "detail": "The strongest chamber. Pumps oxygenated blood through the aorta. Its walls are 3x thicker than the right ventricle." },
    { "mesh_name": "aorta", "label": "Aorta", "short": "Largest artery", "detail": "Arches upward from the left ventricle and curves down, distributing oxygenated blood to every organ." }
  ],
  "annotations": { "enabled": true },
  "particles": { "enabled": true, "count": 200, "color": "#ff4466", "size": 0.06, "spread": 30, "speed": 0.01, "direction": "random" }
}

Generate "${topic}" with 8-12 components, same quality. For 2D (processes/cycles):
{ "model_type": "2D", "canvas_config": { "width": 800, "height": 600, "viewBox": "0 0 800 600", "background": "#0a0a14" }, "style": { "line_style": "curved", "line_color": "#4488aa", "text_color": "#ffffff" }, "nodes": [...], "connections": [...], "sections": [...] }
For 2D: 6-10 nodes, spread across full canvas, 120+ px apart.

Return ONLY raw JSON.`;

        // Build messages — include image if found (multimodal / vision)
        const userContent = imageUrl
            ? [
                { type: 'text', text: textPrompt },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
            : textPrompt;

        let responseText = await callGemini([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ], VISION_MODEL, 8192);

        // Strip markdown code fences and thinking tags (gemini-2.5-flash is a thinking model)
        responseText = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        responseText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        // Also strip any non-JSON prefix text before the first {
        const firstBrace = responseText.indexOf('{');
        if (firstBrace > 0) {
            responseText = responseText.substring(firstBrace);
        }
        // Strip trailing text after the last }
        const lastBrace = responseText.lastIndexOf('}');
        if (lastBrace >= 0 && lastBrace < responseText.length - 1) {
            responseText = responseText.substring(0, lastBrace + 1);
        }

        let visualData;
        try {
            visualData = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse visual JSON (first 500 chars):", responseText.substring(0, 500));
            console.error("Parse error:", e.message);
            return res.status(500).json({ error: 'Failed to generate valid visual data' });
        }

        if (!visualData.model_type || !['3D', '2D'].includes(visualData.model_type)) {
            return res.status(500).json({ error: 'Invalid model_type in generated data' });
        }

        insertVisual.run(topic, visualData.model_type, JSON.stringify(visualData), imageUrl, null, 'ai');
        console.log(`💾 Stored "${topic}" in database (source: ai)`);

        res.json(visualData);
    } catch (error) {
        console.error("Error generating visual:");
        console.error(error.stack || error);
        res.status(500).json({ error: 'An error occurred while generating the visualization.', details: error.message });
    }
});

// Title Generator Endpoint
app.post('/api/title', async (req, res) => {
    try {
        const { question, model } = req.body;
        if (!question) return res.status(400).json({ title: 'New Conversation' });

        if (question.length < 30) {
            return res.json({ title: question });
        }

        const responseText = await callGemini([
            { role: 'user', content: `Summarise this student question in 3-4 words maximum, title case, no punctuation: ${question}` }
        ], model || DEFAULT_MODEL, 64);

        let title = responseText.trim().replace(/["']/g, '').replace(/[.,!?]$/, '');
        res.json({ title: title || 'New Conversation' });
    } catch (error) {
        console.error("Error generating title:", error.message);
        res.json({ title: req.body.question?.substring(0, 30) + '...' || 'New Conversation' });
    }
});

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, model } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array is required' });
        }

        // OpenRouter uses OpenAI format: { role: 'user'|'assistant'|'system', content: '...' }
        const formattedMessages = [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            ...messages.map(msg => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            }))
        ];

        const responseText = await callGemini(formattedMessages, model || DEFAULT_MODEL, 8192);
        res.json({ response: responseText });
    } catch (error) {
        console.error("Error calling Chat API:", error.message);
        res.status(500).json({ error: error.message || 'An error occurred while generating a response.' });
    }
});

// Summary Endpoint
app.post('/api/summary', async (req, res) => {
    try {
        const { currentSummary, newExchange, model } = req.body;

        if (!newExchange || !newExchange.user || !newExchange.assistant) {
            return res.status(400).json({ error: 'newExchange with user and assistant text is required' });
        }

        const prompt = `You are an AI maintaining a running summary of an educational conversation between a student and a tutor.
Current summary: ${currentSummary ? currentSummary : "No conversation yet."}

New exchange just added:
Student: ${newExchange.user}
Tutor: ${newExchange.assistant}

Please provide an updated, concise running summary that incorporates the new information discussed. Keep it brief but comprehensive enough to generate a quiz from later. Respond ONLY with the raw summary text.`;

        const responseText = await callGemini([
            { role: 'user', content: prompt }
        ], model || DEFAULT_MODEL, 512);

        res.json({ summary: responseText.trim() });
    } catch (error) {
        console.error("Error generating summary:", error.message);
        res.status(500).json({ summary: req.body.currentSummary || "Failed to generate summary." });
    }
});

// Quiz Endpoint
app.post('/api/quiz', async (req, res) => {
    try {
        const { summary, model } = req.body;

        if (!summary) {
            return res.status(400).json({ error: 'Summary string is required' });
        }

        const prompt = `Based on the following conversation summary between a student and a tutor, generate a 3-question multiple choice quiz to test the student's understanding of the topics discussed.

Summary: ${summary}

Return the quiz STRICTLY as a raw JSON array of objects, with NO markdown formatting, NO backticks, and NO extra text. Each object in the array must have exactly:
- "question": a clear string
- "options": an array of exactly 4 strings
- "correctAnswer": a string matching exactly one of the options.`;

        let responseText = await callGemini([
            { role: 'user', content: prompt }
        ], model || DEFAULT_MODEL, 1024);

        // Extract the JSON array
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            responseText = jsonMatch[0];
        }

        let quizData;
        try {
            quizData = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse quiz JSON:", responseText);
            return res.status(500).json({ error: 'Failed to parse AI response as JSON' });
        }

        res.json(quizData);
    } catch (error) {
        console.error("Error generating quiz:", error.message);
        res.status(500).json({ error: 'An error occurred while generating the quiz.' });
    }
});

// Start the server
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Imagion AI Tutor is running at http://localhost:${port}`);
    console.log(`Local Access: http://127.0.0.1:${port}`);
});
