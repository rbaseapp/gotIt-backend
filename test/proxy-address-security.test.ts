import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const proxyAddress = createRequire(import.meta.url)('proxy-addr') as {
  compile: (subnet: string) => (address: string) => boolean;
};

test('short IPv4-mapped IPv6 trust prefixes cannot trust arbitrary IPv4 clients', () => {
  const trust = proxyAddress.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.12'), false);
  assert.equal(trust('10.0.0.1'), false);
  assert.equal(proxyAddress.compile('::/1')('203.0.113.12'), false);
});

test('normal IPv4 and fully qualified mapped subnets preserve the intended trust range', () => {
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyAddress.compile(subnet);
    assert.equal(trust('10.2.3.4'), true);
    assert.equal(trust('203.0.113.12'), false);
  }
});
