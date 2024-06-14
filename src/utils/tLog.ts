import { type Awaitable } from "../types/Awaitable";

export async function tLog<T>(msg: string, fn: () => Awaitable<T[]>) {
  const r = await fn();
  console.log(`[Task] ${msg} done (count: ${r.length})`);
  return r;
}