require('dotenv').config();
async function test() {
    const uid = 'd199ed6cab8848cb984215defa157d54';
    const url = `https://api.sketchfab.com/v3/models/${uid}/annotations`;
    console.log('Fetching', url);
    const res = await fetch(url, {
        headers: { 'Authorization': `Token ${process.env.SKETCHFAB_API_TOKEN}` }
    });
    if (!res.ok) {
        console.error('Failed', res.status);
        console.log(await res.text());
        return;
    }
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}
test();
