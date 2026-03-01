require('dotenv').config();
async function test() {
    const url = `https://api.sketchfab.com/v3/search?type=models&q=kidney&downloadable=true&has_annotations=true&sort_by=-likeCount`;
    console.log('Fetching', url);
    const res = await fetch(url, {
        headers: { 'Authorization': `Token ${process.env.SKETCHFAB_API_TOKEN}` }
    });
    const data = await res.json();

    if (data.results && data.results.length > 0) {
        let found = false;
        for (const model of data.results) {
            console.log(`Model: ${model.name} (uid: ${model.uid})`);
            const annUrl = `https://api.sketchfab.com/v3/models/${model.uid}/annotations`;
            const annRes = await fetch(annUrl, {
                headers: { 'Authorization': `Token ${process.env.SKETCHFAB_API_TOKEN}` }
            });
            if (annRes.ok) {
                const annData = await annRes.json();
                console.log(`  Annotations: ${annData.results ? annData.results.length : 0}`);
                if (annData.results && annData.results.length > 0) {
                    console.log(`  Sample: ${annData.results[0].name} at ${JSON.stringify(annData.results[0].position)}`);
                    found = true;
                    break;
                }
            } else {
                console.log(`  Failed to fetch annotations: ${annRes.status}`);
            }
        }
    } else {
        console.log("No annotated models found.");
    }
}
test();
