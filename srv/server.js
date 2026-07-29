const cds = require('@sap/cds');

/**
 * CF-managed PostgreSQL (SAP "PostgreSQL, hyperscaler option") ships its TLS
 * material in the service binding as sslrootcert / sslcert / sslkey. Some
 * versions of @cap-js/postgres do not map these into node-postgres' expected
 * ssl.{ca,cert,key} shape, so the TLS (or mutual-TLS) handshake is rejected and
 * the server resets the socket (ECONNRESET).
 *
 * This hook copies whatever cert material the binding provides into ssl.*.
 * It only runs when that material is present, so local setups (e.g. Neon via
 * .env, which use plain ssl:true) are left completely untouched.
 */
cds.on('served', () => {
  const creds = cds.db && cds.db.options && cds.db.options.credentials;
  if (!creds) return;

  // Nothing to do unless the binding actually carries CF-style TLS material.
  if (!creds.sslrootcert && !creds.sslcert) return;

  const ssl = { rejectUnauthorized: true };
  if (creds.sslrootcert) ssl.ca = creds.sslrootcert;   // server CA
  if (creds.sslcert)     ssl.cert = creds.sslcert;     // client cert (mTLS)
  if (creds.sslkey)      ssl.key = creds.sslkey;       // client key  (mTLS)

  creds.ssl = ssl;
  cds.log('db').info('applied CF PostgreSQL TLS material to ssl.{ca,cert,key}');
});

module.exports = cds.server;
