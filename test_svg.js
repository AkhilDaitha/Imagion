require('dotenv').config();
const { callOpenRouter } = require('./server');

async function testSVG() {
    const prompt = `You are an expert scientific illustrator. Draw a clean, beautifully stylized 2D diagram of a "Plant Cell" using SVG.
    
REQUIREMENTS:
1. Output valid JSON only.
2. The "svg" field must contain the raw <svg> string. Use viewBox="0 0 800 600".
3. Use clean vector shapes (rects, circles, paths).
4. DO NOT add any <text> tags. The diagram must be completely unlabeled visually.
5. In the "hotspots" array, map the key scientific parts to EXACT [x, y] coordinates (in the 0-800, 0-600 viewBox range) that correspond to the visual center of that part in your SVG.

JSON FORMAT:
{
  "title": "Plant Cell",
  "svg": "<svg viewBox=\\"0 0 800 600\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>",
  "hotspots": [
    {
      "id": "nucleus",
      "label": "Nucleus",
      "x": 400,
      "y": 300,
      "short": "Control center",
      "detail": "Stores DNA."
    }
  ]
}`;

    console.log('Asking AI to draw a plant cell SVG...');
    let res = await callOpenRouter([{ role: 'user', content: prompt }], 'anthropic/claude-3-5-sonnet-20241022', 4096);
    res = res.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    try {
        const data = JSON.parse(res);
        console.log(`Success! Generated SVG length: ${data.svg.length}`);
        console.log(`Hotspots: ${data.hotspots.length}`);
        console.log(data.hotspots.map(h => `${h.label} @ [${h.x}, ${h.y}]`).join('\n'));
    } catch (e) {
        console.error('Failed to parse JSON:', e);
        console.log(res);
    }
}

testSVG();
