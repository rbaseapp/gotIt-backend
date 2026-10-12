// Local, read-only visual fixtures. No provider calls, credentials or database access.
import http from 'node:http';
import { resolve } from 'node:path';
import sharp from 'sharp';
if (!process.argv[2]) throw new Error('Pass the frontend docs/programs-dev/preview directory');
const root = resolve(process.argv[2]);
const files = new Set(['mascot-es', 'work', 'travel', 'books', 'conversation']);
const cache = new Map();
http
  .createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5187');
    const file = req.url?.slice(1);
    if (!files.has(file)) {
      res.writeHead(404);
      return res.end();
    }
    try {
      if (!cache.has(file)) {
        const pipeline = sharp(resolve(root, `${file}.png`));
        const bytes = await (
          file === 'mascot-es'
            ? pipeline
                .trim()
                .resize({ width: 1200, height: 400, fit: 'contain', background: '#00000000' })
            : pipeline.resize(900, 600)
        )
          .webp({ quality: 82 })
          .toBuffer();
        cache.set(file, `data:image/webp;base64,${bytes.toString('base64')}`);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ dataUrl: cache.get(file) }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  })
  .listen(3021, '127.0.0.1', () =>
    console.log('Read-only artwork fixture server listening on 3021'),
  );
