import { bootstrap, createApp } from './src/app.js';
import { startDigestScheduler } from './src/push.js';

const PORT = process.env.PORT || 3001;

bootstrap();
startDigestScheduler();
createApp().listen(PORT, () => {
  console.log(`Task manager API listening on http://localhost:${PORT}`);
});
