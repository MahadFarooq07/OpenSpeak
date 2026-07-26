'use strict';

/** Thin fetch wrapper: timeouts, JSON parsing, and readable vendor errors. */

class ProviderError extends Error {
  constructor(message, { status = 0, provider = '', retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
  }
}

function trimBase(url, fallback) {
  const v = String(url || '').trim() || fallback;
  return v.replace(/\/+$/, '');
}

async function request(url, options = {}, { timeoutMs = 60000, provider = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ProviderError(`${provider || 'Request'} timed out after ${Math.round(timeoutMs / 1000)}s.`, {
        provider,
        retryable: true
      });
    }
    throw new ProviderError(
      `Could not reach ${provider || 'the API'}: ${err.message}. Check your connection or base URL.`,
      { provider, retryable: true }
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = null;
  }

  if (!res.ok) {
    const detail =
      (body && (body.error?.message || body.message || body.error)) ||
      text.slice(0, 300) ||
      res.statusText;
    throw new ProviderError(friendly(res.status, String(detail), provider), {
      status: res.status,
      provider,
      retryable: res.status === 429 || res.status >= 500
    });
  }

  return body ?? {};
}

function friendly(status, detail, provider) {
  const p = provider || 'The provider';
  if (status === 401 || status === 403) {
    return `${p} rejected the API key (${status}). Check it in Settings.`;
  }
  if (status === 404) {
    return `${p} returned 404 — the model name or base URL is probably wrong. ${detail}`;
  }
  if (status === 429) {
    return `${p} rate-limited the request. Wait a moment and try again.`;
  }
  if (status >= 500) {
    return `${p} had a server error (${status}). Try again shortly.`;
  }
  return `${p} error ${status}: ${detail}`;
}

module.exports = { request, ProviderError, trimBase };
