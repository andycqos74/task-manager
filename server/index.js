import { createApp } from './src/app.js';

const PORT = process.env.PORT || 3001;

createApp().listen(PORT, () => {
  console.log(`Task manager API listening on http://localhost:${PORT}`);
});
