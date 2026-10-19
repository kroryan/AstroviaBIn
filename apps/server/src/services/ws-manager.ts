import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { isAuthenticatedUpgrade } from './auth';

export class WsManager {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: ({ req }: { req: import('http').IncomingMessage }, done: (allowed: boolean, code?: number) => void) => {
        isAuthenticatedUpgrade(req).then(allowed => done(allowed, allowed ? undefined : 401), () => done(false, 401));
      },
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`WebSocket client connected (${this.clients.size} total)`);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`WebSocket client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('WebSocket client error:', err);
        this.clients.delete(ws);
      });
    });
  }

  broadcast(event: string, data: unknown) {
    const message = JSON.stringify({ event, data });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
