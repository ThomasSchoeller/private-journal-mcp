// ABOUTME: Shared test helpers — JSON-RPC over the MCP endpoint, and UI request plumbing
// ABOUTME: Everything goes through SELF.fetch so tests exercise real routing and auth

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';

export const ORIGIN = 'https://journal.example.com';
/** First revision of the modern, per-request-envelope era. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
// Long enough to clear MIN_SECRET_LENGTH, which the token parser enforces.
export const LAPTOP_TOKEN = 'laptop-secret-tttttttttttt';
export const WEB_TOKEN = 'web-secret-tttttttttttttttt';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;

/** One modern-era (per-request envelope) JSON-RPC call against `/mcp`. */
export async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: { token?: string | null; raw?: boolean } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // The modern era mirrors the method — and any params.name — into headers.
    'mcp-method': method,
  };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? LAPTOP_TOKEN}`;
  }

  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'journal-tests', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
          ...((params._meta as Record<string, unknown>) ?? {}),
        },
      },
    }),
  });
}

/** Reads a JSON-RPC response, transparently unwrapping an SSE-framed one. */
export async function readJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const line = body
      .split('\n')
      .filter((entry) => entry.startsWith('data:'))
      .map((entry) => entry.slice(5).trim())
      .find((entry) => entry.length > 0);
    if (!line) throw new Error(`No SSE data frame in response: ${body}`);
    return JSON.parse(line) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: { token?: string } = {}
): Promise<{ text: string; isError: boolean }> {
  const response = await mcpRequest('tools/call', { name, arguments: args }, options);
  expect(response.status).toBe(200);
  const message = await readJsonRpc(response);
  if (message.error) return { text: message.error.message, isError: true };

  const content = (message.result?.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    text: content.map((block) => block.text ?? '').join(''),
    isError: message.result?.isError === true,
  };
}

/** Signs in through the real login form and returns the session cookie. */
export async function login(token = LAPTOP_TOKEN): Promise<string> {
  const page = await SELF.fetch(`${ORIGIN}/login`);
  const setCookie = page.headers.get('set-cookie') ?? '';
  const csrf = extractCsrf(await page.text());

  const body = new URLSearchParams({ csrf_token: csrf, token });
  const response = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { cookie: cookieHeader(setCookie), 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  return cookieHeader(response.headers.get('set-cookie') ?? '');
}

export function extractCsrf(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('No CSRF token in page');
  return match[1].replace(/&amp;/g, '&');
}

/** Turns a `Set-Cookie` value into the `Cookie` header a follow-up request sends. */
export function cookieHeader(setCookie: string): string {
  return setCookie
    .split(/,(?=\s*__Host-)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter((cookie) => cookie.length > 0 && !cookie.endsWith('='))
    .join('; ');
}

export function mergeCookies(...values: string[]): string {
  const jar = new Map<string, string>();
  for (const value of values) {
    for (const cookie of value.split(';')) {
      const separator = cookie.indexOf('=');
      if (separator <= 0) continue;
      jar.set(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
