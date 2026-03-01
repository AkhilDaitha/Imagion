const { NodeIO } = require('@gltf-transform/core');
const { bounds } = require('@gltf-transform/functions');
const path = require('path');

async function test() {
    try {
        const io = new NodeIO();
        const doc = await io.read(path.join(__dirname, 'public', 'models', 'human-kidney.glb'));
        const docBounds = bounds(doc.getRoot().listScenes()[0]);
        console.log('Doc bounds:', docBounds);

        for (const node of doc.getRoot().listNodes()) {
            if (node.getName()) {
                const b = bounds(node);
                if (b.min[0] !== Infinity) {
                    const center = [
                        (b.min[0] + b.max[0]) / 2,
                        (b.min[1] + b.max[1]) / 2,
                        (b.min[2] + b.max[2]) / 2
                    ];
                    console.log(`Node: ${node.getName()} -> center:`, center);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
}
test();
