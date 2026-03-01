async function test() {
    console.log("Triggering /api/generate-visual for 'animal-cell' (2D)...");
    try {
        const res = await fetch('http://127.0.0.1:3000/api/generate-visual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic: 'animal-cell', visualType: '2D' })
        });

        console.log("Status:", res.status);
        const text = await res.text();
        console.log("Response:", text.substring(0, 500));
    } catch (e) {
        console.error("HTTP Error:", e);
    }
}

test();
