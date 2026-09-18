// Builds the express app. Kept separate from index.js so tests can drive the
// real app in-process — including its middleware — rather than assembling a
// partial copy of it and testing something the server never runs.
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes.js';
import { attachScope } from './scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ serveClient = true } = {}) {
  const app = express();

  // NOTE FOR PHASE 1: this allows every origin. It is harmless while the API
  // has no credentials to steal and the UI is served same-origin, but it must
  // go before cookie sessions land.
  app.use(cors());
  app.use(express.json());

  // Resolve who/what this request may touch before any handler runs.
  app.use('/api', attachScope, router);

  // Serve the built frontend in production (npm run build first).
  const dist = path.join(here, '..', '..', 'client', 'dist');
  if (serveClient && fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
