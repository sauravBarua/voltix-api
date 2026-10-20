type Stoppable = { stop: () => Promise<unknown> };

export default async function globalTeardown() {
  const containers =
    (globalThis as unknown as { __voltixContainers?: Stoppable[] }).__voltixContainers ?? [];
  await Promise.all(containers.map((c) => c.stop()));
}
