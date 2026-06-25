import { describe, it, expect } from 'vitest';
import { redactSensitive, safeFlowProjection } from '../lib/log-redact.js';

describe('redactSensitive', () => {
  it('redacts top-level sensitive keys', () => {
    const result = redactSensitive({ passphrase: 'secret', name: 'test' });
    expect(result).toEqual({ passphrase: '[REDACTED]', name: 'test' });
  });

  it('redacts nested sensitive keys', () => {
    const result = redactSensitive({ source: { srt_uri: 'srt://host?passphrase=s3cr3t', name: 'cam' } });
    expect((result as Record<string, Record<string, unknown>>)['source']?.['srt_uri']).toBe('[REDACTED]');
    expect((result as Record<string, Record<string, unknown>>)['source']?.['name']).toBe('cam');
  });

  it('redacts token, secret, authorization, and pat keys', () => {
    const input = { token: 'abc', secret: 'xyz', authorization: 'Bearer foo', pat: 'pat_123', streamid: 'sid' };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result['token']).toBe('[REDACTED]');
    expect(result['secret']).toBe('[REDACTED]');
    expect(result['authorization']).toBe('[REDACTED]');
    expect(result['pat']).toBe('[REDACTED]');
    expect(result['streamid']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive keys unchanged', () => {
    const input = { id: '123', name: 'source', streamType: 'srt', status: 'active' };
    expect(redactSensitive(input)).toEqual(input);
  });

  it('handles arrays by redacting sensitive keys within each element', () => {
    const input = [{ passphrase: 'secret' }, { name: 'ok' }];
    const result = redactSensitive(input) as Array<Record<string, unknown>>;
    expect(result[0]?.['passphrase']).toBe('[REDACTED]');
    expect(result[1]?.['name']).toBe('ok');
  });

  it('returns primitives unchanged', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  it('does not leak plaintext passphrase in output', () => {
    const srtAddress = 'srt://live.example.com:9000?passphrase=MySuperSecret&streamid=cam1';
    const result = redactSensitive({ address: srtAddress, name: 'main-cam' });
    expect(JSON.stringify(result)).not.toContain('MySuperSecret');
  });
});

describe('safeFlowProjection', () => {
  it('returns block/element/link counts and IDs only — no properties', () => {
    const flow = {
      blocks: [
        { id: 'b1', block_definition_id: 'builtin.mixer', properties: { passphrase: 'secret' } },
        { id: 'b2', block_definition_id: 'builtin.cefsrc', properties: { url: 'srt://host?passphrase=x' } },
      ],
      elements: [
        { id: 'e1', element_type: 'identity', properties: { key: 'sensitive' } },
      ],
      links: [{ id: 'l1' }, { id: 'l2' }],
    };
    const result = safeFlowProjection(flow as Record<string, unknown>) as Record<string, unknown>;

    expect(result['blockCount']).toBe(2);
    expect(result['elementCount']).toBe(1);
    expect(result['linkCount']).toBe(2);

    const blocks = result['blocks'] as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ id: 'b1', block_definition_id: 'builtin.mixer' });
    expect(blocks[1]).toEqual({ id: 'b2', block_definition_id: 'builtin.cefsrc' });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('passphrase');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('properties');
  });

  it('handles flows without elements or links gracefully', () => {
    const flow = { blocks: [{ id: 'b1', block_definition_id: 'builtin.mixer' }] };
    const result = safeFlowProjection(flow as Record<string, unknown>) as Record<string, unknown>;
    expect(result['blockCount']).toBe(1);
    expect(result['elementCount']).toBe(0);
    expect(result['linkCount']).toBe(0);
  });
});
