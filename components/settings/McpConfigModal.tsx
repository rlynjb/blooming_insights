'use client';

import { useEffect, useState } from 'react';
import type { McpAuthType } from '@/lib/mcp/auth-providers';
import {
  readPersistedConfig,
  writePersistedConfig,
  type McpConfigOverride,
} from '@/lib/mcp/config';

/**
 * MCP config modal (Session D of the synthetic-first plan). Lets a visitor
 * override the server-side env-driven MCP config from their browser without
 * changing env or forking.
 *
 * Persistence: writes to localStorage['bi:mcp_config'] via
 * `writePersistedConfig`. On next page load / next fetch, the streaming hooks
 * (useBriefingStream, useInvestigation) attach the config as a header on the
 * fetch call; the route decodes it and hands the override to makeDataSource.
 *
 * Trust boundaries — surfaced in the UI:
 *   · MCP URL     you must trust; the target sees every tool call
 *   · Bearer      stored in localStorage; not encrypted (unlike bi_auth)
 *   · OAuth       uses the existing bi_auth cookie discipline (AES-256-GCM)
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after a Save / Reset succeeds so the parent can reload the stream. */
  onSaved?: () => void;
}

export function McpConfigModal({ open, onClose, onSaved }: Props) {
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<McpAuthType>('oauth-bloomreach');
  const [bearerToken, setBearerToken] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Load persisted config on open.
  useEffect(() => {
    if (!open) return;
    const c = readPersistedConfig();
    setUrl(c?.url ?? '');
    setAuthType(c?.authType ?? 'oauth-bloomreach');
    setBearerToken(c?.bearerToken ?? '');
    setInitialized(true);
  }, [open]);

  if (!open) return null;

  const save = () => {
    const config: McpConfigOverride = {
      url: url.trim() || undefined,
      authType,
      bearerToken: authType === 'bearer' ? bearerToken.trim() || undefined : undefined,
    };
    // Bearer-selected but no token → don't save; the UI shows the warning.
    if (authType === 'bearer' && !config.bearerToken) return;
    writePersistedConfig(config);
    onSaved?.();
    onClose();
  };

  const reset = () => {
    writePersistedConfig(null);
    onSaved?.();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-config-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #1a1a1a)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          width: 'min(560px, 100%)',
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          padding: 24,
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.85rem',
        }}
      >
        <h2
          id="mcp-config-title"
          className="lowercase"
          style={{
            fontFamily: 'var(--font-display), system-ui, sans-serif',
            fontSize: '1.25rem',
            marginBottom: 4,
          }}
        >
          mcp settings
        </h2>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', marginBottom: 20 }}>
          override server env config from your browser. persisted in localStorage;
          overrides env on the next request.
        </p>

        {/* URL */}
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
            mcp url
          </div>
          <input
            type="url"
            placeholder="https://your-mcp-server.example.com/mcp/"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.78rem',
            }}
          />
          <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)', marginTop: 4 }}>
            leave blank to use MCP_URL env (defaults to bloomreach alpha).
          </div>
        </label>

        {/* Auth type */}
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
            auth type
          </div>
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value as McpAuthType)}
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.78rem',
            }}
          >
            <option value="oauth-bloomreach">oauth-bloomreach (default)</option>
            <option value="bearer">bearer</option>
            <option value="anonymous">anonymous</option>
          </select>
        </label>

        {/* Bearer token (conditional) */}
        {authType === 'bearer' && (
          <label style={{ display: 'block', marginBottom: 16 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
              bearer token
            </div>
            <input
              type="password"
              placeholder="paste token"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.78rem',
              }}
            />
            <div
              style={{
                fontSize: '0.66rem',
                color: 'var(--accent-amber, #d99a3a)',
                marginTop: 6,
                lineHeight: 1.4,
              }}
            >
              ⚠ tokens in localStorage are less protected than the encrypted
              bi_auth cookie. use test tokens; do not paste production
              credentials.
            </div>
          </label>
        )}

        {/* Warnings */}
        <div
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 12,
            marginBottom: 20,
            fontSize: '0.7rem',
            lineHeight: 1.5,
            color: 'var(--text-tertiary)',
          }}
        >
          <div>
            ⚠ only enter mcp server urls you trust — the server sees every tool
            call the agent makes on your behalf.
          </div>
          {authType === 'oauth-bloomreach' && (
            <div style={{ marginTop: 6 }}>
              ✓ oauth tokens stored in an AES-256-GCM encrypted HttpOnly
              SameSite=None cookie (bi_auth). same discipline as today.
            </div>
          )}
          {authType === 'anonymous' && (
            <div style={{ marginTop: 6 }}>
              anonymous mode sends no Authorization header. best for local dev
              mcp servers.
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={reset}
            className="lowercase"
            style={{
              background: 'transparent',
              color: 'var(--text-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.72rem',
            }}
          >
            reset to defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="lowercase"
            style={{
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.72rem',
            }}
          >
            cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={authType === 'bearer' && !bearerToken.trim()}
            className="lowercase"
            style={{
              background: 'var(--accent-teal)',
              color: 'var(--bg-base)',
              border: 'none',
              borderRadius: 4,
              padding: '6px 14px',
              cursor:
                authType === 'bearer' && !bearerToken.trim() ? 'not-allowed' : 'pointer',
              opacity: authType === 'bearer' && !bearerToken.trim() ? 0.5 : 1,
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.72rem',
            }}
          >
            save
          </button>
        </div>

        {!initialized && (
          <div style={{ marginTop: 8, fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>
            loading…
          </div>
        )}
      </div>
    </div>
  );
}
