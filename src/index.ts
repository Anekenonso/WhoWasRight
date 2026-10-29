/**
 * WhoWasRight Web Server Entrypoint
 */

import { createWebServer } from './web/server.ts';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const server = createWebServer();

server.listen(PORT, () => {
  console.log('============================================================');
  console.log(`WhoWasRight Mobile-First Web Server running on port ${PORT}`);
  console.log(`Access the UI at: http://localhost:${PORT}`);
  console.log('============================================================');
});
