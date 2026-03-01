const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Setup headless DOM
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.XMLHttpRequest = dom.window.XMLHttpRequest;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;

const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

async function test() {
    const loader = new GLTFLoader();
    const filePath = path.join(__dirname, 'public', 'models', 'human-kidney.glb');
    
    // Read file manually
    const buffer = fs.readFileSync(filePath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

    loader.parse(arrayBuffer, '', (gltf) => {
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);

        const meshes = [];
        scene.traverse((child) => {
            if (child.isMesh) {
                child.geometry.computeBoundingBox();
                const box = child.geometry.boundingBox.clone();
                box.applyMatrix4(child.matrixWorld);
                
                const center = new THREE.Vector3();
                box.getCenter(center);
                
                meshes.push({
                    name: child.name,
                    center: [center.x, center.y, center.z]
                });
            }
        });
        console.log(JSON.stringify(meshes, null, 2));
    }, (error) => {
        console.error("Error parsing GLB:", error);
    });
}
test();
