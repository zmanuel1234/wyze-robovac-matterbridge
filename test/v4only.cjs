// Test-only: makes Matter's mDNS use IPv4, for CI machines without usable IPv6 multicast.
// Loaded before matter.js by test/matter.test.mjs. Never part of the plugin package.
const dgram = require('dgram');
const orig = dgram.createSocket;
dgram.createSocket = function (opts, cb) {
  if (typeof opts === 'string') opts = { type: opts };
  if (opts && opts.type === 'udp6') opts = { ...opts, type: 'udp4', ipv6Only: undefined };
  const s = orig.call(this, opts, cb);
  const bind = s.bind.bind(s);
  s.bind = function (...a) {
    if (a[0] && typeof a[0] === 'object' && /:/.test(a[0].address || '')) a[0] = { ...a[0], address: '0.0.0.0' };
    else if (typeof a[1] === 'string' && a[1].includes(':')) a[1] = '0.0.0.0';
    return bind(...a);
  };
  for (const m of ['addMembership', 'setMulticastInterface', 'dropMembership']) { const f = s[m]; if (f) s[m] = function (...a) { try { return f.apply(s, a); } catch { return undefined; } }; }
  const send = s.send.bind(s);
  s.send = function (...a) { const cbk = a.find((x) => typeof x === 'function'); const host = a.find((x, i) => i > 0 && typeof x === 'string'); if (host && host.includes(':')) { if (cbk) cbk(); return; } return send(...a); };
  return s;
};

// Make 'import { createSocket } from "dgram"' in ES modules see the patched function too.
require('module').syncBuiltinESMExports();
