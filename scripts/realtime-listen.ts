import { io } from 'socket.io-client';

// pnpm realtime:listen [email] [password]   (defaults: the seeded admin)
const [email = 'admin@voltix.test', password = process.env.SEED_PASSWORD ?? 'Voltix-Dev-1234!'] =
  process.argv.slice(2);
const base = process.env.API_URL ?? 'http://localhost:3000';

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const socket = io(`${base}/realtime`, {
  transports: ['websocket'], // no sticky sessions needed behind a load balancer
  // Called on every (re)connection: a reconnect after token expiry therefore gets a fresh token
  auth: (callback) => {
    login().then(
      (token) => callback({ token }),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      },
    );
  },
});

socket.on('connect', () => console.log(`connected as ${email}`));
socket.on('connect_error', (error) => console.error('connect_error:', error.message));
socket.on('disconnect', (reason) => {
  console.log('disconnected:', reason);
  // The server ends the session when the access token expires; the client must reconnect itself
  if (reason === 'io server disconnect') socket.connect();
});
socket.onAny((name: string, data: unknown) =>
  console.log(new Date().toISOString(), name, JSON.stringify(data)),
);
